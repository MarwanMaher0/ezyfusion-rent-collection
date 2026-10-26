import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateSchedule, invoiceStatus, type InvoiceStatus, type ScheduledInvoice } from "@/lib/billing";
import { closePool, newConnection } from "../helpers/db";
import { createFixtureOrg, type FixtureOrg, type LeaseInput } from "../helpers/fixtures";
import { mytAt, mytEndOfDay, mytMidnight } from "../helpers/time";

// Allocation (R26), paid amount = sum of allocations + statuses from invoiceStatus (R27), void (R24/D14).
// One committed fixture org (users, memberships, a unit); every lease, invoice, payment, bill and
// allocation is created inside BEGIN ... ROLLBACK on one dedicated connection, so nothing in the
// append-only money tables survives a test. Money rows come only from the private.* functions.

type Inv = ScheduledInvoice & { id: string };
interface TxLease {
  id: string;
  invoices: Inv[];
}
interface Alloc {
  id: string;
  payment_id: string;
  invoice_id: string;
  amount_sen: number;
}

// Deposit 2,000.00 due 2026-01-01; rent 1,000.00 for periods 0..2 due 01-01, 02-01, 03-01. Total 5,000.00.
const LEASE: LeaseInput = { startDate: "2026-01-01", endDate: "2026-03-31", monthlyRentSen: 100_000, depositSen: 200_000 };
const RECEIVED_AT = "2026-01-01T10:00:00+08:00";

let fx: FixtureOrg;
let c: pg.Client;

beforeAll(async () => {
  fx = await createFixtureOrg({ units: 1 });
  c = await newConnection();
}, 60_000);

afterAll(async () => {
  await c?.end();
  await closePool();
});

beforeEach(async () => {
  await c.query("begin");
});

afterEach(async () => {
  await c.query("rollback");
});

/** Lease + exactly generateSchedule(lease) inside the open transaction. rentFirst inserts the deposit
 *  last, so a correct order can never come from insertion order. Returned invoices are in schedule order. */
async function insertLeaseTx(lease: LeaseInput, rentFirst = false): Promise<TxLease> {
  const schedule = generateSchedule(lease);
  const { rows } = await c.query<{ id: string }>(
    `insert into public.leases (org_id, unit_id, tenant_id, start_date, end_date, monthly_rent_sen, deposit_sen, created_by)
     values ($1, $2, $3, $4::date, $5::date, $6, $7, $8) returning id`,
    [fx.orgId, fx.unitIds[0], fx.tenantAId, lease.startDate, lease.endDate, lease.monthlyRentSen, lease.depositSen, fx.users.manager.userId],
  );
  const leaseId = rows[0].id;
  const order = rentFirst
    ? [...schedule.filter((i) => i.kind === "rent"), ...schedule.filter((i) => i.kind === "deposit")]
    : schedule;
  const ids = new Map<ScheduledInvoice, string>();
  for (const inv of order) {
    const r = await c.query<{ id: string }>(
      `insert into public.invoices (org_id, lease_id, kind, period_index, period_start, period_end, due_date, amount_sen)
       values ($1, $2, $3, $4, $5::date, $6::date, $7::date, $8) returning id`,
      [fx.orgId, leaseId, inv.kind, inv.periodIndex, inv.periodStart, inv.periodEnd, inv.dueDate, inv.amountSen],
    );
    ids.set(inv, r.rows[0].id);
  }
  return {
    id: leaseId,
    invoices: schedule.map((inv) => {
      const id = ids.get(inv);
      if (!id) throw new Error("invoice id missing");
      return { ...inv, id };
    }),
  };
}

async function record(actorId: string, leaseId: string, amountSen: number) {
  const { rows } = await c.query<{ id: string; status: string; replayed: boolean }>(
    "select * from private.record_payment($1, $2, $3, 'cash', $4::timestamptz, null, $5)",
    [actorId, leaseId, amountSen, RECEIVED_AT, randomUUID()],
  );
  return rows[0];
}
const managerPays = (leaseId: string, amountSen: number) => record(fx.users.manager.userId, leaseId, amountSen);

async function approve(paymentId: string) {
  await c.query("select * from private.approve_payment($1, $2)", [fx.users.manager.userId, paymentId]);
}

async function voidPayment(paymentId: string) {
  await c.query("select * from private.void_payment($1, $2, $3)", [fx.users.manager.userId, paymentId, "Cheque bounced"]);
}

async function createBill(leaseId: string, at: Date) {
  const { rows } = await c.query<{ id: string; amount_sen: number }>(
    "select * from private.create_gateway_bill($1, $2, $3::timestamptz)",
    [fx.users.tenantA.userId, leaseId, at.toISOString()],
  );
  return rows[0];
}

async function paidCallback(billId: string, amountSen: number) {
  const { rows } = await c.query<{ outcome: string; payment_id: string }>(
    "select * from private.apply_gateway_callback($1, true, $2, $3::timestamptz, $4, 'success')",
    [billId, amountSen, "2026-01-10T12:00:00+08:00", `TX-${randomUUID()}`],
  );
  return rows[0];
}

async function payment(id: string) {
  const { rows } = await c.query<{ status: string; method: string; amount_sen: number; unapplied_sen: number }>(
    "select status, method, amount_sen, unapplied_sen from public.payments where id = $1",
    [id],
  );
  return rows[0];
}

async function allocationsOf(paymentId: string): Promise<Alloc[]> {
  const { rows } = await c.query<Alloc>(
    "select id, payment_id, invoice_id, amount_sen from public.payment_allocations where payment_id = $1 order by id",
    [paymentId],
  );
  return rows;
}

/** invoice id -> amount this payment put on it (only invoices that got a row). */
async function fillOf(paymentId: string, lease: TxLease): Promise<Record<string, number>> {
  const names = new Map(lease.invoices.map((i) => [i.id, i.kind === "deposit" ? "deposit" : `p${i.periodIndex}`]));
  const out: Record<string, number> = {};
  for (const a of await allocationsOf(paymentId)) out[names.get(a.invoice_id) ?? a.invoice_id] = a.amount_sen;
  return out;
}

/** R27: paidSen per invoice = sum of its allocations (0 when none). */
async function paidSen(lease: TxLease): Promise<number[]> {
  const { rows } = await c.query<{ invoice_id: string; paid: number }>(
    "select invoice_id, sum(amount_sen)::bigint as paid from public.payment_allocations where lease_id = $1 group by invoice_id",
    [lease.id],
  );
  const m = new Map(rows.map((r) => [r.invoice_id, r.paid]));
  return lease.invoices.map((i) => m.get(i.id) ?? 0);
}

async function statuses(lease: TxLease, now: Date): Promise<InvoiceStatus[]> {
  const paid = await paidSen(lease);
  return lease.invoices.map((i, k) => invoiceStatus({ dueDate: i.dueDate, amountSen: i.amountSen, paidSen: paid[k] }, now));
}

/** Invariants that must hold after every step: no invoice over-allocated, no 0/negative row,
 *  every approved payment = its allocations + unapplied_sen, a non-approved payment has none. */
async function assertInvariants(lease: TxLease) {
  const paid = await paidSen(lease);
  lease.invoices.forEach((inv, k) => expect(paid[k], `invoice ${inv.kind}/${inv.periodIndex}`).toBeLessThanOrEqual(inv.amountSen));
  const { rows } = await c.query<{ id: string; status: string; method: string; amount_sen: number; unapplied_sen: number; allocated: number; min_row: number | null }>(
    `select p.id, p.status, p.method, p.amount_sen, p.unapplied_sen,
            coalesce(sum(a.amount_sen), 0)::bigint as allocated, min(a.amount_sen) as min_row
       from public.payments p left join public.payment_allocations a on a.payment_id = p.id
      where p.lease_id = $1 group by p.id`,
    [lease.id],
  );
  for (const p of rows) {
    if (p.min_row !== null) expect(p.min_row).toBeGreaterThan(0);
    if (p.status === "approved") {
      expect(p.allocated + p.unapplied_sen).toBe(p.amount_sen);
      if (p.method !== "online") expect(p.unapplied_sen).toBe(0);
    } else {
      expect(p.allocated).toBe(0);
    }
  }
}

/** Runs fn inside a savepoint, expecting it to fail with `code`, and leaves the transaction usable. */
async function expectSqlError(fn: () => Promise<unknown>, code: string) {
  await c.query("savepoint expect_err");
  let err: unknown;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  await c.query("rollback to savepoint expect_err");
  expect(err, `expected SQLSTATE ${code}`).toMatchObject({ code });
}

describe("R26 R27 allocation order: due date, deposit before rent on the same day, period index", () => {
  it("fills the deposit before same-day rent, each invoice up to its unpaid amount, then the next", async () => {
    const lease = await insertLeaseTx(LEASE, true);
    expect(lease.invoices.map((i) => [i.kind, i.dueDate, i.amountSen])).toEqual([
      ["deposit", "2026-01-01", 200_000],
      ["rent", "2026-01-01", 100_000],
      ["rent", "2026-02-01", 100_000],
      ["rent", "2026-03-01", 100_000],
    ]);

    const p1 = await managerPays(lease.id, 250_000);
    expect(p1.status).toBe("approved");
    expect(await fillOf(p1.id, lease)).toEqual({ deposit: 200_000, p0: 50_000 });
    await assertInvariants(lease);

    // The second payment tops up p0 to full before touching p1; p1's own due date is in the future.
    const firstRows = await allocationsOf(p1.id);
    const p2 = await managerPays(lease.id, 120_000);
    expect(await fillOf(p2.id, lease)).toEqual({ p0: 50_000, p1: 70_000 });
    expect(await allocationsOf(p1.id)).toEqual(firstRows);
    expect(await paidSen(lease)).toEqual([200_000, 100_000, 70_000, 0]);
    await assertInvariants(lease);

    // R27 statuses over the allocations (asOf injected, never the wall clock).
    expect(await statuses(lease, mytAt("2026-02-01", "12:00"))).toEqual(["paid", "paid", "partially_paid", "unpaid"]);
    expect(await statuses(lease, mytMidnight("2026-02-02"))).toEqual(["paid", "paid", "overdue", "unpaid"]);
  });

  it("a partial fill leaves the next invoice partially paid (and overdue the MYT day after its due date)", async () => {
    const lease = await insertLeaseTx(LEASE);
    const p = await managerPays(lease.id, 200_001);
    expect(await fillOf(p.id, lease)).toEqual({ deposit: 200_000, p0: 1 });
    expect(await paidSen(lease)).toEqual([200_000, 1, 0, 0]);
    expect(await statuses(lease, mytEndOfDay("2026-01-01"))).toEqual(["paid", "partially_paid", "unpaid", "unpaid"]);
    expect(await statuses(lease, mytMidnight("2026-01-02"))).toEqual(["paid", "overdue", "unpaid", "unpaid"]);
    await assertInvariants(lease);
  });

  it("invoices not yet due are filled too (advance payment), in period-index order", async () => {
    const lease = await insertLeaseTx(LEASE, true);
    const p = await managerPays(lease.id, 400_000);
    expect(await fillOf(p.id, lease)).toEqual({ deposit: 200_000, p0: 100_000, p1: 100_000 });
    // On 2026-01-05 p1 (due 02-01) is not due yet but is already paid; p2 untouched.
    expect(await statuses(lease, mytAt("2026-01-05", "09:00"))).toEqual(["paid", "paid", "paid", "unpaid"]);
    await assertInvariants(lease);
  });

  it("a manager payment equal to the whole balance pays every invoice exactly, unapplied 0; one more sen is refused", async () => {
    const lease = await insertLeaseTx(LEASE);
    const p = await managerPays(lease.id, 500_000);
    expect(await fillOf(p.id, lease)).toEqual({ deposit: 200_000, p0: 100_000, p1: 100_000, p2: 100_000 });
    expect(await payment(p.id)).toMatchObject({ status: "approved", unapplied_sen: 0 });
    expect(await statuses(lease, mytAt("2026-01-01", "09:00"))).toEqual(["paid", "paid", "paid", "paid"]);
    await expectSqlError(() => managerPays(lease.id, 1), "P0422");
    await assertInvariants(lease);
  });

  it("a staff payment allocates only when approved, by the same rule; a second allocate_payment adds nothing (R28)", async () => {
    const lease = await insertLeaseTx(LEASE, true);
    const pending = await record(fx.users.staff.userId, lease.id, 230_000);
    expect(pending.status).toBe("pending_verification");
    expect(await allocationsOf(pending.id)).toEqual([]);
    await assertInvariants(lease);

    await approve(pending.id);
    expect(await fillOf(pending.id, lease)).toEqual({ deposit: 200_000, p0: 30_000 });
    const rows = await allocationsOf(pending.id);
    await c.query("select private.allocate_payment($1)", [pending.id]);
    expect(await allocationsOf(pending.id)).toEqual(rows);
    await assertInvariants(lease);
  });
});

describe("R26 online payment larger than the remaining balance: leftover stays as unapplied_sen", () => {
  it("fills every invoice (due or not) and keeps the leftover on the payment; a duplicate callback changes nothing", async () => {
    const lease = await insertLeaseTx(LEASE);
    // On 2026-02-15 MYT deposit + p0 + p1 are due: the bill is 4,000.00.
    const bill = await createBill(lease.id, mytAt("2026-02-15", "10:00"));
    expect(bill.amount_sen).toBe(400_000);

    // A manager payment lands before the tenant completes checkout.
    const cash = await managerPays(lease.id, 150_000);
    expect(await fillOf(cash.id, lease)).toEqual({ deposit: 150_000 });

    const cb = await paidCallback(bill.id, bill.amount_sen);
    expect(cb.outcome).toBe("paid");
    // Remaining balance 350,000 is absorbed (p2 not due until 03-01 is included); 50,000 is left over.
    expect(await fillOf(cb.payment_id, lease)).toEqual({ deposit: 50_000, p0: 100_000, p1: 100_000, p2: 100_000 });
    expect(await payment(cb.payment_id)).toMatchObject({ status: "approved", method: "online", amount_sen: 400_000, unapplied_sen: 50_000 });
    expect(await paidSen(lease)).toEqual(lease.invoices.map((i) => i.amountSen));
    expect(await statuses(lease, mytAt("2026-02-15", "10:00"))).toEqual(["paid", "paid", "paid", "paid"]);
    await assertInvariants(lease);

    const rows = await allocationsOf(cb.payment_id);
    const again = await paidCallback(bill.id, bill.amount_sen);
    expect(again).toEqual({ outcome: "duplicate", payment_id: cb.payment_id });
    expect(await allocationsOf(cb.payment_id)).toEqual(rows);
    expect((await payment(cb.payment_id)).unapplied_sen).toBe(50_000);
  });

  it("a 0-sen rent invoice gets no allocation row, even when money is still left over", async () => {
    // Rent 0.10 with a 1-day final period of a 28-day month: round(10 * 1 / 28) = 0 sen.
    const lease = await insertLeaseTx({ startDate: "2026-01-01", endDate: "2026-02-01", monthlyRentSen: 10, depositSen: 5_000 });
    expect(lease.invoices.map((i) => [i.kind, i.periodIndex, i.amountSen])).toEqual([
      ["deposit", null, 5_000],
      ["rent", 0, 10],
      ["rent", 1, 0],
    ]);
    const zero = lease.invoices[2];

    const bill = await createBill(lease.id, mytAt("2026-02-01", "09:00"));
    expect(bill.amount_sen).toBe(5_010);
    const cash = await managerPays(lease.id, 10);
    expect(await fillOf(cash.id, lease)).toEqual({ deposit: 10 });

    // The online loop passes the 0-sen invoice with 10 sen still in hand and must skip it.
    const cb = await paidCallback(bill.id, bill.amount_sen);
    expect(await fillOf(cb.payment_id, lease)).toEqual({ deposit: 4_990, p0: 10 });
    expect((await payment(cb.payment_id)).unapplied_sen).toBe(10);
    const { rows } = await c.query("select 1 from public.payment_allocations where invoice_id = $1", [zero.id]);
    expect(rows).toHaveLength(0);
    // paidSen 0 >= amountSen 0 -> paid (R17 rule order).
    expect(await statuses(lease, mytAt("2026-02-02", "09:00"))).toEqual(["paid", "paid", "paid"]);
    await assertInvariants(lease);
  });
});

describe("R24 R26 D14 void removes only that payment's allocations", () => {
  it("other payments' allocations and unapplied_sen are unchanged; the voided payment's invoices reopen", async () => {
    const lease = await insertLeaseTx(LEASE);
    const asOfBill = mytAt("2026-01-10", "10:00");
    const bill = await createBill(lease.id, asOfBill);
    expect(bill.amount_sen).toBe(300_000);

    const cash = await managerPays(lease.id, 250_000);
    expect(await fillOf(cash.id, lease)).toEqual({ deposit: 200_000, p0: 50_000 });
    const cb = await paidCallback(bill.id, bill.amount_sen);
    expect(await fillOf(cb.payment_id, lease)).toEqual({ p0: 50_000, p1: 100_000, p2: 100_000 });
    expect((await payment(cb.payment_id)).unapplied_sen).toBe(50_000);
    await assertInvariants(lease);

    const onlineRows = await allocationsOf(cb.payment_id);
    await voidPayment(cash.id);

    expect(await payment(cash.id)).toMatchObject({ status: "voided", unapplied_sen: 0 });
    expect(await allocationsOf(cash.id)).toEqual([]);
    // D14: the online payment keeps exactly its rows (same ids) and its 50,000 is NOT re-applied.
    expect(await allocationsOf(cb.payment_id)).toEqual(onlineRows);
    expect((await payment(cb.payment_id)).unapplied_sen).toBe(50_000);
    expect(await paidSen(lease)).toEqual([0, 50_000, 100_000, 100_000]);
    expect(await statuses(lease, asOfBill)).toEqual(["overdue", "overdue", "paid", "paid"]);
    await assertInvariants(lease);

    await expectSqlError(() => voidPayment(cash.id), "P0409");
    expect(await allocationsOf(cb.payment_id)).toEqual(onlineRows);
  });

  it("voiding one of two manager payments leaves the other's allocations untouched", async () => {
    const lease = await insertLeaseTx(LEASE);
    const a = await managerPays(lease.id, 150_000);
    const b = await managerPays(lease.id, 120_000);
    expect(await fillOf(a.id, lease)).toEqual({ deposit: 150_000 });
    expect(await fillOf(b.id, lease)).toEqual({ deposit: 50_000, p0: 70_000 });
    const bRows = await allocationsOf(b.id);

    await voidPayment(a.id);
    expect(await allocationsOf(a.id)).toEqual([]);
    expect(await allocationsOf(b.id)).toEqual(bRows);
    expect(await paidSen(lease)).toEqual([50_000, 70_000, 0, 0]);
    expect(await statuses(lease, mytAt("2026-01-01", "09:00"))).toEqual(["partially_paid", "partially_paid", "unpaid", "unpaid"]);
    await assertInvariants(lease);

    // The released amount can be paid again and fills the reopened deposit first.
    const c2 = await managerPays(lease.id, 160_000);
    expect(await fillOf(c2.id, lease)).toEqual({ deposit: 150_000, p0: 10_000 });
    await assertInvariants(lease);
  });
});
