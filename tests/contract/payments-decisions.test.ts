import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { errorBody, leaseDetail, recordPaymentBody, statusBody } from "../helpers/contract";
import { closePool, sql } from "../helpers/db";
import { createFixtureOrg, insertLease, type FixtureLease, type FixtureOrg, type LeaseInput } from "../helpers/fixtures";
import { api } from "../helpers/http";
import { seeded } from "../helpers/seeded";
import { mytAt } from "../helpers/time";

// POST /api/payments/:paymentId/{approve,reject,void} (SPEC Contracts): manager only; 200 { status };
// approve 409 not pending / 422 over the remaining balance; reject 400 reason / 409 not pending;
// void 400 reason / 409 not approved; void removes only that payment's allocations (R24, D14).

const LEASE: LeaseInput = { startDate: "2026-01-01", endDate: "2026-03-31", monthlyRentSen: 100000, depositSen: 50000 };
const TOTAL = 350000;

let fx: FixtureOrg;
let unitCursor = 0;

async function newLease(): Promise<FixtureLease> {
  unitCursor += 1;
  return insertLease(fx.orgId, fx.unitIds[unitCursor], fx.tenantAId, LEASE, fx.users.manager.userId);
}

async function record(token: string, leaseId: string, amountSen: number): Promise<string> {
  const r = await api(token).post(`/api/leases/${leaseId}/payments`, {
    amountSen,
    method: "cash",
    receivedAt: "2026-02-10T12:00:00+08:00",
  });
  expect(r.status).toBe(201);
  return recordPaymentBody.parse(r.body).id;
}

async function status(paymentId: string): Promise<string> {
  const [row] = await sql<{ status: string }>("select status from public.payments where id = $1", [paymentId]);
  return row.status;
}

async function allocations(paymentId: string) {
  return sql<{ id: string; invoice_id: string; amount_sen: number }>(
    "select id, invoice_id, amount_sen from public.payment_allocations where payment_id = $1 order by id",
    [paymentId],
  );
}

async function audit(action: string, entityId: string) {
  return sql<{ actor_id: string | null }>(
    "select actor_id from public.audit_log where action = $1 and entity_id = $2",
    [action, entityId],
  );
}

const post = (token: string, paymentId: string, action: "approve" | "reject" | "void", body?: unknown) =>
  api(token).post(`/api/payments/${paymentId}/${action}`, body);

beforeAll(async () => {
  fx = await createFixtureOrg({ units: 12 });
});

afterAll(async () => {
  await closePool();
});

describe("R23 R26 R25 POST /api/payments/:paymentId/approve", () => {
  it("manager approves a staff payment -> 200 { status: 'approved' } exact keys; allocated; audit row", async () => {
    const l = await newLease();
    const id = await record(fx.tokens.staff, l.id, 60000);
    const r = await post(fx.tokens.manager, id, "approve");
    expect(r.status).toBe(200);
    expect(statusBody.parse(r.body)).toEqual({ status: "approved" });
    // R26: deposit (50000) first, then period 0.
    const alloc = await allocations(id);
    expect(alloc.map((a) => a.amount_sen).sort((a, b) => b - a)).toEqual([50000, 10000]);
    expect(await audit("payment.approved", id)).toEqual([{ actor_id: fx.users.manager.userId }]);

    const again = await post(fx.tokens.manager, id, "approve");
    expect(again.status).toBe(409);
    errorBody.parse(again.body);
    expect(await allocations(id)).toHaveLength(2);
  });

  it("approve over the remaining balance -> 422 { error } and the payment stays pending, unallocated", async () => {
    const l = await newLease();
    const pendingId = await record(fx.tokens.staff, l.id, TOTAL);
    // An online payment (only the gateway can exceed the cap) settles what is due by 2026-02-15 MYT:
    // deposit 50000 + periods 0 and 1 = 250000, so only 100000 remains for the pending 350000.
    const [bill] = await sql<{ id: string; amount_sen: number }>(
      "select id, amount_sen from private.create_gateway_bill($1, $2, $3)",
      [fx.users.tenantA.userId, l.id, mytAt("2026-02-15", "12:00")],
    );
    expect(bill.amount_sen).toBe(250000);
    const [cb] = await sql<{ outcome: string }>(
      "select outcome from private.apply_gateway_callback($1, true, $2, $3, $4, 'completed')",
      [bill.id, bill.amount_sen, mytAt("2026-02-15", "12:05"), `TX-${randomUUID()}`],
    );
    expect(cb.outcome).toBe("paid");

    const r = await post(fx.tokens.manager, pendingId, "approve");
    expect(r.status).toBe(422);
    errorBody.parse(r.body);
    expect(await status(pendingId)).toBe("pending_verification");
    expect(await allocations(pendingId)).toHaveLength(0);
  });

  it("approve a rejected or voided payment -> 409", async () => {
    const l = await newLease();
    const rejected = await record(fx.tokens.staff, l.id, 1000);
    expect((await post(fx.tokens.manager, rejected, "reject", { reason: "Wrong lease" })).status).toBe(200);
    const voided = await record(fx.tokens.manager, l.id, 1000);
    expect((await post(fx.tokens.manager, voided, "void", { reason: "Bounced cheque" })).status).toBe(200);
    for (const id of [rejected, voided]) {
      const r = await post(fx.tokens.manager, id, "approve");
      expect(r.status).toBe(409);
      errorBody.parse(r.body);
    }
  });
});

describe("R24 R25 POST /api/payments/:paymentId/reject", () => {
  it("missing / short / whitespace / non-string reason -> 400; unknown key -> 400; payment stays pending", async () => {
    const l = await newLease();
    const id = await record(fx.tokens.staff, l.id, 1000);
    const bad: unknown[] = [undefined, "{bad json", {}, { reason: "" }, { reason: "abcd" }, { reason: "   abcd   " }, { reason: 12345 }, { reason: "Valid reason", extra: true }];
    for (const b of bad) {
      const r = await post(fx.tokens.manager, id, "reject", b);
      expect(r.status, JSON.stringify(b)).toBe(400);
      errorBody.parse(r.body);
    }
    expect(await status(id)).toBe("pending_verification");
  });

  it("valid reason -> 200 { status: 'rejected' }; reason + audit stored; reject or void again -> 409", async () => {
    const l = await newLease();
    const id = await record(fx.tokens.staff, l.id, 1000);
    const r = await post(fx.tokens.manager, id, "reject", { reason: "Amount does not match the slip" });
    expect(r.status).toBe(200);
    expect(statusBody.parse(r.body)).toEqual({ status: "rejected" });
    const [row] = await sql<{ reason: string; decided_by: string }>("select reason, decided_by from public.payments where id = $1", [id]);
    expect(row).toEqual({ reason: "Amount does not match the slip", decided_by: fx.users.manager.userId });
    expect(await audit("payment.rejected", id)).toEqual([{ actor_id: fx.users.manager.userId }]);

    for (const action of ["reject", "void"] as const) {
      const again = await post(fx.tokens.manager, id, action, { reason: "Second attempt" });
      expect(again.status, action).toBe(409);
      errorBody.parse(again.body);
    }
  });

  it("an approved payment cannot be rejected -> 409; body validation (400) comes before that 409", async () => {
    const l = await newLease();
    const id = await record(fx.tokens.manager, l.id, 1000);
    const r = await post(fx.tokens.manager, id, "reject", { reason: "Changed my mind" });
    expect(r.status).toBe(409);
    errorBody.parse(r.body);
    const short = await post(fx.tokens.manager, id, "reject", { reason: "no" });
    expect(short.status).toBe(400);
    errorBody.parse(short.body);
  });
});

describe("R24 R25 POST /api/payments/:paymentId/void", () => {
  it("void removes only that payment's allocations; the other payment's allocations are untouched", async () => {
    const l = await newLease();
    const a = await record(fx.tokens.manager, l.id, 120000); // deposit 50000 + period 0 70000
    const b = await record(fx.tokens.manager, l.id, 100000); // period 0 30000 + period 1 70000
    const bBefore = await allocations(b);
    expect(bBefore.map((x) => x.amount_sen).sort((x, y) => x - y)).toEqual([30000, 70000]);

    const missing = await post(fx.tokens.manager, a, "void", {});
    expect(missing.status).toBe(400);
    errorBody.parse(missing.body);
    const short = await post(fx.tokens.manager, a, "void", { reason: " ok " });
    expect(short.status).toBe(400);
    errorBody.parse(short.body);
    expect(await status(a)).toBe("approved");

    const r = await post(fx.tokens.manager, a, "void", { reason: "Recorded on the wrong lease" });
    expect(r.status).toBe(200);
    expect(statusBody.parse(r.body)).toEqual({ status: "voided" });
    expect(await allocations(a)).toHaveLength(0);
    expect(await allocations(b)).toEqual(bBefore);
    expect(await audit("payment.voided", a)).toEqual([{ actor_id: fx.users.manager.userId }]);

    // R25: payments are never deleted; the voided row is still listed.
    const detail = leaseDetail.parse((await api(fx.tokens.manager).get(`/api/leases/${l.id}`)).body);
    expect(detail.payments.find((p) => p.id === a)?.status).toBe("voided");
    const [deposit, p0, p1] = detail.invoices;
    expect([deposit.paidSen, p0.paidSen, p1.paidSen]).toEqual([0, 30000, 70000]);

    const again = await post(fx.tokens.manager, a, "void", { reason: "Second attempt" });
    expect(again.status).toBe(409);
    errorBody.parse(again.body);
  });

  it("a pending payment cannot be voided -> 409", async () => {
    const l = await newLease();
    const id = await record(fx.tokens.staff, l.id, 1000);
    const r = await post(fx.tokens.manager, id, "void", { reason: "Not approved yet" });
    expect(r.status).toBe(409);
    errorBody.parse(r.body);
    expect(await status(id)).toBe("pending_verification");
  });
});

describe("R38 R1 approve / reject / void: 401 / 403 / 404", () => {
  it.each(["approve", "reject", "void"] as const)("%s: anon 401, staff 403, lease tenant 403, other tenant 404, other org 404, bad id 404", async (action) => {
    const l = await newLease();
    const pending = await record(fx.tokens.staff, l.id, 1000);
    const approved = await record(fx.tokens.manager, l.id, 1000);
    const id = action === "void" ? approved : pending;
    const body = action === "approve" ? undefined : { reason: "Some valid reason" };
    const beta = await seeded("betaManager");

    const expectations: Array<[string | undefined, number]> = [
      [undefined, 401],
      [fx.tokens.staff, 403],
      [fx.tokens.tenantA, 403],
      [fx.tokens.tenantB, 404],
      [beta.accessToken, 404],
    ];
    for (const [token, code] of expectations) {
      const r = await post(token as string, id, action, body);
      expect(r.status).toBe(code);
      errorBody.parse(r.body);
    }
    for (const bad of ["not-a-uuid", randomUUID()]) {
      const r = await post(fx.tokens.manager, bad, action, body);
      expect(r.status).toBe(404);
      errorBody.parse(r.body);
    }
    expect(await status(pending)).toBe("pending_verification");
    expect(await status(approved)).toBe("approved");
  });
});
