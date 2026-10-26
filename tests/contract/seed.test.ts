import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateSchedule } from "@/lib/billing";
import { closePool, sql } from "../helpers/db";
import { SEEDED, signIn } from "../helpers/seeded";

// R5 R7-R9: what `npm run seed` must have created (brief section 2). Read-only. Seeded payments are
// asserted by method/amount/id, never by total counts: other lanes may add an online payment to
// Aisyah's lease through the webhook.

const SEED_PASSWORD = "RentDemo#2026"; // D24

let northwindId: string;
let betaId: string;

beforeAll(async () => {
  const orgs = await sql<{ id: string; name: string }>(
    "select id, name from public.organizations where name in ('Northwind Properties', 'Beta Realty')",
  );
  northwindId = orgs.find((o) => o.name === "Northwind Properties")!.id;
  betaId = orgs.find((o) => o.name === "Beta Realty")!.id;
});

afterAll(async () => {
  await closePool();
});

interface UserRole {
  email: string;
  user_id: string;
  m_org: string | null;
  m_role: string | null;
  t_org: string | null;
  t_name: string | null;
}

async function accounts(): Promise<Map<string, UserRole>> {
  const rows = await sql<UserRole>(
    `select lower(u.email) as email, u.id as user_id, m.org_id as m_org, m.role as m_role,
            t.org_id as t_org, t.full_name as t_name
       from auth.users u
       left join public.memberships m on m.user_id = u.id
       left join public.tenants t on t.user_id = u.id
      where lower(u.email) = any($1)`,
    [Object.values(SEEDED)],
  );
  return new Map(rows.map((r) => [r.email, r]));
}

describe("R7 seed: two organizations, seven accounts, roles from memberships / tenants.user_id", () => {
  it("exactly one Northwind Properties and one Beta Realty", async () => {
    const rows = await sql<{ name: string; n: number }>(
      `select name, count(*)::int as n from public.organizations
        where name in ('Northwind Properties', 'Beta Realty') group by name order by name`,
    );
    expect(rows).toEqual([
      { name: "Beta Realty", n: 1 },
      { name: "Northwind Properties", n: 1 },
    ]);
  });

  it("each account has exactly the brief's role in the brief's org (one row each)", async () => {
    const acc = await accounts();
    expect(acc.size).toBe(7);
    const expected: Record<string, Omit<UserRole, "email" | "user_id">> = {
      "manager@northwind.test": { m_org: northwindId, m_role: "manager", t_org: null, t_name: null },
      "staff@northwind.test": { m_org: northwindId, m_role: "staff", t_org: null, t_name: null },
      "aisyah@northwind.test": { m_org: null, m_role: null, t_org: northwindId, t_name: "Aisyah Rahman" },
      "ben@northwind.test": { m_org: null, m_role: null, t_org: northwindId, t_name: "Ben Lim" },
      "probe@northwind.test": { m_org: null, m_role: null, t_org: northwindId, t_name: "Probe Tenant" },
      "manager@beta.test": { m_org: betaId, m_role: "manager", t_org: null, t_name: null },
      "chen@beta.test": { m_org: null, m_role: null, t_org: betaId, t_name: "Chen Wei" },
    };
    for (const [email, want] of Object.entries(expected)) {
      const got = acc.get(email);
      expect(got, email).toBeDefined();
      const { m_org, m_role, t_org, t_name } = got!;
      expect({ m_org, m_role, t_org, t_name }, email).toEqual(want);
    }
  });

  it("roles never come from user_metadata: no seeded account carries a role/org claim there", async () => {
    const rows = await sql<{ email: string; meta: Record<string, unknown> | null }>(
      "select lower(email) as email, raw_user_meta_data as meta from auth.users where lower(email) = any($1)",
      [Object.values(SEEDED)],
    );
    for (const r of rows) {
      const keys = Object.keys(r.meta ?? {});
      expect(keys.filter((k) => /role|org/i.test(k)), r.email).toEqual([]);
    }
  });

  it("all seven accounts sign in with the one shared password", async () => {
    for (const email of Object.values(SEEDED)) {
      const s = await signIn(email, SEED_PASSWORD);
      expect(s.accessToken.length, email).toBeGreaterThan(20);
    }
  });
});

describe("R8 seed: units and leases with the brief's dates, rent and deposit", () => {
  it("Northwind units A-12-3, B-05-1, C-01-7, D-03-2; Beta unit KL-1; D-03-2 has no lease", async () => {
    const units = await sql<{ org_id: string; name: string; leases: number }>(
      `select u.org_id, u.name, (select count(*)::int from public.leases l where l.unit_id = u.id) as leases
         from public.units u where u.org_id = any($1) order by u.name`,
      [[northwindId, betaId]],
    );
    expect(units.map((u) => [u.org_id === northwindId ? "NW" : "BETA", u.name])).toEqual([
      ["NW", "A-12-3"],
      ["NW", "B-05-1"],
      ["NW", "C-01-7"],
      ["NW", "D-03-2"],
      ["BETA", "KL-1"],
    ]);
    expect(units.find((u) => u.name === "D-03-2")!.leases).toBe(0);
  });

  const LEASES = [
    { unit: "A-12-3", tenant: "Aisyah Rahman", org: "NW", startDate: "2026-01-31", endDate: "2026-07-15", monthlyRentSen: 150000, depositSen: 300000 },
    { unit: "B-05-1", tenant: "Ben Lim", org: "NW", startDate: "2026-01-01", endDate: "2026-04-15", monthlyRentSen: 100029, depositSen: 0 },
    { unit: "C-01-7", tenant: "Probe Tenant", org: "NW", startDate: "2026-02-28", endDate: "2027-02-27", monthlyRentSen: 200000, depositSen: 400000 },
    { unit: "KL-1", tenant: "Chen Wei", org: "BETA", startDate: "2026-03-15", endDate: "2027-03-14", monthlyRentSen: 220000, depositSen: 440000 },
  ];

  it("exactly four leases, each matching the brief", async () => {
    const rows = await sql<{
      id: string;
      org_id: string;
      unit: string;
      tenant: string;
      start_date: string;
      end_date: string;
      monthly_rent_sen: number;
      deposit_sen: number;
    }>(
      `select l.id, l.org_id, u.name as unit, t.full_name as tenant, l.start_date, l.end_date,
              l.monthly_rent_sen, l.deposit_sen
         from public.leases l join public.units u on u.id = l.unit_id join public.tenants t on t.id = l.tenant_id
        where l.org_id = any($1) order by u.name`,
      [[northwindId, betaId]],
    );
    expect(
      rows.map((r) => ({
        unit: r.unit,
        tenant: r.tenant,
        org: r.org_id === northwindId ? "NW" : "BETA",
        startDate: r.start_date,
        endDate: r.end_date,
        monthlyRentSen: r.monthly_rent_sen,
        depositSen: r.deposit_sen,
      })),
    ).toEqual(LEASES);
  });

  it.each(LEASES)("$unit: stored invoices == generateSchedule (order, kinds, periods, amounts)", async (l) => {
    const rows = await sql<{
      kind: string;
      period_index: number | null;
      period_start: string | null;
      period_end: string | null;
      due_date: string;
      amount_sen: number;
    }>(
      `select i.kind, i.period_index, i.period_start, i.period_end, i.due_date, i.amount_sen
         from public.invoices i join public.leases le on le.id = i.lease_id join public.units u on u.id = le.unit_id
        where u.name = $1 and le.org_id = any($2)
        order by i.due_date, (i.kind = 'rent'), i.period_index nulls first`,
      [l.unit, [northwindId, betaId]],
    );
    const stored = rows.map((r) => ({
      kind: r.kind,
      periodIndex: r.period_index,
      periodStart: r.period_start,
      periodEnd: r.period_end,
      dueDate: r.due_date,
      amountSen: r.amount_sen,
    }));
    expect(stored).toEqual(generateSchedule(l));
  });
});

describe("R9 R25 R26 R44 seed: Aisyah's two approved payments, the slip, allocations and audit rows", () => {
  let leaseId: string;
  let managerId: string;
  let staffId: string;

  beforeAll(async () => {
    const [l] = await sql<{ id: string }>(
      `select l.id from public.leases l join public.units u on u.id = l.unit_id
        where u.name = 'A-12-3' and l.org_id = $1`,
      [northwindId],
    );
    leaseId = l.id;
    const acc = await accounts();
    managerId = acc.get("manager@northwind.test")!.user_id;
    staffId = acc.get("staff@northwind.test")!.user_id;
  });

  async function manualPayments() {
    return sql<{
      id: string;
      method: string;
      amount_sen: number;
      unapplied_sen: number;
      status: string;
      received_at: Date;
      slip_path: string | null;
      recorded_by: string;
      decided_by: string;
    }>(
      `select id, method, amount_sen, unapplied_sen, status, received_at, slip_path, recorded_by, decided_by
         from public.payments where lease_id = $1 and method in ('cash', 'bank_transfer') order by received_at`,
      [leaseId],
    );
  }

  it("cash 300000 received 2026-01-31 10:00 MYT by the manager, approved immediately", async () => {
    const [cash] = await manualPayments();
    expect(cash).toMatchObject({
      method: "cash",
      amount_sen: 300000,
      unapplied_sen: 0,
      status: "approved",
      slip_path: null,
      recorded_by: managerId,
      decided_by: managerId,
    });
    expect(cash.received_at.toISOString()).toBe("2026-01-31T02:00:00.000Z");
  });

  it("bank transfer 200000 received 2026-03-01 00:30 MYT by staff with a slip, approved by the manager", async () => {
    const pays = await manualPayments();
    expect(pays).toHaveLength(2);
    const transfer = pays[1];
    expect(transfer).toMatchObject({
      method: "bank_transfer",
      amount_sen: 200000,
      unapplied_sen: 0,
      status: "approved",
      recorded_by: staffId,
      decided_by: managerId,
    });
    expect(transfer.received_at.toISOString()).toBe("2026-02-28T16:30:00.000Z");
    expect(transfer.slip_path).toMatch(new RegExp(`^${northwindId}/${leaseId}/[0-9a-f-]{36}\\.(pdf|png|jpe?g)$`));
    const obj = await sql<{ mime: string | null }>(
      "select metadata->>'mimetype' as mime from storage.objects where bucket_id = 'payment-slips' and name = $1",
      [transfer.slip_path],
    );
    expect(obj).toHaveLength(1);
    expect(["application/pdf", "image/png", "image/jpeg"]).toContain(obj[0].mime);
  });

  it("allocations (R26): cash fills the deposit; the transfer fills period 0 and 50000 of period 1", async () => {
    const [cash, transfer] = await manualPayments();
    const rows = await sql<{ payment_id: string; kind: string; period_index: number | null; amount_sen: number }>(
      `select a.payment_id, i.kind, i.period_index, a.amount_sen
         from public.payment_allocations a join public.invoices i on i.id = a.invoice_id
        where a.payment_id = any($1) order by i.due_date, (i.kind = 'rent'), i.period_index nulls first`,
      [[cash.id, transfer.id]],
    );
    expect(rows).toEqual([
      { payment_id: cash.id, kind: "deposit", period_index: null, amount_sen: 300000 },
      { payment_id: transfer.id, kind: "rent", period_index: 0, amount_sen: 150000 },
      { payment_id: transfer.id, kind: "rent", period_index: 1, amount_sen: 50000 },
    ]);
  });

  it("audit_log: lease.created x4 (one per seeded lease), payment.approved for both payments by the manager", async () => {
    const created = await sql<{ entity_id: string }>(
      "select entity_id from public.audit_log where action = 'lease.created' and org_id = any($1)",
      [[northwindId, betaId]],
    );
    const leaseIds = await sql<{ id: string }>("select id from public.leases where org_id = any($1)", [[northwindId, betaId]]);
    expect(created.map((r) => r.entity_id).sort()).toEqual(leaseIds.map((r) => r.id).sort());

    const [cash, transfer] = await manualPayments();
    for (const p of [cash, transfer]) {
      const rows = await sql<{ actor_id: string; org_id: string }>(
        "select actor_id, org_id from public.audit_log where action = 'payment.approved' and entity_id = $1",
        [p.id],
      );
      expect(rows, p.method).toEqual([{ actor_id: managerId, org_id: northwindId }]);
    }
  });
});
