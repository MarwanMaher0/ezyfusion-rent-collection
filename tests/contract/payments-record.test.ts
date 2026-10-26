import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { errorBody, recordPaymentBody, uploadSlip } from "../helpers/contract";
import { closePool, sql } from "../helpers/db";
import { createFixtureOrg, insertLease, type FixtureLease, type FixtureOrg, type LeaseInput } from "../helpers/fixtures";
import { api } from "../helpers/http";
import { seeded } from "../helpers/seeded";

// POST /api/leases/:leaseId/payments (SPEC Contracts): staff, manager; 201 { id, status }; 400 invalid
// input; 422 over the cap (R22: remaining balance minus the lease's pending payments).

// Total = deposit 50000 + 3 full periods x 100000 = 350000 sen.
const LEASE: LeaseInput = { startDate: "2026-01-01", endDate: "2026-03-31", monthlyRentSen: 100000, depositSen: 50000 };
const TOTAL = 350000;

let fx: FixtureOrg;
let lease: FixtureLease;

function total(l: FixtureLease): number {
  return l.invoices.reduce((s, i) => s + i.amountSen, 0);
}

async function paymentCount(leaseId: string): Promise<number> {
  const r = await sql<{ n: number }>("select count(*)::int as n from public.payments where lease_id = $1", [leaseId]);
  return r[0].n;
}

async function objectExists(name: string): Promise<boolean> {
  const r = await sql("select 1 from storage.objects where bucket_id = 'payment-slips' and name = $1", [name]);
  return r.length === 1;
}

async function newLease(unitIndex: number, tenant: "A" | "B" = "B"): Promise<FixtureLease> {
  return insertLease(fx.orgId, fx.unitIds[unitIndex], tenant === "A" ? fx.tenantAId : fx.tenantBId, LEASE, fx.users.manager.userId);
}

const cash = (amountSen: number, over: Record<string, unknown> = {}) => ({
  amountSen,
  method: "cash",
  receivedAt: "2026-02-01T10:00:00+08:00",
  ...over,
});

beforeAll(async () => {
  fx = await createFixtureOrg({ units: 6, lease: LEASE });
  lease = fx.lease!;
  expect(total(lease)).toBe(TOTAL);
});

afterAll(async () => {
  await closePool();
});

describe("R19 R21 R45 POST /api/leases/:leaseId/payments: 201 { id, status }", () => {
  it("manager cash -> 201 { id, status: 'approved' } exact keys, row stored as sent", async () => {
    const res = await api(fx.tokens.manager).post(`/api/leases/${lease.id}/payments`, cash(1000));
    expect(res.status).toBe(201);
    const body = recordPaymentBody.parse(res.body);
    expect(body.status).toBe("approved");
    const [row] = await sql<{ amount_sen: number; method: string; status: string; received_at: Date; recorded_by: string; org_id: string }>(
      "select amount_sen, method, status, received_at, recorded_by, org_id from public.payments where id = $1",
      [body.id],
    );
    expect(row.amount_sen).toBe(1000);
    expect(row.method).toBe("cash");
    expect(row.status).toBe("approved");
    expect(row.received_at.toISOString()).toBe("2026-02-01T02:00:00.000Z");
    expect(row.recorded_by).toBe(fx.users.manager.userId);
    expect(row.org_id).toBe(fx.orgId);
  });

  it("staff cash -> 201 { status: 'pending_verification' }, no allocations yet", async () => {
    const res = await api(fx.tokens.staff).post(`/api/leases/${lease.id}/payments`, cash(1000, { receivedAt: "2026-02-01T02:00:00Z" }));
    expect(res.status).toBe(201);
    const body = recordPaymentBody.parse(res.body);
    expect(body.status).toBe("pending_verification");
    const alloc = await sql("select 1 from public.payment_allocations where payment_id = $1", [body.id]);
    expect(alloc).toHaveLength(0);
  });

  it("staff bank_transfer with an uploaded slip in the org folder -> 201 pending, slip_path stored", async () => {
    const slip = await uploadSlip(fx.tokens.staff, fx.orgId, lease.id);
    const res = await api(fx.tokens.staff).post(`/api/leases/${lease.id}/payments`, {
      amountSen: 1000,
      method: "bank_transfer",
      receivedAt: "2026-02-01T10:00:00+08:00",
      slipPath: slip,
    });
    expect(res.status).toBe(201);
    const body = recordPaymentBody.parse(res.body);
    expect(body.status).toBe("pending_verification");
    const [row] = await sql<{ slip_path: string }>("select slip_path from public.payments where id = $1", [body.id]);
    expect(row.slip_path).toBe(slip);
  });
});

describe("R45 R19 R20 POST /api/leases/:leaseId/payments: 400 invalid input, nothing stored", () => {
  let validSlip: string;

  beforeAll(async () => {
    validSlip = await uploadSlip(fx.tokens.staff, fx.orgId, lease.id);
  });

  const cases: Array<[string, () => Record<string, unknown> | string]> = [
    ["malformed JSON", () => "{amountSen:"],
    ["JSON array", () => "[1]"],
    ["amountSen missing", () => cash(1000, { amountSen: undefined })],
    ["method missing", () => cash(1000, { method: undefined })],
    ["receivedAt missing", () => cash(1000, { receivedAt: undefined })],
    ["amountSen 0", () => cash(0)],
    ["amountSen negative", () => cash(-100)],
    ["amountSen fractional", () => cash(10.5)],
    ["amountSen as a ringgit string", () => cash(1000, { amountSen: "10.00" })],
    ["method 'online' (only the webhook creates online payments)", () => cash(1000, { method: "online" })],
    ["method unknown", () => cash(1000, { method: "cheque" })],
    ["receivedAt without an offset", () => cash(1000, { receivedAt: "2026-02-01T10:00:00" })],
    ["receivedAt date only", () => cash(1000, { receivedAt: "2026-02-01" })],
    ["receivedAt not a real date", () => cash(1000, { receivedAt: "2026-02-30T10:00:00+08:00" })],
    ["receivedAt garbage", () => cash(1000, { receivedAt: "yesterday" })],
    ["unknown key", () => cash(1000, { status: "approved" })],
    ["idempotencyKey in the body (strict)", () => cash(1000, { idempotencyKey: randomUUID() })],
    ["cash with a slipPath", () => cash(1000, { slipPath: validSlip })],
    ["bank_transfer without a slip", () => cash(1000, { method: "bank_transfer" })],
    [
      "bank_transfer with a slip that does not exist",
      () => cash(1000, { method: "bank_transfer", slipPath: `${fx.orgId}/${lease.id}/${randomUUID()}.pdf` }),
    ],
    [
      "bank_transfer with a slip path outside the org folder",
      () => cash(1000, { method: "bank_transfer", slipPath: `${randomUUID()}/${lease.id}/${randomUUID()}.pdf` }),
    ],
    [
      "bank_transfer with a traversal slip path",
      () => cash(1000, { method: "bank_transfer", slipPath: `${fx.orgId}/../${randomUUID()}.pdf` }),
    ],
  ];

  it.each(cases)("%s -> 400 { error }", async (_label, make) => {
    const before = await paymentCount(lease.id);
    for (const token of [fx.tokens.manager, fx.tokens.staff]) {
      const res = await api(token).post(`/api/leases/${lease.id}/payments`, make());
      expect(res.status).toBe(400);
      errorBody.parse(res.body);
    }
    expect(await paymentCount(lease.id)).toBe(before);
  });

  it("a slip already attached to another payment -> 400 (D39), slip kept for the first payment", async () => {
    const slip = await uploadSlip(fx.tokens.staff, fx.orgId, lease.id);
    const first = await api(fx.tokens.staff).post(`/api/leases/${lease.id}/payments`, cash(500, { method: "bank_transfer", slipPath: slip }));
    expect(first.status).toBe(201);
    const second = await api(fx.tokens.staff).post(`/api/leases/${lease.id}/payments`, cash(600, { method: "bank_transfer", slipPath: slip }));
    expect(second.status).toBe(400);
    errorBody.parse(second.body);
    expect(await objectExists(slip)).toBe(true);
  });
});

describe("R22 POST /api/leases/:leaseId/payments: 422 over the cap (cap includes pending payments)", () => {
  it("amount = remaining + 1 -> 422 { error }; amount = remaining -> 201 (advance payment allowed)", async () => {
    const l = await newLease(1);
    const over = await api(fx.tokens.manager).post(`/api/leases/${l.id}/payments`, cash(TOTAL + 1));
    expect(over.status).toBe(422);
    errorBody.parse(over.body);
    expect(await paymentCount(l.id)).toBe(0);

    // The whole lease, including invoices not yet due, is the cap.
    const exact = await api(fx.tokens.manager).post(`/api/leases/${l.id}/payments`, cash(TOTAL));
    expect(exact.status).toBe(201);
    const after = await api(fx.tokens.manager).post(`/api/leases/${l.id}/payments`, cash(1));
    expect(after.status).toBe(422);
    errorBody.parse(after.body);
  });

  it("a staff pending payment reduces the cap for everyone: remaining - pending + 1 -> 422, remaining - pending -> 201", async () => {
    const l = await newLease(2);
    const pending = await api(fx.tokens.staff).post(`/api/leases/${l.id}/payments`, cash(100000));
    expect(pending.status).toBe(201);
    expect(recordPaymentBody.parse(pending.body).status).toBe("pending_verification");

    for (const token of [fx.tokens.manager, fx.tokens.staff]) {
      const r = await api(token).post(`/api/leases/${l.id}/payments`, cash(TOTAL - 100000 + 1));
      expect(r.status).toBe(422);
      errorBody.parse(r.body);
    }
    const ok = await api(fx.tokens.manager).post(`/api/leases/${l.id}/payments`, cash(TOTAL - 100000));
    expect(ok.status).toBe(201);
    expect(recordPaymentBody.parse(ok.body).status).toBe("approved");
  });

  it("approved payments reduce the cap; a rejected pending payment gives it back", async () => {
    const l = await newLease(3);
    const paid = await api(fx.tokens.manager).post(`/api/leases/${l.id}/payments`, cash(200000));
    expect(paid.status).toBe(201);
    const pending = await api(fx.tokens.staff).post(`/api/leases/${l.id}/payments`, cash(150000));
    expect(pending.status).toBe(201);
    const full = await api(fx.tokens.staff).post(`/api/leases/${l.id}/payments`, cash(1));
    expect(full.status).toBe(422);

    const { id } = recordPaymentBody.parse(pending.body);
    const rej = await api(fx.tokens.manager).post(`/api/payments/${id}/reject`, { reason: "Duplicate entry" });
    expect(rej.status).toBe(200);
    const again = await api(fx.tokens.staff).post(`/api/leases/${l.id}/payments`, cash(150000));
    expect(again.status).toBe(201);
  });

  it("R20: a bank transfer refused with 422 leaves no slip behind", async () => {
    const l = await newLease(4);
    const slip = await uploadSlip(fx.tokens.staff, fx.orgId, l.id);
    expect(await objectExists(slip)).toBe(true);
    const r = await api(fx.tokens.staff).post(`/api/leases/${l.id}/payments`, cash(TOTAL + 1, { method: "bank_transfer", slipPath: slip }));
    expect(r.status).toBe(422);
    errorBody.parse(r.body);
    expect(await objectExists(slip)).toBe(false);
  });
});

describe("R38 POST /api/leases/:leaseId/payments: 401 / 403 / 404", () => {
  it("no token -> 401; the lease's tenant -> 403; other tenant -> 404; another org's manager -> 404; bad ids -> 404", async () => {
    const before = await paymentCount(lease.id);
    const path = `/api/leases/${lease.id}/payments`;

    const anon = await api().post(path, cash(100));
    expect(anon.status).toBe(401);
    errorBody.parse(anon.body);

    const own = await api(fx.tokens.tenantA).post(path, cash(100));
    expect(own.status).toBe(403);
    errorBody.parse(own.body);

    const other = await api(fx.tokens.tenantB).post(path, cash(100));
    expect(other.status).toBe(404);
    errorBody.parse(other.body);

    const beta = await seeded("betaManager");
    const cross = await api(beta.accessToken).post(path, cash(100));
    expect(cross.status).toBe(404);
    errorBody.parse(cross.body);

    for (const id of ["nope", randomUUID()]) {
      const r = await api(fx.tokens.manager).post(`/api/leases/${id}/payments`, cash(100));
      expect(r.status).toBe(404);
      errorBody.parse(r.body);
    }
    expect(await paymentCount(lease.id)).toBe(before);
  });
});
