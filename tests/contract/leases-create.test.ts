import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateSchedule } from "@/lib/billing";
import { errorBody, idBody } from "../helpers/contract";
import { closePool, sql } from "../helpers/db";
import { createFixtureOrg, insertUnit, type FixtureOrg } from "../helpers/fixtures";
import { api } from "../helpers/http";
import { seeded } from "../helpers/seeded";

// POST /api/leases (SPEC Contracts): manager only, 201 { id }, 400 invalid input, 409 overlap.
// Every mutation happens in a fresh fixture org; seeded data is only read (another org's unit id).

let fx: FixtureOrg;

interface InvoiceRow {
  kind: string;
  period_index: number | null;
  period_start: string | null;
  period_end: string | null;
  due_date: string;
  amount_sen: number;
}

async function storedInvoices(leaseId: string) {
  const rows = await sql<InvoiceRow>(
    `select kind, period_index, period_start, period_end, due_date, amount_sen
       from public.invoices where lease_id = $1
      order by due_date, (kind = 'rent'), period_index nulls first`,
    [leaseId],
  );
  return rows.map((r) => ({
    kind: r.kind,
    periodIndex: r.period_index,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    dueDate: r.due_date,
    amountSen: r.amount_sen,
  }));
}

async function leaseCount(orgId: string): Promise<number> {
  const r = await sql<{ n: number }>("select count(*)::int as n from public.leases where org_id = $1", [orgId]);
  return r[0].n;
}

function body(unitId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    unitId,
    tenantId: fx.tenantAId,
    startDate: "2026-01-31",
    endDate: "2026-07-15",
    monthlyRentSen: 150000,
    depositSen: 300000,
    ...over,
  };
}

beforeAll(async () => {
  fx = await createFixtureOrg({ units: 4 });
});

afterAll(async () => {
  await closePool();
});

describe("R45 R46 R10 R25 POST /api/leases: 201 { id } and exactly generateSchedule's invoices", () => {
  it("manager creates the brief's Aisyah lease: 201 with exactly { id }, invoices == generateSchedule, audit row", async () => {
    const input = body(fx.unitIds[0]);
    const res = await api(fx.tokens.manager).post("/api/leases", input);
    expect(res.status).toBe(201);
    const { id } = idBody.parse(res.body);

    const [lease] = await sql<{
      org_id: string;
      unit_id: string;
      tenant_id: string;
      start_date: string;
      end_date: string;
      monthly_rent_sen: number;
      deposit_sen: number;
    }>(
      "select org_id, unit_id, tenant_id, start_date, end_date, monthly_rent_sen, deposit_sen from public.leases where id = $1",
      [id],
    );
    expect(lease).toEqual({
      org_id: fx.orgId,
      unit_id: fx.unitIds[0],
      tenant_id: fx.tenantAId,
      start_date: "2026-01-31",
      end_date: "2026-07-15",
      monthly_rent_sen: 150000,
      deposit_sen: 300000,
    });

    const expected = generateSchedule({ startDate: "2026-01-31", endDate: "2026-07-15", monthlyRentSen: 150000, depositSen: 300000 });
    expect(await storedInvoices(id)).toEqual(expected);
    // Brief worked example: period 5 of this lease is 77419 sen.
    expect(expected.find((i) => i.periodIndex === 5)?.amountSen).toBe(77419);

    const audit = await sql<{ actor_id: string; org_id: string }>(
      "select actor_id, org_id from public.audit_log where action = 'lease.created' and entity_id = $1",
      [id],
    );
    expect(audit).toEqual([{ actor_id: fx.users.manager.userId, org_id: fx.orgId }]);
  });

  it("no deposit: no deposit invoice; start == end: one 1-day prorated period", async () => {
    const r1 = await api(fx.tokens.manager).post(
      "/api/leases",
      body(fx.unitIds[1], { startDate: "2026-01-01", endDate: "2026-04-15", monthlyRentSen: 100029, depositSen: 0 }),
    );
    expect(r1.status).toBe(201);
    const { id: benLike } = idBody.parse(r1.body);
    const s1 = generateSchedule({ startDate: "2026-01-01", endDate: "2026-04-15", monthlyRentSen: 100029, depositSen: 0 });
    expect(s1.some((i) => i.kind === "deposit")).toBe(false);
    expect(await storedInvoices(benLike)).toEqual(s1);

    const r2 = await api(fx.tokens.manager).post(
      "/api/leases",
      body(fx.unitIds[1], { startDate: "2027-01-10", endDate: "2027-01-10", monthlyRentSen: 310000, depositSen: 1 }),
    );
    expect(r2.status).toBe(201);
    const { id: oneDay } = idBody.parse(r2.body);
    expect(await storedInvoices(oneDay)).toEqual(
      generateSchedule({ startDate: "2027-01-10", endDate: "2027-01-10", monthlyRentSen: 310000, depositSen: 1 }),
    );
  });
});

describe("R45 R11 POST /api/leases: 400 invalid input, nothing stored", () => {
  const cases: Array<[string, Record<string, unknown> | string]> = [
    ["malformed JSON", "{not json"],
    ["JSON array", "[]"],
    ["JSON null", "null"],
    ["unknown key", { extra: 1 }],
    ["orgId smuggled in (strict)", { orgId: "00000000-0000-0000-0000-000000000000" }],
    ["unitId not a uuid", { unitId: "unit-1" }],
    ["tenantId missing", { tenantId: undefined }],
    ["startDate not a real date (2026-02-30)", { startDate: "2026-02-30" }],
    ["startDate not zero-padded (2026-2-01)", { startDate: "2026-2-01" }],
    ["endDate with a time part", { endDate: "2026-07-15T00:00:00Z" }],
    ["endDate 2026-13-01", { endDate: "2026-13-01" }],
    ["endDate before startDate", { startDate: "2026-03-01", endDate: "2026-02-28" }],
    ["monthlyRentSen 0", { monthlyRentSen: 0 }],
    ["monthlyRentSen negative", { monthlyRentSen: -150000 }],
    ["monthlyRentSen fractional", { monthlyRentSen: 1500.5 }],
    ["monthlyRentSen as a string", { monthlyRentSen: "150000" }],
    ["monthlyRentSen beyond safe integer", { monthlyRentSen: 2 ** 53 }],
    ["depositSen negative", { depositSen: -1 }],
    ["depositSen fractional", { depositSen: 0.5 }],
    ["depositSen missing", { depositSen: undefined }],
  ];

  it.each(cases)("%s -> 400 { error }", async (_label, over) => {
    const before = await leaseCount(fx.orgId);
    const payload = typeof over === "string" ? over : body(fx.unitIds[2], over);
    const res = await api(fx.tokens.manager).post("/api/leases", payload);
    expect(res.status).toBe(400);
    errorBody.parse(res.body);
    expect(await leaseCount(fx.orgId)).toBe(before);
  });
});

describe("R46 POST /api/leases: 409 when the unit already has an overlapping lease (both dates inclusive)", () => {
  let unitId: string;

  beforeAll(async () => {
    unitId = await insertUnit(fx.orgId);
    const res = await api(fx.tokens.manager).post(
      "/api/leases",
      body(unitId, { startDate: "2026-03-01", endDate: "2026-05-31", depositSen: 0 }),
    );
    expect(res.status).toBe(201);
  });

  it.each([
    ["starts on the existing end date", "2026-05-31", "2026-08-31"],
    ["ends on the existing start date", "2026-01-01", "2026-03-01"],
    ["contained inside", "2026-04-01", "2026-04-10"],
    ["covers it", "2025-12-01", "2026-12-31"],
  ])("%s -> 409 { error }, no lease or invoice written", async (_l, startDate, endDate) => {
    const before = await leaseCount(fx.orgId);
    const res = await api(fx.tokens.manager).post("/api/leases", body(unitId, { startDate, endDate, depositSen: 0 }));
    expect(res.status).toBe(409);
    errorBody.parse(res.body);
    expect(await leaseCount(fx.orgId)).toBe(before);
  });

  it("the next day after the existing end date is free -> 201", async () => {
    const res = await api(fx.tokens.manager).post(
      "/api/leases",
      body(unitId, { startDate: "2026-06-01", endDate: "2026-06-30", depositSen: 0 }),
    );
    expect(res.status).toBe(201);
    idBody.parse(res.body);
  });

  it("the same dates on a different unit do not overlap -> 201", async () => {
    const other = await insertUnit(fx.orgId);
    const res = await api(fx.tokens.manager).post(
      "/api/leases",
      body(other, { startDate: "2026-03-01", endDate: "2026-05-31", depositSen: 0 }),
    );
    expect(res.status).toBe(201);
  });
});

describe("R38 R39 POST /api/leases: 401 / 403 / 404 per the error contract", () => {
  it("no token -> 401 { error }", async () => {
    const res = await api().post("/api/leases", body(fx.unitIds[3]));
    expect(res.status).toBe(401);
    errorBody.parse(res.body);
  });

  it("garbage bearer token -> 401 { error }", async () => {
    const res = await api("not-a-jwt").post("/api/leases", body(fx.unitIds[3]));
    expect(res.status).toBe(401);
    errorBody.parse(res.body);
  });

  it.each(["staff", "tenantA"] as const)("%s -> 403 { error } (even with a malformed body)", async (role) => {
    const before = await leaseCount(fx.orgId);
    for (const payload of [body(fx.unitIds[3]), "{bad"]) {
      const res = await api(fx.tokens[role]).post("/api/leases", payload);
      expect(res.status).toBe(403);
      errorBody.parse(res.body);
    }
    expect(await leaseCount(fx.orgId)).toBe(before);
  });

  it("manager names another org's unit (seeded D-03-2) -> 404, nothing created there", async () => {
    const [unit] = await sql<{ id: string }>(
      `select u.id from public.units u join public.organizations o on o.id = u.org_id
        where o.name = 'Northwind Properties' and u.name = 'D-03-2'`,
    );
    const res = await api(fx.tokens.manager).post("/api/leases", body(unit.id));
    expect(res.status).toBe(404);
    errorBody.parse(res.body);
    const leases = await sql("select 1 from public.leases where unit_id = $1", [unit.id]);
    expect(leases).toHaveLength(0);
  });

  it("manager names another org's tenant -> 404", async () => {
    const [tenant] = await sql<{ id: string }>(
      "select t.id from public.tenants t where lower(t.email) = 'chen@beta.test'",
    );
    const res = await api(fx.tokens.manager).post("/api/leases", body(fx.unitIds[3], { tenantId: tenant.id }));
    expect(res.status).toBe(404);
    errorBody.parse(res.body);
  });

  it("another org's manager cannot create a lease on the fixture's unit -> 404", async () => {
    const beta = await seeded("betaManager");
    const res = await api(beta.accessToken).post("/api/leases", body(fx.unitIds[3]));
    expect(res.status).toBe(404);
    errorBody.parse(res.body);
  });
});
