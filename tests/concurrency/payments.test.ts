import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateSchedule } from "@/lib/billing";
import { closePool, newConnection, pool, sql } from "../helpers/db";
import { createFixtureOrg, createFixtureUser, insertUnit, type FixtureOrg } from "../helpers/fixtures";
import { signedCallback } from "../helpers/gateway";
import { api, postForm, type HttpResult } from "../helpers/http";
import type { Session } from "../helpers/seeded";
import {
  ROUNDS,
  backendPid,
  expectErrorBody,
  expectNo5xx,
  invoicePaid,
  leaseAllocatedSen,
  newLease,
  paymentAllocations,
  sortedStatuses,
  waitForBlockedBy,
  waitForPidOnLock,
} from "./support";

// R22 R23 R28 R46 D7 D9 D16: payments and lease creation under real concurrency, over HTTP against the
// dev server (Promise.all = requests in flight together) and, for the forced-overlap proofs, at the SQL
// layer with two pg sessions. Every scenario uses its own lease on a fresh unit of a fixture org.

// One invoice of RM 1,000.00 (the brief's "RM 1,000 remaining" example).
const LEASE_1000 = { startDate: "2026-01-01", endDate: "2026-01-31", monthlyRentSen: 100_000, depositSen: 0 };
// Deposit RM 500 + 3 x RM 1,000 = RM 3,500; X/4 = 87,500 crosses invoice boundaries.
const LEASE_3500 = { startDate: "2026-01-01", endDate: "2026-03-31", monthlyRentSen: 100_000, depositSen: 50_000 };
const RECEIVED = "2026-01-15T10:00:00+08:00";

let fx: FixtureOrg; // org A
let other: FixtureOrg; // org B, for cross-org idempotency independence
let staff2: Session; // a second staff member of org A (the brief: "two staff members")

const cash = (amountSen: number, receivedAt = RECEIVED) => ({ amountSen, method: "cash", receivedAt });
const payPath = (leaseId: string) => `/api/leases/${leaseId}/payments`;

async function paymentRow(id: string) {
  const rows = await sql<{ status: string; amount_sen: number; lease_id: string }>(
    "select status, amount_sen, lease_id from public.payments where id = $1",
    [id],
  );
  return rows[0];
}

async function pendingSum(leaseId: string): Promise<number> {
  const rows = await sql<{ s: number }>(
    `select coalesce(sum(amount_sen), 0)::bigint as s from public.payments
      where lease_id = $1 and status = 'pending_verification'`,
    [leaseId],
  );
  return rows[0].s;
}

async function staffPending(leaseId: string, amountSen: number): Promise<string> {
  const r = await api(fx.tokens.staff).post<{ id: string; status: string }>(payPath(leaseId), cash(amountSen));
  expect(r.status).toBe(201);
  expect(r.body.status).toBe("pending_verification");
  return r.body.id;
}

beforeAll(async () => {
  [fx, other, staff2] = await Promise.all([
    createFixtureOrg({ units: 1 }),
    createFixtureOrg({ units: 1 }),
    createFixtureUser("staff2"),
  ]);
  await pool().query("insert into public.memberships (user_id, org_id, role) values ($1, $2, 'staff')", [
    staff2.userId,
    fx.orgId,
  ]);
});

afterAll(async () => {
  await closePool();
});

describe("R28 R22 cap race: two staff record at the same moment", () => {
  it(`RM 800 + RM 700 on RM 1,000 remaining -> exactly one 201 and one 422, x${ROUNDS}`, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const lease = await newLease(fx, LEASE_1000);
      const rs = await Promise.all([
        api(fx.tokens.staff).post<{ id?: string; status?: string }>(payPath(lease.id), cash(80_000)),
        api(staff2.accessToken).post<{ id?: string; status?: string }>(payPath(lease.id), cash(70_000)),
      ]);
      expectNo5xx(rs);
      expect(sortedStatuses(rs)).toEqual([201, 422]);
      const won = rs.find((r) => r.status === 201)!;
      const lost = rs.find((r) => r.status === 422)!;
      expect(won.body).toEqual({ id: expect.any(String), status: "pending_verification" });
      expectErrorBody(lost);
      // R22: Σ pending never exceeds the cap; exactly the winner's row exists.
      const pend = await pendingSum(lease.id);
      expect(pend).toBeLessThanOrEqual(100_000);
      expect(pend).toBe((await paymentRow(won.body.id!)).amount_sen);
      const count = await sql<{ n: number }>("select count(*)::bigint as n from public.payments where lease_id = $1", [
        lease.id,
      ]);
      expect(count[0].n).toBe(1);
    }
  });

  it(`10 concurrent manager payments of X/4 -> exactly 4 approved, allocations sum to X, no invoice over-allocated, x${ROUNDS}`, async () => {
    const X = 350_000;
    for (let round = 0; round < ROUNDS; round++) {
      const lease = await newLease(fx, LEASE_3500);
      const rs = await Promise.all(
        Array.from({ length: 10 }, () =>
          api(fx.tokens.manager).post<{ id?: string; status?: string }>(payPath(lease.id), cash(X / 4)),
        ),
      );
      expectNo5xx(rs);
      const ok = rs.filter((r) => r.status === 201);
      expect(ok).toHaveLength(4);
      expect(rs.filter((r) => r.status === 422)).toHaveLength(6);
      for (const r of ok) expect(r.body.status).toBe("approved");
      for (const r of rs.filter((x) => x.status === 422)) expectErrorBody(r);

      expect(await leaseAllocatedSen(lease.id)).toBe(X);
      for (const inv of await invoicePaid(lease.id)) {
        expect(inv.paid_sen).toBeLessThanOrEqual(inv.amount_sen);
        expect(inv.paid_sen).toBe(inv.amount_sen);
      }
      for (const r of ok) expect((await paymentAllocations(r.body.id!)).sum).toBe(X / 4);

      // Same picture through the API: every invoice paid, paidSen = amountSen.
      const view = await api(fx.tokens.manager).get<{ invoices: { amountSen: number; paidSen: number; status: string }[] }>(
        `/api/leases/${lease.id}`,
      );
      expect(view.status).toBe(200);
      for (const inv of view.body.invoices) {
        expect(inv.paidSen).toBe(inv.amountSen);
        expect(inv.status).toBe("paid");
      }
    }
  });

  it(`10 concurrent staff payments of X/4 -> exactly 4 pending, Σ pending = X, x${ROUNDS}`, async () => {
    const X = 350_000;
    for (let round = 0; round < ROUNDS; round++) {
      const lease = await newLease(fx, LEASE_3500);
      const rs = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          api(i % 2 ? staff2.accessToken : fx.tokens.staff).post(payPath(lease.id), cash(X / 4)),
        ),
      );
      expectNo5xx(rs);
      expect(sortedStatuses(rs)).toEqual([201, 201, 201, 201, 422, 422, 422, 422, 422, 422]);
      expect(await pendingSum(lease.id)).toBe(X);
      expect(await leaseAllocatedSen(lease.id)).toBe(0);
    }
  });
});

describe("R28 R22 D7 forced overlap: record_payment holds the lease lock until commit", () => {
  it("SQL x SQL: session 2 waits on a Lock while session 1 is uncommitted, then gets P0422", async () => {
    const lease = await newLease(fx, LEASE_1000);
    const c1 = await newConnection();
    const c2 = await newConnection();
    let second: Promise<pg.QueryResult> | undefined;
    try {
      await c1.query("begin");
      const first = await c1.query<{ id: string; status: string }>(
        "select * from private.record_payment($1, $2, $3, 'cash', $4, null, null)",
        [fx.users.staff.userId, lease.id, 80_000, RECEIVED],
      );
      expect(first.rows[0].status).toBe("pending_verification");
      const pid2 = await backendPid(c2);
      second = c2.query("select * from private.record_payment($1, $2, $3, 'cash', $4, null, null)", [
        staff2.userId,
        lease.id,
        70_000,
        RECEIVED,
      ]);
      second.catch(() => undefined); // asserted below; avoid an unhandled rejection while we wait
      expect(await waitForPidOnLock(pid2)).toBe("Lock");
      await c1.query("commit");
      await expect(second).rejects.toMatchObject({ code: "P0422" });
      expect(await pendingSum(lease.id)).toBe(80_000);
    } finally {
      await c1.query("rollback").catch(() => undefined);
      if (second) await second.catch(() => undefined);
      await c1.end();
      await c2.end();
    }
  });

  it("SQL x HTTP: POST /payments blocks on the lease lock held by an open transaction, then answers 422", async () => {
    const lease = await newLease(fx, LEASE_1000);
    const c1 = await newConnection();
    let http: Promise<HttpResult> | undefined;
    try {
      await c1.query("begin");
      await c1.query("select * from private.record_payment($1, $2, $3, 'cash', $4, null, null)", [
        fx.users.staff.userId,
        lease.id,
        80_000,
        RECEIVED,
      ]);
      const holder = await backendPid(c1);
      http = api(staff2.accessToken).post(payPath(lease.id), cash(70_000));
      const blocked = await waitForBlockedBy(holder);
      expect(blocked.wait_event_type).toBe("Lock");
      expect(blocked.query).toMatch(/record_payment/);
      await c1.query("commit");
      const res = await http;
      expect(res.status).toBe(422);
      expectErrorBody(res);
      expect(await pendingSum(lease.id)).toBe(80_000);
    } finally {
      await c1.query("rollback").catch(() => undefined);
      if (http) await http.catch(() => undefined);
      await c1.end();
    }
  });
});

describe("R23 R28 approve twice at the same moment is allocated once", () => {
  it(`two concurrent approves -> one 200 { status: 'approved' }, one 409; allocations inserted once, x${ROUNDS}`, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const lease = await newLease(fx, LEASE_3500);
      const id = await staffPending(lease.id, 120_000); // fills deposit 50,000 + 70,000 of rent 0
      const rs = await Promise.all([
        api(fx.tokens.manager).post(`/api/payments/${id}/approve`),
        api(fx.tokens.manager).post(`/api/payments/${id}/approve`),
      ]);
      expectNo5xx(rs);
      expect(sortedStatuses(rs)).toEqual([200, 409]);
      expect(rs.find((r) => r.status === 200)!.body).toEqual({ status: "approved" });
      expectErrorBody(rs.find((r) => r.status === 409)!);
      expect(await paymentAllocations(id)).toEqual({ count: 2, sum: 120_000 });
      const audits = await sql<{ n: number }>(
        "select count(*)::bigint as n from public.audit_log where action = 'payment.approved' and entity_id = $1",
        [id],
      );
      expect(audits[0].n).toBe(1);
    }
  });
});

describe("R24 R28 approve vs reject / void on the same payment: one consistent outcome", () => {
  it(`approve vs reject at once -> exactly one wins (200 + 409), final state matches the winner, x${ROUNDS}`, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const lease = await newLease(fx, LEASE_3500);
      const id = await staffPending(lease.id, 120_000);
      const [ap, rj] = await Promise.all([
        api(fx.tokens.manager).post(`/api/payments/${id}/approve`),
        api(fx.tokens.manager).post(`/api/payments/${id}/reject`, { reason: "duplicate slip" }),
      ]);
      expectNo5xx([ap, rj]);
      expect([ap.status, rj.status].sort()).toEqual([200, 409]);
      const row = await paymentRow(id);
      const alloc = await paymentAllocations(id);
      if (ap.status === 200) {
        expect(ap.body).toEqual({ status: "approved" });
        expect(row.status).toBe("approved");
        expect(alloc.sum).toBe(120_000);
      } else {
        expect(rj.body).toEqual({ status: "rejected" });
        expect(row.status).toBe("rejected");
        expect(alloc).toEqual({ count: 0, sum: 0 });
      }
    }
  });

  it(`approve vs void on a pending payment -> approve 200; void either voids after it (200) or is refused (409); never half-applied, x${ROUNDS}`, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const lease = await newLease(fx, LEASE_3500);
      const id = await staffPending(lease.id, 120_000);
      const [ap, vd] = await Promise.all([
        api(fx.tokens.manager).post(`/api/payments/${id}/approve`),
        api(fx.tokens.manager).post(`/api/payments/${id}/void`, { reason: "entered twice" }),
      ]);
      expectNo5xx([ap, vd]);
      expect(ap.status).toBe(200);
      expect([200, 409]).toContain(vd.status);
      const row = await paymentRow(id);
      const alloc = await paymentAllocations(id);
      if (vd.status === 200) {
        // void serialized after approve: the payment is voided and none of its allocations remain.
        expect(row.status).toBe("voided");
        expect(alloc).toEqual({ count: 0, sum: 0 });
      } else {
        expect(row.status).toBe("approved");
        expect(alloc.sum).toBe(120_000);
      }
      expect(await leaseAllocatedSen(lease.id)).toBe(alloc.sum);
    }
  });

  it(`void twice / reject twice at once -> one 200, one 409, x${ROUNDS}`, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const lease = await newLease(fx, LEASE_3500);
      const approved = await api(fx.tokens.manager).post<{ id: string; status: string }>(payPath(lease.id), cash(90_000));
      expect(approved.status).toBe(201);
      const pendingId = await staffPending(lease.id, 30_000);
      const [v1, v2, r1, r2] = await Promise.all([
        api(fx.tokens.manager).post(`/api/payments/${approved.body.id}/void`, { reason: "wrong lease" }),
        api(fx.tokens.manager).post(`/api/payments/${approved.body.id}/void`, { reason: "wrong lease" }),
        api(fx.tokens.manager).post(`/api/payments/${pendingId}/reject`, { reason: "no money seen" }),
        api(fx.tokens.manager).post(`/api/payments/${pendingId}/reject`, { reason: "no money seen" }),
      ]);
      expectNo5xx([v1, v2, r1, r2]);
      expect(sortedStatuses([v1, v2])).toEqual([200, 409]);
      expect(sortedStatuses([r1, r2])).toEqual([200, 409]);
      expect((await paymentRow(approved.body.id)).status).toBe("voided");
      expect((await paymentRow(pendingId)).status).toBe("rejected");
      expect(await leaseAllocatedSen(lease.id)).toBe(0);
    }
  });
});

describe("R23 approve re-checks the remaining balance at that moment", () => {
  it("staff pending, then an online payment consumes the balance -> approve 422, payment stays pending", async () => {
    const lease = await newLease(fx, LEASE_1000); // RM 1,000 due 2026-01-01, already due today
    const id = await staffPending(lease.id, 60_000);

    // R30/D13: the amount due now ignores pending manual payments, so the bill is the full RM 1,000.
    const bill = await api(fx.tokens.tenantA).post<{ billId: string; amountSen: number }>(
      `/api/leases/${lease.id}/gateway-bills`,
    );
    expect(bill.status).toBe(201);
    expect(bill.body.amountSen).toBe(100_000);
    const cb = await postForm("/api/webhooks/gateway", signedCallback(bill.body.billId, bill.body.amountSen, true));
    expect(cb.status).toBe(200);
    expect(await leaseAllocatedSen(lease.id)).toBe(100_000);

    const ap = await api(fx.tokens.manager).post(`/api/payments/${id}/approve`);
    expect(ap.status).toBe(422);
    expectErrorBody(ap);
    expect((await paymentRow(id)).status).toBe("pending_verification");
    expect(await paymentAllocations(id)).toEqual({ count: 0, sum: 0 });
  });
});

describe("R46 D16 concurrent lease creation on one unit never overlaps (both dates inclusive)", () => {
  const leaseBody = (unitId: string, startDate: string, endDate: string) => ({
    unitId,
    tenantId: fx.tenantAId,
    startDate,
    endDate,
    monthlyRentSen: 100_000,
    depositSen: 20_000,
  });
  const leasesOn = (unitId: string) =>
    sql<{ id: string; start_date: string; end_date: string; n_invoices: number }>(
      `select l.id, l.start_date, l.end_date,
              (select count(*) from public.invoices i where i.lease_id = l.id)::bigint as n_invoices
         from public.leases l where l.unit_id = $1`,
      [unitId],
    );

  it(`two overlapping POST /api/leases at the same moment -> one 201, one 409; the winner has exactly its schedule, x${ROUNDS}`, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const unitId = await insertUnit(fx.orgId);
      const a = leaseBody(unitId, "2026-01-01", "2026-06-30");
      const b = leaseBody(unitId, "2026-03-01", "2026-08-31");
      const rs = await Promise.all([
        api(fx.tokens.manager).post<{ id?: string }>("/api/leases", a),
        api(fx.tokens.manager).post<{ id?: string }>("/api/leases", b),
      ]);
      expectNo5xx(rs);
      expect(sortedStatuses(rs)).toEqual([201, 409]);
      expectErrorBody(rs.find((r) => r.status === 409)!);
      const won = rs.find((r) => r.status === 201)!;
      const rows = await leasesOn(unitId);
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(won.body.id);
      const winnerInput = rows[0].start_date === a.startDate ? a : b;
      expect(rows[0].n_invoices).toBe(generateSchedule(winnerInput).length);
      // all or nothing: no orphan invoices from the losing request
      const orphans = await sql<{ n: number }>(
        `select count(*)::bigint as n from public.invoices i
          where i.org_id = $1 and not exists (select 1 from public.leases l where l.id = i.lease_id)`,
        [fx.orgId],
      );
      expect(orphans[0].n).toBe(0);
    }
  });

  it("adjacent leases (end + 1 day) created at the same moment -> both 201", async () => {
    const unitId = await insertUnit(fx.orgId);
    const rs = await Promise.all([
      api(fx.tokens.manager).post("/api/leases", leaseBody(unitId, "2026-01-01", "2026-03-31")),
      api(fx.tokens.manager).post("/api/leases", leaseBody(unitId, "2026-04-01", "2026-06-30")),
    ]);
    expect(sortedStatuses(rs)).toEqual([201, 201]);
    expect(await leasesOn(unitId)).toHaveLength(2);
  });

  it("a lease ending on the day another starts -> 409 (sequential and concurrent)", async () => {
    const unitId = await insertUnit(fx.orgId);
    const first = await api(fx.tokens.manager).post("/api/leases", leaseBody(unitId, "2026-01-01", "2026-03-31"));
    expect(first.status).toBe(201);
    const touching = await api(fx.tokens.manager).post("/api/leases", leaseBody(unitId, "2026-03-31", "2026-05-31"));
    expect(touching.status).toBe(409);
    expectErrorBody(touching);
    const before = await api(fx.tokens.manager).post("/api/leases", leaseBody(unitId, "2025-11-01", "2026-01-01"));
    expect(before.status).toBe(409);

    const unit2 = await insertUnit(fx.orgId);
    const rs = await Promise.all([
      api(fx.tokens.manager).post("/api/leases", leaseBody(unit2, "2026-01-01", "2026-03-31")),
      api(fx.tokens.manager).post("/api/leases", leaseBody(unit2, "2026-03-31", "2026-05-31")),
    ]);
    expectNo5xx(rs);
    expect(sortedStatuses(rs)).toEqual([201, 409]);
    expect(await leasesOn(unit2)).toHaveLength(1);
  });
});

describe("R28 D9 D36 optional Idempotency-Key on POST /api/leases/:leaseId/payments", () => {
  const withKey = (key: string) => ({ headers: { "Idempotency-Key": key } });
  const keyed = (key: string) =>
    sql<{ id: string }>("select id from public.payments where idempotency_key = $1", [key]);

  it(`same key + same body twice concurrently -> same id, 201 then 200 replay, one row, x${ROUNDS}`, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const lease = await newLease(fx, LEASE_3500);
      const key = randomUUID();
      const rs = await Promise.all([
        api(fx.tokens.staff).post<{ id: string; status: string }>(payPath(lease.id), cash(40_000), withKey(key)),
        api(fx.tokens.staff).post<{ id: string; status: string }>(payPath(lease.id), cash(40_000), withKey(key)),
      ]);
      expectNo5xx(rs);
      expect(sortedStatuses(rs)).toEqual([200, 201]);
      expect(rs[0].body).toEqual(rs[1].body);
      expect(rs[0].body).toEqual({ id: expect.any(String), status: "pending_verification" });
      expect(await keyed(key)).toEqual([{ id: rs[0].body.id }]);
    }
  });

  it("same key x5 concurrently on a manager payment -> one approved payment, allocated once", async () => {
    const lease = await newLease(fx, LEASE_3500);
    const key = randomUUID();
    const rs = await Promise.all(
      Array.from({ length: 5 }, () =>
        api(fx.tokens.manager).post<{ id: string; status: string }>(payPath(lease.id), cash(60_000), withKey(key)),
      ),
    );
    expectNo5xx(rs);
    expect(sortedStatuses(rs)).toEqual([200, 200, 200, 200, 201]);
    expect(new Set(rs.map((r) => r.body.id)).size).toBe(1);
    expect(await keyed(key)).toHaveLength(1);
    expect(await leaseAllocatedSen(lease.id)).toBe(60_000);
  });

  it("same key + different amount / receivedAt / lease -> 409, no new row", async () => {
    const lease = await newLease(fx, LEASE_3500);
    const lease2 = await newLease(fx, LEASE_3500);
    const key = randomUUID();
    const first = await api(fx.tokens.staff).post<{ id: string }>(payPath(lease.id), cash(40_000), withKey(key));
    expect(first.status).toBe(201);
    const variants = await Promise.all([
      api(fx.tokens.staff).post(payPath(lease.id), cash(40_001), withKey(key)),
      api(fx.tokens.staff).post(payPath(lease.id), cash(40_000, "2026-01-15T10:00:01+08:00"), withKey(key)),
      api(fx.tokens.staff).post(payPath(lease2.id), cash(40_000), withKey(key)),
    ]);
    for (const v of variants) {
      expect(v.status).toBe(409);
      expectErrorBody(v);
    }
    expect(await keyed(key)).toEqual([{ id: first.body.id }]);
    // the same instant written in another offset is the same payload (D36: instant equality)
    const sameInstant = await api(fx.tokens.staff).post<{ id: string }>(
      payPath(lease.id),
      cash(40_000, "2026-01-15T02:00:00Z"),
      withKey(key),
    );
    expect(sameInstant.status).toBe(200);
    expect(sameInstant.body.id).toBe(first.body.id);
  });

  it("invalid key -> 400, nothing recorded", async () => {
    const lease = await newLease(fx, LEASE_3500);
    for (const bad of ["not-a-uuid", "1234", "' or 1=1 --"]) {
      const r = await api(fx.tokens.staff).post(payPath(lease.id), cash(10_000), withKey(bad));
      expect(r.status).toBe(400);
      expectErrorBody(r);
    }
    const rows = await sql<{ n: number }>("select count(*)::bigint as n from public.payments where lease_id = $1", [
      lease.id,
    ]);
    expect(rows[0].n).toBe(0);
  });

  it("a key whose first call paid the FULL balance -> sequential and parallel retries return the original, not 422", async () => {
    const lease = await newLease(fx, LEASE_1000);
    const key = randomUUID();
    const first = await api(fx.tokens.manager).post<{ id: string; status: string }>(
      payPath(lease.id),
      cash(100_000),
      withKey(key),
    );
    expect(first.status).toBe(201);
    expect(first.body.status).toBe("approved");
    const again = await api(fx.tokens.manager).post(payPath(lease.id), cash(100_000), withKey(key));
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    const par = await Promise.all(
      Array.from({ length: 5 }, () => api(fx.tokens.manager).post(payPath(lease.id), cash(100_000), withKey(key))),
    );
    for (const r of par) {
      expect(r.status).toBe(200);
      expect(r.body).toEqual(first.body);
    }
    expect(await keyed(key)).toHaveLength(1);
    expect(await leaseAllocatedSen(lease.id)).toBe(100_000);
  });

  it("retry after the payment was voided / approved -> the original payment with its current status", async () => {
    const lease = await newLease(fx, LEASE_3500);
    const kVoid = randomUUID();
    const paid = await api(fx.tokens.manager).post<{ id: string }>(payPath(lease.id), cash(50_000), withKey(kVoid));
    expect(paid.status).toBe(201);
    const vd = await api(fx.tokens.manager).post(`/api/payments/${paid.body.id}/void`, { reason: "test void" });
    expect(vd.status).toBe(200);
    const retryVoided = await api(fx.tokens.manager).post(payPath(lease.id), cash(50_000), withKey(kVoid));
    expect(retryVoided.status).toBe(200);
    expect(retryVoided.body).toEqual({ id: paid.body.id, status: "voided" });

    const kStaff = randomUUID();
    const pend = await api(fx.tokens.staff).post<{ id: string }>(payPath(lease.id), cash(20_000), withKey(kStaff));
    expect(pend.status).toBe(201);
    expect((await api(fx.tokens.manager).post(`/api/payments/${pend.body.id}/approve`)).status).toBe(200);
    const retryApproved = await api(fx.tokens.staff).post(payPath(lease.id), cash(20_000), withKey(kStaff));
    expect(retryApproved.status).toBe(200);
    expect(retryApproved.body).toEqual({ id: pend.body.id, status: "approved" });
    expect(await leaseAllocatedSen(lease.id)).toBe(20_000);
  });

  it("the same key in another organization is independent", async () => {
    const leaseA = await newLease(fx, LEASE_3500);
    const leaseB = await newLease(other, LEASE_3500);
    const key = randomUUID();
    const [a, b] = await Promise.all([
      api(fx.tokens.staff).post<{ id: string }>(payPath(leaseA.id), cash(10_000), withKey(key)),
      api(other.tokens.staff).post<{ id: string }>(payPath(leaseB.id), cash(10_000), withKey(key)),
    ]);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.id).not.toBe(b.body.id);
    expect(await keyed(key)).toHaveLength(2);
  });

  it("another org's staff replaying org A's key on org A's lease -> 404, never the original payment", async () => {
    const lease = await newLease(fx, LEASE_3500);
    const key = randomUUID();
    const first = await api(fx.tokens.staff).post<{ id: string }>(payPath(lease.id), cash(10_000), withKey(key));
    expect(first.status).toBe(201);
    const probe = await api(other.tokens.staff).post(payPath(lease.id), cash(10_000), withKey(key));
    expect(probe.status).toBe(404);
    expect(JSON.stringify(probe.body)).not.toContain(first.body.id);
  });
});
