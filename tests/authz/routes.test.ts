import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminClient, userClient } from "../helpers/clients";
import { closePool, sql } from "../helpers/db";
import { env } from "../helpers/env";
import { createFixtureOrg, createFixtureUser, type FixtureOrg } from "../helpers/fixtures";
import type { HttpResult } from "../helpers/http";
import { seeded, type SeededKey, type Session } from "../helpers/seeded";
import {
  GARBAGE_AUTH,
  MALFORMED,
  NONEXISTENT,
  call,
  count,
  expectError,
  expectNoLeaks,
  leakProblems,
  loadSeededIds,
  paymentStatus,
  type SeededIds,
} from "./support";

// R36-R41 through the real route handlers over HTTP (the Prisma role bypasses RLS, so the handlers'
// own checks are the only thing standing between a caller and another org's data).
// Read-only probes run against the brief's seeded data; every probe that could write if the check
// were missing is built so that a hole shows up as a non-mutating 400/409 (short reason, invalid
// body, already-approved payment) - or runs on fresh fixture orgs F and G.

const SEEDED_KEYS: SeededKey[] = ["northwindManager", "northwindStaff", "aisyah", "ben", "probe", "betaManager", "chen"];
const LEASE = { startDate: "2026-01-01", endDate: "2026-12-31", monthlyRentSen: 100000, depositSen: 50000 };
const BAD_PAYMENT = { amountSen: -1, method: "cash", receivedAt: "nope" }; // 400 if a check were skipped
const SHORT_REASON = { reason: "x" }; // 400 if a check were skipped
const OK_REASON = { reason: "Authorization probe" };
const cash = (amountSen = 1000) => ({ amountSen, method: "cash", receivedAt: "2026-02-01T10:00:00+08:00" });

let S: Record<SeededKey, Session>;
let ids: SeededIds;
let F: FixtureOrg; // the org under test
let G: FixtureOrg; // "another org"
let noRole: Session; // signed-in user with no membership and no tenant row
let gSlip: string; // an existing object in G's folder
const uploaded: string[] = [];

const tok = (k: SeededKey) => S[k].accessToken;
const enc = encodeURIComponent;
const leasesOnUnit = (unitId: string) => count("select 1 from public.leases where unit_id = $1", [unitId]);
const paymentsOnLease = (leaseId: string) => count("select 1 from public.payments where lease_id = $1", [leaseId]);

async function recordAs(token: string, leaseId: string, body: unknown): Promise<HttpResult> {
  return call(token, "POST", `/api/leases/${leaseId}/payments`, body);
}

async function newPending(): Promise<string> {
  const r = await recordAs(F.tokens.staff, F.lease!.id, cash());
  expect(r.status).toBe(201);
  const b = r.body as { id: string; status: string };
  expect(b.status).toBe("pending_verification");
  return b.id;
}

/** 401 cases for one route: no credentials at all, and every garbage credential shape. */
function unauthenticated(method: "GET" | "POST", path: () => string, body: () => unknown = () => ({})) {
  it("no credentials -> 401 JSON, never a redirect or HTML", async () => {
    expectError(await call(undefined, method, path(), body()), 401);
  });
  for (const [label, auth] of GARBAGE_AUTH) {
    it(`${label} -> 401`, async () => {
      expectError(await call(auth, method, path(), body()), 401);
    });
  }
}

beforeAll(async () => {
  const sessions = await Promise.all(SEEDED_KEYS.map((k) => seeded(k)));
  S = Object.fromEntries(SEEDED_KEYS.map((k, i) => [k, sessions[i]])) as Record<SeededKey, Session>;
  ids = await loadSeededIds();
  [F, G, noRole] = await Promise.all([
    createFixtureOrg({ units: 4, lease: LEASE }),
    createFixtureOrg({ units: 2, lease: LEASE }),
    createFixtureUser("norole"),
  ]);
  gSlip = `${G.orgId}/${G.lease!.id}/${randomUUID()}.png`;
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  const up = await userClient(G.tokens.staff).storage.from("payment-slips").upload(gSlip, png, { contentType: "image/png" });
  if (up.error) throw new Error(`fixture slip upload failed: ${up.error.message}`);
  uploaded.push(gSlip);
});

afterAll(async () => {
  if (uploaded.length) await adminClient().storage.from("payment-slips").remove(uploaded);
  await closePool();
});

// ---------------------------------------------------------------------------------------------
describe("R36 R38 R39 R40 POST /api/leases", () => {
  const body = () => ({ unitId: F.unitIds[1], tenantId: F.tenantBId, ...LEASE });
  unauthenticated("POST", () => "/api/leases", body);

  it("staff, tenant and a user with no role -> 403 even with a malformed JSON body (role before validation)", async () => {
    for (const t of [tok("northwindStaff"), tok("aisyah"), tok("chen"), noRole.accessToken]) {
      expectError(await call(t, "POST", "/api/leases", "{"), 403);
    }
  });

  it("fixture staff / tenants with a VALID body -> 403 and no lease is created", async () => {
    for (const t of [F.tokens.staff, F.tokens.tenantA, F.tokens.tenantB]) {
      expectError(await call(t, "POST", "/api/leases", body()), 403);
    }
    expect(await leasesOnUnit(F.unitIds[1])).toBe(0);
  });

  it("R39 another org's unitId (fixture G) -> 404 and no lease on that unit", async () => {
    const before = await leasesOnUnit(G.unitIds[1]);
    const r = await call(F.tokens.manager, "POST", "/api/leases", { ...body(), unitId: G.unitIds[1] });
    expectError(r, 404, [G.unitIds[1], G.orgName]);
    expect(await leasesOnUnit(G.unitIds[1])).toBe(before);
  });

  it("R39 another org's tenantId (fixture G) -> 404 and no lease for that tenant", async () => {
    const r = await call(F.tokens.manager, "POST", "/api/leases", { ...body(), tenantId: G.tenantBId });
    expectError(r, 404, [G.tenantBId]);
    expect(await count("select 1 from public.leases where tenant_id = $1", [G.tenantBId])).toBe(0);
    expect(await leasesOnUnit(F.unitIds[1])).toBe(0);
  });

  it("R39 the seeded Beta unit / Chen tenant ids from a Northwind-style manager -> 404, Beta untouched", async () => {
    const before = await leasesOnUnit(ids.betaUnit);
    expectError(await call(F.tokens.manager, "POST", "/api/leases", { ...body(), unitId: ids.betaUnit }), 404);
    expectError(await call(F.tokens.manager, "POST", "/api/leases", { ...body(), tenantId: ids.chenTenant }), 404);
    expectError(
      await call(tok("northwindManager"), "POST", "/api/leases", { ...body(), unitId: ids.betaUnit, tenantId: ids.chenTenant }),
      404,
    );
    expect(await leasesOnUnit(ids.betaUnit)).toBe(before);
  });

  for (const extra of [{ orgId: "G" }, { org_id: "G" }, { status: "active" }, { createdBy: "x" }, { id: "x" }]) {
    it(`extra key ${Object.keys(extra)[0]} -> 400 (zod strict) and nothing created`, async () => {
      const v = Object.values(extra)[0] === "G" ? G.orgId : randomUUID();
      const r = await call(F.tokens.manager, "POST", "/api/leases", { ...body(), [Object.keys(extra)[0]]: v });
      expectError(r, 400);
      expect(await leasesOnUnit(F.unitIds[1])).toBe(0);
    });
  }

  it("positive control: the org's manager with a valid body -> 201 { id } in the manager's own org", async () => {
    const r = await call(F.tokens.manager, "POST", "/api/leases", body());
    expect(r.status).toBe(201);
    const { id } = r.body as { id: string };
    expect(Object.keys(r.body as object)).toEqual(["id"]);
    const rows = await sql<{ org_id: string }>("select org_id from public.leases where id = $1", [id]);
    expect(rows).toEqual([{ org_id: F.orgId }]);
  });

  it("R41 odd-but-valid body (year 0000 dates) never leaks internals; any 500 is the generic body", async () => {
    const r = await call(F.tokens.manager, "POST", "/api/leases", {
      ...body(),
      unitId: F.unitIds[2],
      startDate: "0000-01-01",
      endDate: "0000-01-31",
    });
    if (r.status === 500) expect(r.body).toEqual({ error: "Internal error" });
    else if (r.status !== 201) expectError(r, r.status);
  });
});

// ---------------------------------------------------------------------------------------------
describe("R36 R38 R2 GET /api/leases", () => {
  unauthenticated("GET", () => "/api/leases");

  const idsOf = (r: HttpResult) => (r.body as { id: string }[]).map((l) => l.id).sort();
  const orgLeases = async (orgId: string) =>
    (await sql<{ id: string }>("select id from public.leases where org_id = $1", [orgId])).map((r) => r.id).sort();

  it("Northwind manager and staff see exactly Northwind's leases", async () => {
    const expected = await orgLeases(ids.northwindOrgId);
    for (const k of ["northwindManager", "northwindStaff"] as const) {
      const r = await call(tok(k), "GET", "/api/leases");
      expect(r.status).toBe(200);
      expect(idsOf(r)).toEqual(expected);
    }
  });

  it("Beta manager sees exactly Beta's leases (none of Northwind's)", async () => {
    const r = await call(tok("betaManager"), "GET", "/api/leases");
    expect(r.status).toBe(200);
    expect(idsOf(r)).toEqual(await orgLeases(ids.betaOrgId));
    expect(idsOf(r)).not.toContain(ids.aisyahLease);
  });

  it("each seeded tenant sees only their own lease", async () => {
    const cases: Array<[SeededKey, string]> = [
      ["aisyah", ids.aisyahLease],
      ["ben", ids.benLease],
      ["probe", ids.probeLease],
      ["chen", ids.chenLease],
    ];
    for (const [k, lease] of cases) {
      const r = await call(tok(k), "GET", "/api/leases");
      expect(r.status, k).toBe(200);
      expect(idsOf(r), k).toEqual([lease]);
    }
  });

  it("a signed-in user with no membership and no tenant row -> 403", async () => {
    expectError(await call(noRole.accessToken, "GET", "/api/leases"), 403);
  });
});

// ---------------------------------------------------------------------------------------------
describe("R36 R38 R2 GET /api/leases/:leaseId", () => {
  unauthenticated("GET", () => `/api/leases/${ids.aisyahLease}`);

  it("Aisyah's lease: manager, staff and Aisyah -> 200 with that lease", async () => {
    for (const k of ["northwindManager", "northwindStaff", "aisyah"] as const) {
      const r = await call(tok(k), "GET", `/api/leases/${ids.aisyahLease}`);
      expect(r.status, k).toBe(200);
      expect((r.body as { lease: { id: string } }).lease.id).toBe(ids.aisyahLease);
    }
  });

  it("other tenant in the same org (ben, probe on Aisyah's lease) -> 404, no data", async () => {
    for (const k of ["ben", "probe"] as const) {
      expectError(await call(tok(k), "GET", `/api/leases/${ids.aisyahLease}`), 404, ["Aisyah", "300000", "invoices"]);
    }
  });

  it("other org (Beta manager, Chen on Aisyah's lease; Northwind on Chen's) -> 404, no data", async () => {
    for (const k of ["betaManager", "chen"] as const) {
      expectError(await call(tok(k), "GET", `/api/leases/${ids.aisyahLease}`), 404, ["Aisyah", "invoices"]);
    }
    for (const k of ["northwindManager", "northwindStaff", "aisyah"] as const) {
      expectError(await call(tok(k), "GET", `/api/leases/${ids.chenLease}`), 404, ["Chen", "invoices"]);
    }
  });

  it("Chen's lease: Beta manager and Chen -> 200", async () => {
    for (const k of ["betaManager", "chen"] as const) {
      expect((await call(tok(k), "GET", `/api/leases/${ids.chenLease}`)).status, k).toBe(200);
    }
  });

  it("no role at all -> 404", async () => {
    expectError(await call(noRole.accessToken, "GET", `/api/leases/${ids.aisyahLease}`), 404);
  });

  for (const bad of MALFORMED) {
    it(`malformed id '${bad}' -> 404`, async () => {
      expectError(await call(tok("northwindManager"), "GET", `/api/leases/${enc(bad)}`), 404);
    });
  }

  it("well-formed nonexistent uuid -> 404", async () => {
    expectError(await call(tok("northwindManager"), "GET", `/api/leases/${NONEXISTENT}`), 404);
  });
});

// ---------------------------------------------------------------------------------------------
describe("R36 R38 R39 R44 POST /api/leases/:leaseId/payments", () => {
  unauthenticated("POST", () => `/api/leases/${ids.aisyahLease}/payments`, () => BAD_PAYMENT);

  it("other org (Beta manager, Chen on Aisyah's lease) -> 404 before validation", async () => {
    for (const k of ["betaManager", "chen"] as const) {
      expectError(await recordAs(tok(k), ids.aisyahLease, BAD_PAYMENT), 404);
    }
  });

  it("other tenant in the same org (Ben on Aisyah's lease) -> 404", async () => {
    expectError(await recordAs(tok("ben"), ids.aisyahLease, BAD_PAYMENT), 404);
  });

  it("the lease's own tenant (Aisyah) -> 403 before validation", async () => {
    expectError(await recordAs(tok("aisyah"), ids.aisyahLease, BAD_PAYMENT), 403);
  });

  it("fixture: tenant A with a VALID body on own lease -> 403, tenant B -> 404, other org -> 404; nothing recorded", async () => {
    const before = await paymentsOnLease(F.lease!.id);
    expectError(await recordAs(F.tokens.tenantA, F.lease!.id, cash()), 403);
    expectError(await recordAs(F.tokens.tenantB, F.lease!.id, cash()), 404);
    expectError(await recordAs(G.tokens.manager, F.lease!.id, cash()), 404);
    expectError(await recordAs(G.tokens.staff, F.lease!.id, cash()), 404);
    expectError(await recordAs(noRole.accessToken, F.lease!.id, cash()), 404);
    expect(await paymentsOnLease(F.lease!.id)).toBe(before);
  });

  for (const bad of MALFORMED) {
    it(`malformed lease id '${bad}' -> 404`, async () => {
      expectError(await recordAs(tok("northwindManager"), enc(bad), BAD_PAYMENT), 404);
    });
  }

  it("well-formed nonexistent lease id -> 404", async () => {
    expectError(await recordAs(tok("northwindManager"), NONEXISTENT, BAD_PAYMENT), 404);
  });

  for (const extra of [{ status: "approved" }, { org_id: "G" }, { orgId: "G" }, { leaseId: "G" }, { unappliedSen: 0 }]) {
    const key = Object.keys(extra)[0];
    it(`extra key ${key} -> 400 and nothing recorded`, async () => {
      const before = await paymentsOnLease(F.lease!.id);
      const v = Object.values(extra)[0] === "G" ? (key === "leaseId" ? G.lease!.id : G.orgId) : 0;
      expectError(await recordAs(F.tokens.staff, F.lease!.id, { ...cash(), [key]: v }), 400);
      expect(await paymentsOnLease(F.lease!.id)).toBe(before);
    });
  }

  it("R44 slipPath in another org's folder (existing object) -> 400, nothing recorded, G's file untouched", async () => {
    const before = await paymentsOnLease(F.lease!.id);
    for (const t of [F.tokens.manager, F.tokens.staff]) {
      const r = await recordAs(t, F.lease!.id, { ...cash(), method: "bank_transfer", slipPath: gSlip });
      expectError(r, 400, [G.orgId]);
    }
    expect(await paymentsOnLease(F.lease!.id)).toBe(before);
    expect(await count("select 1 from public.payments where slip_path = $1", [gSlip])).toBe(0);
    expect(await count("select 1 from storage.objects where bucket_id = 'payment-slips' and name = $1", [gSlip])).toBe(1);
  });

  it("R44 slipPath traversal out of the own org folder -> 400, G's file untouched", async () => {
    const before = await paymentsOnLease(F.lease!.id);
    const traversal = `${F.orgId}/../${gSlip}`;
    expectError(await recordAs(F.tokens.manager, F.lease!.id, { ...cash(), method: "bank_transfer", slipPath: traversal }), 400);
    expect(await paymentsOnLease(F.lease!.id)).toBe(before);
    expect(await count("select 1 from storage.objects where bucket_id = 'payment-slips' and name = $1", [gSlip])).toBe(1);
  });

  it("positive controls: staff -> 201 pending_verification, manager -> 201 approved (own org)", async () => {
    const s = await recordAs(F.tokens.staff, F.lease!.id, cash());
    expect(s.status).toBe(201);
    expect((s.body as { status: string }).status).toBe("pending_verification");
    const m = await recordAs(F.tokens.manager, F.lease!.id, cash());
    expect(m.status).toBe(201);
    expect((m.body as { status: string }).status).toBe("approved");
    const rows = await sql<{ org_id: string }>("select org_id from public.payments where id = any($1::uuid[])", [
      [(s.body as { id: string }).id, (m.body as { id: string }).id],
    ]);
    expect(rows.map((r) => r.org_id)).toEqual([F.orgId, F.orgId]);
  });

  it("R41 odd-but-valid receivedAt (year 0000) never leaks internals; any 500 is the generic body", async () => {
    const r = await recordAs(F.tokens.staff, F.lease!.id, { ...cash(), receivedAt: "0000-01-01T00:00:00Z" });
    if (r.status === 500) expect(r.body).toEqual({ error: "Internal error" });
    else if (r.status !== 201) expectError(r, r.status);
  });
});

// ---------------------------------------------------------------------------------------------
describe("R36 R38 R1 POST /api/payments/:paymentId/approve", () => {
  const path = (id: string) => `/api/payments/${id}/approve`;
  unauthenticated("POST", () => path(ids.aisyahTransfer));

  it("seeded: Beta manager, Chen, Ben -> 404; Aisyah (own lease) and Northwind staff -> 403", async () => {
    for (const k of ["betaManager", "chen", "ben", "probe"] as const) {
      expectError(await call(tok(k), "POST", path(ids.aisyahTransfer)), 404);
    }
    for (const k of ["aisyah", "northwindStaff"] as const) {
      expectError(await call(tok(k), "POST", path(ids.aisyahTransfer)), 403);
    }
  });

  it("seeded control: Northwind manager on an already-approved payment -> 409 (visible, allowed, not pending)", async () => {
    expectError(await call(tok("northwindManager"), "POST", path(ids.aisyahTransfer)), 409);
  });

  it("fixture: staff and tenant A -> 403, tenant B, other org and no-role -> 404; payment stays pending", async () => {
    const id = await newPending();
    expectError(await call(F.tokens.staff, "POST", path(id)), 403);
    expectError(await call(F.tokens.tenantA, "POST", path(id)), 403);
    expectError(await call(F.tokens.tenantB, "POST", path(id)), 404);
    expectError(await call(G.tokens.manager, "POST", path(id)), 404);
    expectError(await call(G.tokens.staff, "POST", path(id)), 404);
    expectError(await call(noRole.accessToken, "POST", path(id)), 404);
    expect(await paymentStatus(id)).toBe("pending_verification");
    const ok = await call(F.tokens.manager, "POST", path(id));
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ status: "approved" });
  });

  for (const bad of MALFORMED) {
    it(`malformed id '${bad}' -> 404`, async () => {
      expectError(await call(tok("northwindManager"), "POST", path(enc(bad))), 404);
    });
  }

  it("well-formed nonexistent uuid -> 404", async () => {
    expectError(await call(tok("northwindManager"), "POST", path(NONEXISTENT)), 404);
  });
});

// ---------------------------------------------------------------------------------------------
describe("R36 R38 R24 POST /api/payments/:paymentId/reject", () => {
  const path = (id: string) => `/api/payments/${id}/reject`;
  unauthenticated("POST", () => path(ids.aisyahTransfer), () => SHORT_REASON);

  it("seeded: Beta manager, Chen, Ben -> 404; Aisyah and Northwind staff -> 403 (before reason validation)", async () => {
    for (const k of ["betaManager", "chen", "ben", "probe"] as const) {
      expectError(await call(tok(k), "POST", path(ids.aisyahTransfer), SHORT_REASON), 404);
    }
    for (const k of ["aisyah", "northwindStaff"] as const) {
      expectError(await call(tok(k), "POST", path(ids.aisyahTransfer), SHORT_REASON), 403);
    }
  });

  it("seeded control: Northwind manager with a short reason -> 400 (visible, allowed)", async () => {
    expectError(await call(tok("northwindManager"), "POST", path(ids.aisyahTransfer), SHORT_REASON), 400);
  });

  it("fixture: staff / tenant A -> 403, tenant B / other org -> 404, extra key -> 400; stays pending; manager -> rejected", async () => {
    const id = await newPending();
    expectError(await call(F.tokens.staff, "POST", path(id), OK_REASON), 403);
    expectError(await call(F.tokens.tenantA, "POST", path(id), OK_REASON), 403);
    expectError(await call(F.tokens.tenantB, "POST", path(id), OK_REASON), 404);
    expectError(await call(G.tokens.manager, "POST", path(id), OK_REASON), 404);
    expectError(await call(F.tokens.manager, "POST", path(id), { ...OK_REASON, status: "approved" }), 400);
    expectError(await call(F.tokens.manager, "POST", path(id), { ...OK_REASON, org_id: G.orgId }), 400);
    expect(await paymentStatus(id)).toBe("pending_verification");
    const ok = await call(F.tokens.manager, "POST", path(id), OK_REASON);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ status: "rejected" });
  });

  for (const bad of MALFORMED) {
    it(`malformed id '${bad}' -> 404`, async () => {
      expectError(await call(tok("northwindManager"), "POST", path(enc(bad)), OK_REASON), 404);
    });
  }

  it("well-formed nonexistent uuid -> 404", async () => {
    expectError(await call(tok("northwindManager"), "POST", path(NONEXISTENT), OK_REASON), 404);
  });
});

// ---------------------------------------------------------------------------------------------
describe("R36 R38 R24 POST /api/payments/:paymentId/void", () => {
  const path = (id: string) => `/api/payments/${id}/void`;
  unauthenticated("POST", () => path(ids.aisyahCash), () => SHORT_REASON);

  it("seeded: Beta manager, Chen, Ben -> 404; Aisyah and Northwind staff -> 403 (before reason validation)", async () => {
    for (const id of [ids.aisyahCash, ids.aisyahTransfer]) {
      for (const k of ["betaManager", "chen", "ben", "probe"] as const) {
        expectError(await call(tok(k), "POST", path(id), SHORT_REASON), 404);
      }
      for (const k of ["aisyah", "northwindStaff"] as const) {
        expectError(await call(tok(k), "POST", path(id), SHORT_REASON), 403);
      }
    }
    expect(await paymentStatus(ids.aisyahCash)).toBe("approved");
    expect(await paymentStatus(ids.aisyahTransfer)).toBe("approved");
  });

  it("seeded control: Northwind manager with a short reason -> 400 (visible, allowed)", async () => {
    expectError(await call(tok("northwindManager"), "POST", path(ids.aisyahCash), SHORT_REASON), 400);
  });

  it("fixture: staff / tenant A -> 403, tenant B / other org -> 404, extra key -> 400; stays approved; manager -> voided", async () => {
    const r = await recordAs(F.tokens.manager, F.lease!.id, cash());
    expect(r.status).toBe(201);
    const id = (r.body as { id: string }).id;
    expectError(await call(F.tokens.staff, "POST", path(id), OK_REASON), 403);
    expectError(await call(F.tokens.tenantA, "POST", path(id), OK_REASON), 403);
    expectError(await call(F.tokens.tenantB, "POST", path(id), OK_REASON), 404);
    expectError(await call(G.tokens.manager, "POST", path(id), OK_REASON), 404);
    expectError(await call(F.tokens.manager, "POST", path(id), { ...OK_REASON, status: "approved" }), 400);
    expect(await paymentStatus(id)).toBe("approved");
    const ok = await call(F.tokens.manager, "POST", path(id), OK_REASON);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ status: "voided" });
  });

  for (const bad of MALFORMED) {
    it(`malformed id '${bad}' -> 404`, async () => {
      expectError(await call(tok("northwindManager"), "POST", path(enc(bad)), OK_REASON), 404);
    });
  }

  it("well-formed nonexistent uuid -> 404", async () => {
    expectError(await call(tok("northwindManager"), "POST", path(NONEXISTENT), OK_REASON), 404);
  });
});

// ---------------------------------------------------------------------------------------------
describe("R36 R38 R44 GET /api/payments/:paymentId/slip", () => {
  const path = (id: string) => `/api/payments/${id}/slip`;
  unauthenticated("GET", () => path(ids.aisyahTransfer));

  it("Northwind manager and staff -> 200 { url } that downloads the slip", async () => {
    for (const k of ["northwindManager", "northwindStaff"] as const) {
      const r = await call(tok(k), "GET", path(ids.aisyahTransfer));
      expect(r.status, k).toBe(200);
      const { url } = r.body as { url: string };
      expect(Object.keys(r.body as object)).toEqual(["url"]);
      expect((await fetch(url)).status).toBe(200);
    }
  });

  it("the payment's tenant (Aisyah) -> 403", async () => {
    expectError(await call(tok("aisyah"), "GET", path(ids.aisyahTransfer)), 403, ["token="]);
  });

  it("other tenant / other org (Ben, Probe, Beta manager, Chen, no-role) -> 404 without a URL", async () => {
    for (const k of ["ben", "probe", "betaManager", "chen"] as const) {
      expectError(await call(tok(k), "GET", path(ids.aisyahTransfer)), 404, ["token=", ids.northwindOrgId]);
    }
    expectError(await call(noRole.accessToken, "GET", path(ids.aisyahTransfer)), 404);
  });

  it("a cash payment (no slip) -> 404", async () => {
    expectError(await call(tok("northwindManager"), "GET", path(ids.aisyahCash)), 404);
  });

  for (const bad of MALFORMED) {
    it(`malformed id '${bad}' -> 404`, async () => {
      expectError(await call(tok("northwindManager"), "GET", path(enc(bad))), 404);
    });
  }

  it("well-formed nonexistent uuid -> 404", async () => {
    expectError(await call(tok("northwindManager"), "GET", path(NONEXISTENT)), 404);
  });
});

// ---------------------------------------------------------------------------------------------
describe("R36 R38 R29 GET /api/reports/collections", () => {
  const q = (from = "2026-01", to = "2026-03") => `/api/reports/collections?from=${from}&to=${to}`;
  unauthenticated("GET", () => q());

  it("Northwind manager and staff -> 200 with Northwind's numbers only", async () => {
    for (const k of ["northwindManager", "northwindStaff"] as const) {
      const r = await call(tok(k), "GET", q());
      expect(r.status, k).toBe(200);
      expect(r.body).toEqual([
        { month: "2026-01", collectedSen: 300000 },
        { month: "2026-02", collectedSen: 0 },
        { month: "2026-03", collectedSen: 200000 },
      ]);
    }
  });

  it("Beta manager -> 200 with Beta's numbers (none of Northwind's money)", async () => {
    const r = await call(tok("betaManager"), "GET", q());
    expect(r.status).toBe(200);
    expect(r.body).toEqual([
      { month: "2026-01", collectedSen: 0 },
      { month: "2026-02", collectedSen: 0 },
      { month: "2026-03", collectedSen: 0 },
    ]);
  });

  it("tenants and a no-role user -> 403, also with an invalid range (role before validation)", async () => {
    for (const t of [tok("aisyah"), tok("ben"), tok("chen"), noRole.accessToken]) {
      expectError(await call(t, "GET", q()), 403);
      expectError(await call(t, "GET", q("2026-03", "2026-01")), 403);
    }
  });

  it("staff with an invalid range -> 400", async () => {
    expectError(await call(tok("northwindStaff"), "GET", q("2026-03", "2026-01")), 400);
    expectError(await call(tok("northwindStaff"), "GET", q("2026-13", "2026-14")), 400);
  });

  it("R41 odd-but-valid range (year 0000) never leaks internals; any 500 is the generic body", async () => {
    const r = await call(tok("northwindStaff"), "GET", q("0000-01", "0000-02"));
    if (r.status === 500) expect(r.body).toEqual({ error: "Internal error" });
    else if (r.status !== 200) expectError(r, r.status);
  });
});

// ---------------------------------------------------------------------------------------------
describe("R41 no route response contains the secret key, a stack trace, Prisma or SQL text", () => {
  it("the detector itself flags a stack frame, Prisma, SQL and the secret key (so the sweep can fail)", () => {
    expect(leakProblems('{"error":"x"}')).toEqual([]);
    expect(leakProblems("Error: boom\n    at handler (/app/src/route.ts:10:5)").length).toBeGreaterThan(0);
    expect(leakProblems("PrismaClientKnownRequestError").length).toBeGreaterThan(0);
    expect(leakProblems('select id from public.leases where org_id = $1').length).toBeGreaterThan(0);
    expect(leakProblems(`key ${env.secretKey}`)).toContain("contains SUPABASE_SECRET_KEY");
  });

  it("sweep over every response recorded in this file", () => {
    expectNoLeaks();
  });
});
