import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { invoiceStatus } from "@/lib/billing";
import { errorBody, leaseDetail, recordPaymentBody, type LeaseDetailBody } from "../helpers/contract";
import { closePool, sql } from "../helpers/db";
import { createFixtureOrg, type FixtureOrg } from "../helpers/fixtures";
import { api } from "../helpers/http";
import { seeded } from "../helpers/seeded";

// GET /api/leases/:leaseId (SPEC Contracts): staff, manager, the lease's tenant; exact shape; invoices in
// allocation order (due date, deposit before rent, period index); statuses == invoiceStatus(now).
// The route has no asOf input, so each status is checked against invoiceStatus at the instants just
// before and just after the request (equal unless a Malaysia midnight falls inside the request).

let fx: FixtureOrg;
let northwindAisyahLeaseId: string;

function inAllocationOrder(inv: LeaseDetailBody["invoices"]): boolean {
  for (let i = 1; i < inv.length; i++) {
    const a = inv[i - 1];
    const b = inv[i];
    const key = (x: typeof a) => [x.dueDate, x.kind === "deposit" ? 0 : 1, x.periodIndex ?? -1] as const;
    const [ad, ak, ap] = key(a);
    const [bd, bk, bp] = key(b);
    if (ad > bd || (ad === bd && (ak > bk || (ak === bk && ap >= bp)))) return false;
  }
  return true;
}

async function getDetail(token: string, leaseId: string) {
  const t0 = new Date();
  const res = await api(token).get(`/api/leases/${leaseId}`);
  const t1 = new Date();
  return { res, t0, t1 };
}

function expectStatuses(body: LeaseDetailBody, t0: Date, t1: Date): void {
  for (const inv of body.invoices) {
    const allowed = new Set([invoiceStatus(inv, t0), invoiceStatus(inv, t1)]);
    expect(allowed.has(inv.status), `${inv.kind} ${inv.periodIndex} due ${inv.dueDate}: ${inv.status}`).toBe(true);
  }
}

async function allocatedByInvoice(leaseId: string): Promise<Map<string, number>> {
  const rows = await sql<{ invoice_id: string; s: number }>(
    "select invoice_id, sum(amount_sen)::bigint as s from public.payment_allocations where lease_id = $1 group by 1",
    [leaseId],
  );
  return new Map(rows.map((r) => [r.invoice_id, r.s]));
}

beforeAll(async () => {
  // Lease spanning the past and the future relative to any run date in 2026-2027: past invoices are
  // overdue or paid, later ones unpaid.
  fx = await createFixtureOrg({
    lease: { startDate: "2026-01-31", endDate: "2027-12-15", monthlyRentSen: 100001, depositSen: 50000 },
  });
  const [row] = await sql<{ id: string }>(
    `select l.id from public.leases l join public.tenants t on t.id = l.tenant_id
      where lower(t.email) = 'aisyah@northwind.test'`,
  );
  northwindAisyahLeaseId = row.id;
});

afterAll(async () => {
  await closePool();
});

describe("R45 R27 R17 R16 GET /api/leases/:leaseId: exact shape, allocation order, computed statuses", () => {
  it("fixture lease, no payments: invoices == the stored schedule, every paidSen 0, payments []", async () => {
    const lease = fx.lease!;
    const { res, t0, t1 } = await getDetail(fx.tokens.staff, lease.id);
    expect(res.status).toBe(200);
    const body = leaseDetail.parse(res.body);
    expect(body.lease).toEqual({
      id: lease.id,
      unitId: lease.unitId,
      tenantId: lease.tenantId,
      startDate: "2026-01-31",
      endDate: "2027-12-15",
      monthlyRentSen: 100001,
      depositSen: 50000,
    });
    expect(body.invoices.map(({ id, kind, periodIndex, periodStart, periodEnd, dueDate, amountSen }) => ({
      id, kind, periodIndex, periodStart, periodEnd, dueDate, amountSen,
    }))).toEqual(lease.invoices);
    expect(body.invoices.every((i) => i.paidSen === 0)).toBe(true);
    expect(inAllocationOrder(body.invoices)).toBe(true);
    expect(body.invoices[0].kind).toBe("deposit");
    expectStatuses(body, t0, t1);
    expect(body.payments).toEqual([]);
  });

  it("after a partial manager payment: deposit paid, period 0 partially paid/overdue, paidSen == allocations", async () => {
    const lease = fx.lease!;
    const pay = await api(fx.tokens.manager).post(`/api/leases/${lease.id}/payments`, {
      amountSen: 50000 + 40000,
      method: "cash",
      receivedAt: "2026-02-01T09:00:00+08:00",
    });
    expect(pay.status).toBe(201);
    const { id: paymentId } = recordPaymentBody.parse(pay.body);

    const { res, t0, t1 } = await getDetail(fx.tokens.manager, lease.id);
    expect(res.status).toBe(200);
    const body = leaseDetail.parse(res.body);
    expectStatuses(body, t0, t1);
    expect(inAllocationOrder(body.invoices)).toBe(true);

    const [deposit, p0, p1] = body.invoices;
    expect(deposit).toMatchObject({ kind: "deposit", paidSen: 50000, status: "paid" });
    expect(p0).toMatchObject({ kind: "rent", periodIndex: 0, paidSen: 40000 });
    // Due 2026-01-31: a partially paid invoice past its due date is overdue (R17 order).
    expect(p0.status).toBe("overdue");
    expect(p1.paidSen).toBe(0);

    const alloc = await allocatedByInvoice(lease.id);
    for (const inv of body.invoices) expect(inv.paidSen).toBe(alloc.get(inv.id) ?? 0);

    expect(body.payments).toEqual([
      {
        id: paymentId,
        amountSen: 90000,
        unappliedSen: 0,
        method: "cash",
        status: "approved",
        receivedAt: "2026-02-01T09:00:00+08:00",
      },
    ]);
  });

  it("the lease's own tenant reads it (200); the other tenant of the same org gets 404", async () => {
    const lease = fx.lease!;
    const own = await api(fx.tokens.tenantA).get(`/api/leases/${lease.id}`);
    expect(own.status).toBe(200);
    leaseDetail.parse(own.body);
    const other = await api(fx.tokens.tenantB).get(`/api/leases/${lease.id}`);
    expect(other.status).toBe(404);
    errorBody.parse(other.body);
  });

  it("401 without a token; 404 for a malformed id, an unknown id, and another org's manager", async () => {
    const lease = fx.lease!;
    const anon = await api().get(`/api/leases/${lease.id}`);
    expect(anon.status).toBe(401);
    errorBody.parse(anon.body);

    for (const id of ["not-a-uuid", "00000000-0000-4000-8000-000000000000"]) {
      const r = await api(fx.tokens.manager).get(`/api/leases/${id}`);
      expect(r.status).toBe(404);
      errorBody.parse(r.body);
    }
    const beta = await seeded("betaManager");
    const r = await api(beta.accessToken).get(`/api/leases/${lease.id}`);
    expect(r.status).toBe(404);
    errorBody.parse(r.body);
  });
});

describe("R45 R9 R26 GET /api/leases/:leaseId on the seeded Aisyah lease (read-only)", () => {
  it("manager, staff and Aisyah get the same body; seeded payments listed by id/method; paidSen == allocations", async () => {
    const seededPays = await sql<{ id: string; method: string; amount_sen: number }>(
      `select id, method, amount_sen from public.payments
        where lease_id = $1 and method in ('cash', 'bank_transfer') order by received_at`,
      [northwindAisyahLeaseId],
    );
    expect(seededPays.map((p) => [p.method, p.amount_sen])).toEqual([
      ["cash", 300000],
      ["bank_transfer", 200000],
    ]);

    const bodies: LeaseDetailBody[] = [];
    for (const key of ["northwindManager", "northwindStaff", "aisyah"] as const) {
      const s = await seeded(key);
      const { res, t0, t1 } = await getDetail(s.accessToken, northwindAisyahLeaseId);
      expect(res.status, key).toBe(200);
      const body = leaseDetail.parse(res.body);
      expectStatuses(body, t0, t1);
      expect(inAllocationOrder(body.invoices)).toBe(true);
      bodies.push(body);
    }
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);

    const body = bodies[0];
    expect(body.lease).toMatchObject({ startDate: "2026-01-31", endDate: "2026-07-15", monthlyRentSen: 150000, depositSen: 300000 });
    expect(body.invoices.find((i) => i.periodIndex === 5)?.amountSen).toBe(77419);
    expect(body.invoices[0]).toMatchObject({ kind: "deposit", amountSen: 300000, paidSen: 300000, status: "paid" });

    const cash = body.payments.find((p) => p.id === seededPays[0].id);
    const transfer = body.payments.find((p) => p.id === seededPays[1].id);
    expect(cash).toEqual({
      id: seededPays[0].id,
      amountSen: 300000,
      unappliedSen: 0,
      method: "cash",
      status: "approved",
      receivedAt: "2026-01-31T10:00:00+08:00",
    });
    expect(transfer).toEqual({
      id: seededPays[1].id,
      amountSen: 200000,
      unappliedSen: 0,
      method: "bank_transfer",
      status: "approved",
      receivedAt: "2026-03-01T00:30:00+08:00",
    });

    const alloc = await allocatedByInvoice(northwindAisyahLeaseId);
    for (const inv of body.invoices) expect(inv.paidSen).toBe(alloc.get(inv.id) ?? 0);
  });

  it("Ben (same org, other lease) and Chen (other org) get 404 for Aisyah's lease", async () => {
    for (const key of ["ben", "chen", "betaManager"] as const) {
      const s = await seeded(key);
      const r = await api(s.accessToken).get(`/api/leases/${northwindAisyahLeaseId}`);
      expect(r.status, key).toBe(404);
      errorBody.parse(r.body);
    }
  });
});
