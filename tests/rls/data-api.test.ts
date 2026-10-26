import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { anonClient, userClient } from "../helpers/clients";
import { closePool, sql } from "../helpers/db";
import { env } from "../helpers/env";
import {
  createFixtureOrg,
  createFixtureUser,
  insertLease,
  insertTenant,
  insertUnit,
  type FixtureLease,
  type FixtureOrg,
} from "../helpers/fixtures";
import { signIn, type Session } from "../helpers/seeded";

// R42 Data API matrix, exercised through PostgREST with the publishable key + real user JWTs
// (exactly what a grader's supabase-js would do). Expected row sets are computed independently
// with pg as postgres from the matrix in SPEC.md, and compared as exact sets, so both a leak
// (extra row) and an over-tight policy (missing row) fail. Writes are checked twice: PostgREST
// must refuse (error, or zero rows affected), AND the row is byte-identical afterwards (pg).

const TABLES = [
  "organizations",
  "memberships",
  "units",
  "tenants",
  "leases",
  "invoices",
  "payments",
  "payment_allocations",
  "gateway_bills",
  "audit_log",
] as const;
type Table = (typeof TABLES)[number];

const MONEY_FUNCTIONS = [
  "allocate_payment",
  "apply_gateway_callback",
  "approve_payment",
  "create_gateway_bill",
  "lock_payment_for_manager",
  "record_payment",
  "reject_payment",
  "void_payment",
];
const RLS_HELPERS = ["is_org_member", "is_lease_tenant", "is_tenant_org", "can_upload_slip"];

type Grant = { kind: "member"; orgId: string; role: "manager" | "staff" } | { kind: "tenant"; tenantId: string; orgId: string };
interface Actor {
  name: string;
  client: SupabaseClient;
  userId: string | null;
  grants: Grant[]; // empty = anon / nothing
}

const LEASE = { startDate: "2026-01-01", endDate: "2026-06-30", monthlyRentSen: 100000, depositSen: 200000 };
const AS_OF = "2026-03-15T12:00:00+08:00";

let A: FixtureOrg;
let B: FixtureOrg;
let LA1: FixtureLease; // org A, tenant A
let LA2: FixtureLease; // org A, tenant B (same org, other tenant)
let LB1: FixtureLease; // org B, its tenant A
let dual: Session; // staff in org B AND tenant in org A
let dualTenantId: string;
let LDual: FixtureLease;
let approvedLA1: string;
let pendingLA1: string;
let actors: Record<string, Actor>;

async function seedMoney(lease: FixtureLease, org: FixtureOrg, tenantUserId: string): Promise<{ approved: string; pending: string }> {
  // Real rows from the private money functions (README: never hand-insert payments).
  const [a] = await sql<{ id: string }>(
    "select id from private.record_payment($1, $2, 250000, 'cash', '2026-01-05T10:00:00+08:00'::timestamptz, null, null)",
    [org.users.manager.userId, lease.id],
  );
  const [p] = await sql<{ id: string }>(
    "select id from private.record_payment($1, $2, 1000, 'cash', '2026-01-06T10:00:00+08:00'::timestamptz, null, null)",
    [org.users.staff.userId, lease.id],
  );
  await sql("select * from private.create_gateway_bill($1, $2, $3::timestamptz)", [tenantUserId, lease.id, AS_OF]);
  return { approved: a.id, pending: p.id };
}

/** The ids a grant may see in a table, straight from the SPEC matrix, computed as postgres. */
async function idsFor(table: Table, g: Grant): Promise<string[]> {
  let q: string;
  let p: unknown[];
  if (g.kind === "member") {
    p = [g.orgId];
    if (table === "organizations") q = "select id::text as id from public.organizations where id = $1";
    else if (table === "audit_log") {
      if (g.role !== "manager") return [];
      q = "select id::text as id from public.audit_log where org_id = $1";
    } else q = `select id::text as id from public.${table} where org_id = $1`;
  } else {
    p = [g.tenantId];
    const ownLeases = "select id from public.leases where tenant_id = $1";
    switch (table) {
      case "organizations":
        q = "select org_id::text as id from public.tenants where id = $1";
        break;
      case "memberships":
      case "audit_log":
        return [];
      case "units":
        q = "select distinct unit_id::text as id from public.leases where tenant_id = $1";
        break;
      case "tenants":
        q = "select id::text as id from public.tenants where id = $1";
        break;
      case "leases":
        q = `select id::text as id from public.leases where tenant_id = $1`;
        break;
      default:
        q = `select id::text as id from public.${table} where lease_id in (${ownLeases})`;
    }
  }
  return (await sql<{ id: string }>(q, p)).map((r) => r.id);
}

async function expectedIds(table: Table, actor: Actor): Promise<string[]> {
  const all = new Set<string>();
  for (const g of actor.grants) for (const id of await idsFor(table, g)) all.add(id);
  return [...all].sort();
}

async function visibleIds(table: Table, actor: Actor): Promise<{ ids: string[]; error: string | null }> {
  const { data, error } = await actor.client.from(table).select("id");
  if (error) return { ids: [], error: error.code ?? error.message };
  return { ids: (data as { id: string | number }[]).map((r) => String(r.id)).sort(), error: null };
}

async function snapshot(table: Table, id: string): Promise<unknown> {
  const rows = await sql<{ j: unknown }>(`select to_jsonb(t) as j from public.${table} t where id::text = $1`, [id]);
  return rows[0]?.j ?? null;
}

afterAll(closePool);

beforeAll(async () => {
  [A, B] = await Promise.all([createFixtureOrg({ lease: LEASE }), createFixtureOrg({ lease: LEASE })]);
  LA1 = A.lease!;
  LB1 = B.lease!;
  LA2 = await insertLease(A.orgId, A.unitIds[1], A.tenantBId, LEASE, A.users.manager.userId);
  const m1 = await seedMoney(LA1, A, A.users.tenantA.userId);
  approvedLA1 = m1.approved;
  pendingLA1 = m1.pending;
  await seedMoney(LA2, A, A.users.tenantB.userId);
  await seedMoney(LB1, B, B.users.tenantA.userId);

  // A user who is staff in org B and, separately, a tenant with a lease in org A.
  dual = await createFixtureUser("dual");
  await sql("insert into public.memberships (user_id, org_id, role) values ($1, $2, 'staff')", [dual.userId, B.orgId]);
  dualTenantId = await insertTenant(A.orgId, dual.userId, "Dual Person", dual.email);
  LDual = await insertLease(A.orgId, await insertUnit(A.orgId), dualTenantId, LEASE, A.users.manager.userId);
  await seedMoney(LDual, A, dual.userId);

  const mk = (name: string, s: Session | null, grants: Grant[]): Actor => ({
    name,
    client: s ? userClient(s.accessToken) : anonClient(),
    userId: s?.userId ?? null,
    grants,
  });
  actors = {
    anon: mk("anon", null, []),
    tenantA: mk("tenantA", A.users.tenantA, [{ kind: "tenant", tenantId: A.tenantAId, orgId: A.orgId }]),
    tenantB: mk("tenantB", A.users.tenantB, [{ kind: "tenant", tenantId: A.tenantBId, orgId: A.orgId }]),
    // org A's tenant B has no lease in this file except LA2; org B's tenant B has no lease at all.
    tenantNoLease: mk("tenantNoLease", B.users.tenantB, [{ kind: "tenant", tenantId: B.tenantBId, orgId: B.orgId }]),
    staffA: mk("staffA", A.users.staff, [{ kind: "member", orgId: A.orgId, role: "staff" }]),
    managerA: mk("managerA", A.users.manager, [{ kind: "member", orgId: A.orgId, role: "manager" }]),
    staffB: mk("staffB", B.users.staff, [{ kind: "member", orgId: B.orgId, role: "staff" }]),
    managerB: mk("managerB", B.users.manager, [{ kind: "member", orgId: B.orgId, role: "manager" }]),
    dual: mk("dual", dual, [
      { kind: "member", orgId: B.orgId, role: "staff" },
      { kind: "tenant", tenantId: dualTenantId, orgId: A.orgId },
    ]),
  };
});

// ---------------------------------------------------------------------------------------------
// Reads: exact row sets per table and actor
// ---------------------------------------------------------------------------------------------
for (const table of TABLES) {
  describe(`R42 R2 Data API read matrix: ${table}`, () => {
    it("anon gets an error or nothing", async () => {
      const { ids } = await visibleIds(table, actors.anon);
      expect(ids).toEqual([]);
    });

    for (const name of ["tenantA", "tenantB", "tenantNoLease", "staffA", "managerA", "staffB", "managerB", "dual"]) {
      it(`${name} sees exactly the matrix rows`, async () => {
        const actor = actors[name];
        const want = await expectedIds(table, actor);
        const got = await visibleIds(table, actor);
        expect(got.error).toBeNull();
        expect(got.ids).toEqual(want);
      });
    }

    it("fixture sanity: org A has rows here and tenant A's view is a strict subset of manager A's", async () => {
      const mgr = await expectedIds(table, actors.managerA);
      expect(mgr.length).toBeGreaterThan(0);
      const ten = await expectedIds(table, actors.tenantA);
      if (table === "memberships" || table === "audit_log") expect(ten).toEqual([]);
      else {
        expect(ten.length).toBeGreaterThan(0);
        for (const id of ten) expect(mgr).toContain(id);
        if (table !== "organizations") expect(ten.length).toBeLessThan(mgr.length);
      }
    });
  });
}

describe("R42 R1 tenant isolation inside one org", () => {
  it("tenant A filtering explicitly for tenant B's lease / invoices / payments gets nothing", async () => {
    const c = actors.tenantA.client;
    expect((await c.from("leases").select("id").eq("id", LA2.id)).data).toEqual([]);
    expect((await c.from("invoices").select("id").eq("lease_id", LA2.id)).data).toEqual([]);
    expect((await c.from("payments").select("id").eq("lease_id", LA2.id)).data).toEqual([]);
    expect((await c.from("payment_allocations").select("id").eq("lease_id", LA2.id)).data).toEqual([]);
    expect((await c.from("gateway_bills").select("id").eq("lease_id", LA2.id)).data).toEqual([]);
    expect((await c.from("tenants").select("id").eq("id", A.tenantBId)).data).toEqual([]);
    expect((await c.from("units").select("id").eq("id", A.unitIds[1])).data).toEqual([]);
  });

  it("tenant A cannot reach tenant B's data through embedded resources either", async () => {
    const { data } = await actors.tenantA.client.from("units").select("id, leases(id, invoices(id))");
    const json = JSON.stringify(data ?? []);
    expect(json).not.toContain(LA2.id);
    expect(json).not.toContain(A.unitIds[1]);
  });

  it("a tenant cannot read memberships or audit_log of their own org", async () => {
    for (const t of ["memberships", "audit_log"] as const) {
      const { ids } = await visibleIds(t, actors.tenantA);
      expect(ids).toEqual([]);
    }
  });

  it("count=exact as a tenant counts only their own rows (no count side channel)", async () => {
    const { count } = await actors.tenantA.client.from("invoices").select("*", { count: "exact", head: true });
    expect(count).toBe((await expectedIds("invoices", actors.tenantA)).length);
  });
});

describe("R2 R42 cross-org isolation for staff/manager", () => {
  it("manager A filtering for org B ids gets nothing in every table", async () => {
    const c = actors.managerA.client;
    for (const t of TABLES) {
      const col = t === "organizations" ? "id" : "org_id";
      const { data } = await c.from(t).select("id").eq(col, B.orgId);
      expect({ t, data }).toEqual({ t, data: [] });
    }
    expect((await c.from("leases").select("id").eq("id", LB1.id)).data).toEqual([]);
  });

  it("staff A cannot read audit_log; manager A reads only org A audit rows", async () => {
    expect((await visibleIds("audit_log", actors.staffA)).ids).toEqual([]);
    const { data } = await actors.managerA.client.from("audit_log").select("org_id");
    expect((data ?? []).length).toBeGreaterThan(0);
    for (const r of data as { org_id: string }[]) expect(r.org_id).toBe(A.orgId);
  });

  it("dual user (staff in B, tenant in A) sees org B as staff but only their own lease in org A", async () => {
    const { data } = await actors.dual.client.from("leases").select("id, org_id");
    const inA = (data as { id: string; org_id: string }[]).filter((r) => r.org_id === A.orgId).map((r) => r.id);
    expect(inA).toEqual([LDual.id]);
    expect((await visibleIds("memberships", actors.dual)).ids).toEqual(await idsFor("memberships", { kind: "member", orgId: B.orgId, role: "staff" }).then((x) => x.sort()));
    expect((await visibleIds("audit_log", actors.dual)).ids).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Writes: nobody can insert / update / delete anything (except tenant's own phone)
// ---------------------------------------------------------------------------------------------
const marker = `rls-probe-${randomUUID().slice(0, 8)}`;

function insertPayload(table: Table): Record<string, unknown> {
  switch (table) {
    case "organizations":
      return { name: marker };
    case "memberships":
      return { user_id: A.users.tenantB.userId, org_id: A.orgId, role: "manager" };
    case "units":
      return { org_id: A.orgId, name: marker };
    case "tenants":
      return { org_id: A.orgId, full_name: marker, email: `${marker}@x.test` };
    case "leases":
      return {
        org_id: A.orgId,
        unit_id: A.unitIds[1],
        tenant_id: A.tenantAId,
        start_date: "2040-01-01",
        end_date: "2040-12-31",
        monthly_rent_sen: 100,
        deposit_sen: 0,
      };
    case "invoices":
      return {
        org_id: A.orgId,
        lease_id: LA1.id,
        kind: "rent",
        period_index: 900,
        period_start: "2040-01-01",
        period_end: "2040-01-31",
        due_date: "2040-01-01",
        amount_sen: 100,
      };
    case "payments":
      return { org_id: A.orgId, lease_id: LA1.id, amount_sen: 777, method: "cash", status: "approved", received_at: "2026-03-01T00:00:00+08:00" };
    case "payment_allocations":
      return { org_id: A.orgId, lease_id: LA1.id, payment_id: pendingLA1, invoice_id: LA1.invoices[3].id, amount_sen: 777 };
    case "gateway_bills":
      return { org_id: A.orgId, lease_id: LA1.id, amount_sen: 777 };
    case "audit_log":
      return { org_id: A.orgId, action: marker, details: {} };
  }
}

async function insertedCount(table: Table): Promise<number> {
  const q: Record<Table, [string, unknown[]]> = {
    organizations: ["select count(*)::int as n from public.organizations where name = $1", [marker]],
    memberships: ["select count(*)::int as n from public.memberships where user_id = $1", [A.users.tenantB.userId]],
    units: ["select count(*)::int as n from public.units where name = $1", [marker]],
    tenants: ["select count(*)::int as n from public.tenants where full_name = $1", [marker]],
    leases: ["select count(*)::int as n from public.leases where start_date = '2040-01-01' and unit_id = $1", [A.unitIds[1]]],
    invoices: ["select count(*)::int as n from public.invoices where lease_id = $1 and period_index = 900", [LA1.id]],
    payments: ["select count(*)::int as n from public.payments where lease_id = $1 and amount_sen = 777", [LA1.id]],
    payment_allocations: ["select count(*)::int as n from public.payment_allocations where payment_id = $1", [pendingLA1]],
    gateway_bills: ["select count(*)::int as n from public.gateway_bills where lease_id = $1 and amount_sen = 777", [LA1.id]],
    audit_log: ["select count(*)::int as n from public.audit_log where action = $1", [marker]],
  };
  const [text, params] = q[table];
  const [r] = await sql<{ n: number }>(text, params);
  return r.n;
}

/** A real org-A row every client role could plausibly target, and a change to try on it. */
async function target(table: Table): Promise<{ id: string; patch: Record<string, unknown> }> {
  switch (table) {
    case "organizations":
      return { id: A.orgId, patch: { name: "hacked" } };
    case "memberships": {
      const [m] = await sql<{ id: string }>("select id from public.memberships where user_id = $1", [A.users.staff.userId]);
      return { id: m.id, patch: { role: "manager" } };
    }
    case "units":
      return { id: LA1.unitId, patch: { name: "hacked" } };
    case "tenants":
      return { id: A.tenantAId, patch: { full_name: "hacked" } };
    case "leases":
      return { id: LA1.id, patch: { monthly_rent_sen: 1 } };
    case "invoices":
      return { id: LA1.invoices[0].id, patch: { amount_sen: 1 } };
    case "payments":
      return { id: approvedLA1, patch: { status: "voided", reason: "hacked by client" } };
    case "payment_allocations": {
      const [a] = await sql<{ id: string }>("select id from public.payment_allocations where payment_id = $1 limit 1", [approvedLA1]);
      return { id: a.id, patch: { amount_sen: 1 } };
    }
    case "gateway_bills": {
      const [b] = await sql<{ id: string }>("select id from public.gateway_bills where lease_id = $1 limit 1", [LA1.id]);
      return { id: b.id, patch: { status: "paid", paid_at: "2026-03-15T00:00:00+08:00" } };
    }
    case "audit_log": {
      const [l] = await sql<{ id: string }>("select id::text as id from public.audit_log where org_id = $1 order by id limit 1", [A.orgId]);
      return { id: l.id, patch: { action: "hacked" } };
    }
  }
}

const WRITERS = ["anon", "tenantA", "staffA", "managerA", "managerB", "dual"];

for (const table of TABLES) {
  describe(`R42 R43 Data API writes refused: ${table}`, () => {
    for (const name of WRITERS) {
      it(`${name}: INSERT fails and nothing is stored`, async () => {
        const { error } = await actors[name].client.from(table).insert(insertPayload(table));
        expect(error).not.toBeNull();
        expect(await insertedCount(table)).toBe(0);
      });

      it(`${name}: UPSERT fails and nothing is stored`, async () => {
        const { error } = await actors[name].client.from(table).upsert(insertPayload(table));
        expect(error).not.toBeNull();
        expect(await insertedCount(table)).toBe(0);
      });

      it(`${name}: UPDATE changes nothing`, async () => {
        const { id, patch } = await target(table);
        const before = await snapshot(table, id);
        expect(before).not.toBeNull();
        const { data, error } = await actors[name].client.from(table).update(patch).eq("id", id).select();
        expect(error !== null || (data ?? []).length === 0).toBe(true);
        expect(await snapshot(table, id)).toEqual(before);
      });

      it(`${name}: DELETE removes nothing`, async () => {
        const { id } = await target(table);
        const before = await snapshot(table, id);
        const { data, error } = await actors[name].client.from(table).delete().eq("id", id).select();
        expect(error !== null || (data ?? []).length === 0).toBe(true);
        expect(await snapshot(table, id)).toEqual(before);
      });
    }

    it("tenantA: bulk UPDATE / DELETE with no filter changes nothing visible to them", async () => {
      const { id, patch } = await target(table);
      const before = await snapshot(table, id);
      await actors.tenantA.client.from(table).update(patch).neq("id", "00000000-0000-0000-0000-000000000000");
      await actors.tenantA.client.from(table).delete().neq("id", "00000000-0000-0000-0000-000000000000");
      expect(await snapshot(table, id)).toEqual(before);
    });
  });
}

describe("R1 R42 tenants: a tenant updates only their own phone", () => {
  it("tenant A updates own phone through supabase-js", async () => {
    const phone = `+6012${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
    const { data, error } = await actors.tenantA.client.from("tenants").update({ phone }).eq("id", A.tenantAId).select("id, phone");
    expect(error).toBeNull();
    expect(data).toEqual([{ id: A.tenantAId, phone }]);
    const [r] = await sql<{ phone: string }>("select phone from public.tenants where id = $1", [A.tenantAId]);
    expect(r.phone).toBe(phone);
  });

  it("an invalid phone is refused by the DB check", async () => {
    const before = await snapshot("tenants", A.tenantAId);
    const { error } = await actors.tenantA.client.from("tenants").update({ phone: "call me maybe" }).eq("id", A.tenantAId);
    expect(error?.code).toBe("23514");
    expect(await snapshot("tenants", A.tenantAId)).toEqual(before);
  });

  for (const [col, value] of [
    ["full_name", "Someone Else"],
    ["email", "evil@x.test"],
    ["user_id", randomUUID()],
    ["org_id", randomUUID()],
    ["id", randomUUID()],
    ["created_at", "2000-01-01T00:00:00Z"],
  ] as const) {
    it(`tenant A cannot update own ${col} (alone or bundled with phone)`, async () => {
      const before = await snapshot("tenants", A.tenantAId);
      const c = actors.tenantA.client.from("tenants");
      const r1 = await c.update({ [col]: value }).eq("id", A.tenantAId);
      expect(r1.error).not.toBeNull();
      const r2 = await actors.tenantA.client.from("tenants").update({ [col]: value, phone: "+60123334444" }).eq("id", A.tenantAId);
      expect(r2.error).not.toBeNull();
      expect(await snapshot("tenants", A.tenantAId)).toEqual(before);
    });
  }

  it("tenant A cannot update tenant B's phone (same org) or another org's tenant", async () => {
    for (const id of [A.tenantBId, B.tenantAId]) {
      const before = await snapshot("tenants", id);
      const { data } = await actors.tenantA.client.from("tenants").update({ phone: "+60111111111" }).eq("id", id).select();
      expect(data ?? []).toEqual([]);
      expect(await snapshot("tenants", id)).toEqual(before);
    }
  });

  it("staff and manager cannot update a tenant's phone (matrix: read only)", async () => {
    for (const name of ["staffA", "managerA"]) {
      const before = await snapshot("tenants", A.tenantAId);
      const { data } = await actors[name].client.from("tenants").update({ phone: "+60122222222" }).eq("id", A.tenantAId).select();
      expect(data ?? []).toEqual([]);
      expect(await snapshot("tenants", A.tenantAId)).toEqual(before);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Privilege escalation
// ---------------------------------------------------------------------------------------------
describe("R37 R42 privilege escalation", () => {
  it("staff cannot promote their own membership to manager or move it to another org", async () => {
    const [m] = await sql<{ id: string }>("select id from public.memberships where user_id = $1", [A.users.staff.userId]);
    const before = await snapshot("memberships", m.id);
    await actors.staffA.client.from("memberships").update({ role: "manager" }).eq("id", m.id);
    await actors.staffA.client.from("memberships").update({ org_id: B.orgId }).eq("id", m.id);
    expect(await snapshot("memberships", m.id)).toEqual(before);
  });

  it("a tenant cannot insert a membership for themselves", async () => {
    const { error } = await actors.tenantA.client
      .from("memberships")
      .insert({ user_id: A.users.tenantA.userId, org_id: A.orgId, role: "manager" });
    expect(error).not.toBeNull();
    const [r] = await sql<{ n: number }>("select count(*)::int as n from public.memberships where user_id = $1", [A.users.tenantA.userId]);
    expect(r.n).toBe(0);
  });

  it("role/org_id in user_metadata gives nothing: staff with role=manager still cannot read audit_log or org B", async () => {
    const u = await createFixtureUser("meta");
    await sql("insert into public.memberships (user_id, org_id, role) values ($1, $2, 'staff')", [u.userId, A.orgId]);
    const res = await fetch(`${env.supabaseUrl}/auth/v1/user`, {
      method: "PUT",
      headers: { apikey: env.publishableKey, Authorization: `Bearer ${u.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ data: { role: "manager", org_id: B.orgId, is_admin: true } }),
    });
    expect(res.status).toBe(200);
    const fresh = await signIn(u.email, env.seedPassword, { fresh: true });
    const claims = JSON.parse(Buffer.from(fresh.accessToken.split(".")[1], "base64url").toString("utf8")) as {
      user_metadata?: { role?: string };
    };
    expect(claims.user_metadata?.role).toBe("manager"); // the attacker really did set it
    const c = userClient(fresh.accessToken);
    expect((await c.from("audit_log").select("id")).data).toEqual([]);
    expect((await c.from("leases").select("id").eq("org_id", B.orgId)).data).toEqual([]);
    const { error } = await c.from("payments").insert({ org_id: A.orgId, lease_id: LA1.id, amount_sen: 777, method: "cash", status: "approved", received_at: "2026-03-01T00:00:00+08:00" });
    expect(error).not.toBeNull();
    expect(await insertedCount("payments")).toBe(0);
  });

  it("a user cannot write app_metadata (only the server can)", async () => {
    const u = await createFixtureUser("appmeta");
    await fetch(`${env.supabaseUrl}/auth/v1/user`, {
      method: "PUT",
      headers: { apikey: env.publishableKey, Authorization: `Bearer ${u.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ app_metadata: { role: "manager" } }),
    });
    const [r] = await sql<{ m: Record<string, unknown> }>("select raw_app_meta_data as m from auth.users where id = $1", [u.userId]);
    expect(r.m.role).toBeUndefined();
  });

  it("a forged JWT (signed with a wrong secret) is rejected by PostgREST", async () => {
    const [h, p] = A.tokens.manager.split(".");
    const forged = `${h}.${p}.${Buffer.from("not-a-signature").toString("base64url")}`;
    const { data, error } = await userClient(forged).from("leases").select("id");
    expect(error).not.toBeNull();
    expect(data).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Exposed functions: /rest/v1/rpc/*
// ---------------------------------------------------------------------------------------------
describe("R42 R28 Data API RPC: money functions and helpers unreachable", () => {
  const argsFor = (fn: string): Record<string, unknown> => {
    switch (fn) {
      case "record_payment":
        return {
          p_actor_id: A.users.manager.userId,
          p_lease_id: LA1.id,
          p_amount_sen: 779,
          p_method: "cash",
          p_received_at: "2026-03-01T00:00:00+08:00",
          p_slip_path: null,
          p_idempotency_key: null,
        };
      case "approve_payment":
      case "lock_payment_for_manager":
        return { p_actor_id: A.users.manager.userId, p_payment_id: pendingLA1 };
      case "reject_payment":
      case "void_payment":
        return { p_actor_id: A.users.manager.userId, p_payment_id: fn === "void_payment" ? approvedLA1 : pendingLA1, p_reason: "rpc attack" };
      case "allocate_payment":
        return { p_payment_id: pendingLA1 };
      case "create_gateway_bill":
        return { p_actor_id: A.users.tenantA.userId, p_lease_id: LA1.id };
      case "apply_gateway_callback":
        return { p_bill_id: randomUUID(), p_paid: true, p_paid_amount_sen: 1, p_paid_at: "2026-03-01T00:00:00+08:00", p_transaction_id: "x", p_transaction_status: "completed" };
      default:
        return { p_org: A.orgId, p_roles: ["manager"], p_lease: LA1.id, p_object_name: `${A.orgId}/x.png` };
    }
  };

  async function moneyState(): Promise<unknown> {
    const [r] = await sql(
      `select (select json_agg(to_jsonb(p) order by p.id) from public.payments p where p.lease_id = $1) as payments,
              (select count(*)::int from public.payment_allocations a where a.lease_id = $1) as allocations,
              (select json_agg(to_jsonb(b) order by b.id) from public.gateway_bills b where b.lease_id = $1) as bills,
              (select count(*)::int from public.audit_log l where l.org_id = $2) as audit`,
      [LA1.id, A.orgId],
    );
    return r;
  }

  for (const fn of [...MONEY_FUNCTIONS, ...RLS_HELPERS]) {
    describe(`rpc ${fn}`, () => {
      for (const name of ["anon", "tenantA", "staffA", "managerA"]) {
        it(`${name}: /rest/v1/rpc/${fn} (public) and Content-Profile: private both fail, state unchanged`, async () => {
          const before = await moneyState();
          const c = actors[name].client;
          const r1 = await c.rpc(fn, argsFor(fn));
          expect(r1.error).not.toBeNull();
          const r2 = await c.schema("private").rpc(fn, argsFor(fn));
          expect(r2.error).not.toBeNull();
          expect(await moneyState()).toEqual(before);
        });
      }
    });
  }

  it("raw HTTP: POST /rest/v1/rpc/record_payment with Content-Profile: private as manager is a 4xx, never 2xx", async () => {
    const res = await fetch(`${env.supabaseUrl}/rest/v1/rpc/record_payment`, {
      method: "POST",
      headers: {
        apikey: env.publishableKey,
        Authorization: `Bearer ${A.tokens.manager}`,
        "Content-Type": "application/json",
        "Content-Profile": "private",
      },
      body: JSON.stringify(argsFor("record_payment")),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("every function in public (none expected) is refused for anon and authenticated", async () => {
    const fns = await sql<{ name: string }>(
      `select p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`,
    );
    for (const { name } of fns) {
      for (const who of ["anon", "tenantA", "managerA"]) {
        const { error } = await actors[who].client.rpc(name, {});
        expect({ name, who, refused: error !== null }).toEqual({ name, who, refused: true });
      }
    }
    expect(fns).toEqual([]);
  });

  it("the OpenAPI root as anon lists no table or rpc path", async () => {
    const res = await fetch(`${env.supabaseUrl}/rest/v1/`, { headers: { apikey: env.publishableKey } });
    if (res.status === 200) {
      const doc = (await res.json()) as { paths?: Record<string, unknown> };
      const paths = Object.keys(doc.paths ?? {}).filter((p) => p !== "/");
      expect(paths).toEqual([]);
    } else {
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
  });
});
