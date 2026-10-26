import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, pool, sql } from "../helpers/db";
import { createFixtureOrg, insertTenant, insertUnit, type FixtureOrg } from "../helpers/fixtures";

// DB constraints as `postgres` (the role Prisma connects as; bypasses RLS): every invalid row is
// refused by the database itself with its SQLSTATE, whatever the service layer does.
// Every probe runs inside BEGIN ... ROLLBACK on its own client, so a constraint that is missing
// fails the test without leaving an invalid (and, for payments/audit_log, undeletable) row behind.

type Pre = { text: string; params?: unknown[] };

/** Runs `pre` statements then `text` in a transaction that is always rolled back; returns the SQLSTATE or null. */
async function codeOf(text: string, params: unknown[] = [], pre: Pre[] = []): Promise<string | null> {
  const c = await pool().connect();
  try {
    await c.query("begin");
    for (const p of pre) await c.query(p.text, p.params ?? []);
    await c.query(text, params);
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? "no-code";
  } finally {
    await c.query("rollback").catch(() => undefined);
    c.release();
  }
}

const LEASE = { startDate: "2026-01-01", endDate: "2026-06-30", monthlyRentSen: 100000, depositSen: 200000 };
const RECEIVED = "2026-01-05T10:00:00+08:00";

let fx: FixtureOrg;
let other: FixtureOrg;
let leaseId: string;
let approvedId: string;
let pendingId: string;
let rejectedId: string;
let voidedId: string;

async function record(actor: string, lease: string, amount: number): Promise<{ id: string; status: string }> {
  const [r] = await sql<{ id: string; status: string }>(
    "select id, status from private.record_payment($1, $2, $3, 'cash', $4::timestamptz, null, null)",
    [actor, lease, amount, RECEIVED],
  );
  return r;
}

beforeAll(async () => {
  [fx, other] = await Promise.all([createFixtureOrg({ lease: LEASE }), createFixtureOrg({ lease: LEASE })]);
  leaseId = fx.lease!.id;
  const m = fx.users.manager.userId;
  const s = fx.users.staff.userId;
  // Real rows produced by the private money functions (README: never hand-insert payments).
  approvedId = (await record(m, leaseId, 1000)).id;
  pendingId = (await record(s, leaseId, 1100)).id;
  rejectedId = (await record(s, leaseId, 1200)).id;
  await sql("select * from private.reject_payment($1, $2, 'slip unreadable')", [m, rejectedId]);
  voidedId = (await record(m, leaseId, 1300)).id;
  await sql("select * from private.void_payment($1, $2, 'entered twice')", [m, voidedId]);
});

afterAll(closePool);

describe("R48 money columns: positive bigint sen (23514)", () => {
  it("payments.amount_sen 0 and negative are rejected", async () => {
    for (const amt of [0, -1]) {
      expect(
        await codeOf(
          `insert into public.payments (org_id, lease_id, amount_sen, method, status, received_at)
           values ($1, $2, $3, 'cash', 'approved', now())`,
          [fx.orgId, leaseId, amt],
        ),
      ).toBe("23514");
    }
  });

  // D40: a rent invoice may be 0 sen (a tiny prorated last period); deposits and negatives may not.
  it("invoices: negative rent and 0-sen deposit are rejected", async () => {
    expect(
      await codeOf(
        `insert into public.invoices (org_id, lease_id, kind, period_index, period_start, period_end, due_date, amount_sen)
         values ($1, $2, 'rent', 99, '2027-01-01', '2027-01-31', '2027-01-01', -1)`,
        [fx.orgId, leaseId],
      ),
    ).toBe("23514");
    expect(
      await codeOf(
        `insert into public.invoices (org_id, lease_id, kind, period_index, period_start, period_end, due_date, amount_sen)
         values ($1, $2, 'deposit', null, null, null, '2027-01-01', 0)`,
        [fx.orgId, leaseId],
      ),
    ).toBe("23514");
  });

  it("leases.monthly_rent_sen 0 and deposit_sen -1 are rejected", async () => {
    const ins = `insert into public.leases (org_id, unit_id, tenant_id, start_date, end_date, monthly_rent_sen, deposit_sen)
                 values ($1, $2, $3, '2030-01-01', '2030-02-01', $4, $5)`;
    expect(await codeOf(ins, [fx.orgId, fx.unitIds[1], fx.tenantBId, 0, 0])).toBe("23514");
    expect(await codeOf(ins, [fx.orgId, fx.unitIds[1], fx.tenantBId, 100, -1])).toBe("23514");
  });

  it("gateway_bills.amount_sen 0 and payment_allocations.amount_sen 0 are rejected", async () => {
    expect(
      await codeOf("insert into public.gateway_bills (org_id, lease_id, amount_sen) values ($1, $2, 0)", [fx.orgId, leaseId]),
    ).toBe("23514");
    expect(
      await codeOf(
        "insert into public.payment_allocations (org_id, lease_id, payment_id, invoice_id, amount_sen) values ($1, $2, $3, $4, 0)",
        [fx.orgId, leaseId, approvedId, fx.lease!.invoices[1].id],
      ),
    ).toBe("23514");
  });

  it("money columns are bigint (never numeric/float) and calendar dates are date, instants timestamptz", async () => {
    const rows = await sql<{ tbl: string; col: string; t: string }>(
      `select table_name as tbl, column_name as col, data_type as t from information_schema.columns
        where table_schema = 'public' and (column_name like '%\\_sen' or column_name in
          ('start_date','end_date','period_start','period_end','due_date','received_at','paid_at','created_at','decided_at','updated_at'))
        order by 1, 2`,
    );
    for (const r of rows) {
      if (r.col.endsWith("_sen")) expect(`${r.tbl}.${r.col}:${r.t}`).toBe(`${r.tbl}.${r.col}:bigint`);
      else if (r.col.endsWith("_at")) expect(`${r.tbl}.${r.col}:${r.t}`).toBe(`${r.tbl}.${r.col}:timestamp with time zone`);
      else expect(`${r.tbl}.${r.col}:${r.t}`).toBe(`${r.tbl}.${r.col}:date`);
    }
    expect(rows.filter((r) => r.col.endsWith("_sen")).length).toBeGreaterThanOrEqual(7);
  });
});

describe("R48 currency: MYR only (23514)", () => {
  it("leases / invoices / payments / gateway_bills refuse USD and lowercase myr", async () => {
    for (const cur of ["USD", "myr"]) {
      expect(
        await codeOf(
          `insert into public.leases (org_id, unit_id, tenant_id, start_date, end_date, monthly_rent_sen, deposit_sen, currency)
           values ($1, $2, $3, '2030-01-01', '2030-02-01', 100, 0, $4)`,
          [fx.orgId, fx.unitIds[1], fx.tenantBId, cur],
        ),
      ).toBe("23514");
      expect(
        await codeOf(
          `insert into public.invoices (org_id, lease_id, kind, period_index, period_start, period_end, due_date, amount_sen, currency)
           values ($1, $2, 'rent', 99, '2027-01-01', '2027-01-31', '2027-01-01', 100, $3)`,
          [fx.orgId, leaseId, cur],
        ),
      ).toBe("23514");
      expect(
        await codeOf(
          `insert into public.payments (org_id, lease_id, amount_sen, method, status, received_at, currency)
           values ($1, $2, 100, 'cash', 'approved', now(), $3)`,
          [fx.orgId, leaseId, cur],
        ),
      ).toBe("23514");
      expect(
        await codeOf("insert into public.gateway_bills (org_id, lease_id, amount_sen, currency) values ($1, $2, 100, $3)", [
          fx.orgId,
          leaseId,
          cur,
        ]),
      ).toBe("23514");
    }
  });
});

describe("R46 R48 leases: dates, overlap (23P01), composite FKs (23503)", () => {
  const ins = `insert into public.leases (org_id, unit_id, tenant_id, start_date, end_date, monthly_rent_sen, deposit_sen)
               values ($1, $2, $3, $4::date, $5::date, 100000, 0)`;

  it("end_date < start_date is rejected (23514); end_date = start_date is allowed", async () => {
    expect(await codeOf(ins, [fx.orgId, fx.unitIds[1], fx.tenantBId, "2030-02-01", "2030-01-31"])).toBe("23514");
    expect(await codeOf(ins, [fx.orgId, fx.unitIds[1], fx.tenantBId, "2030-02-01", "2030-02-01"])).toBeNull();
  });

  it("overlapping lease on the same unit is rejected 23P01, both dates inclusive", async () => {
    // existing lease on unitIds[0]: 2026-01-01 .. 2026-06-30
    expect(await codeOf(ins, [fx.orgId, fx.unitIds[0], fx.tenantBId, "2026-06-30", "2026-12-31"])).toBe("23P01");
    expect(await codeOf(ins, [fx.orgId, fx.unitIds[0], fx.tenantBId, "2025-06-01", "2026-01-01"])).toBe("23P01");
    expect(await codeOf(ins, [fx.orgId, fx.unitIds[0], fx.tenantBId, "2026-03-01", "2026-03-01"])).toBe("23P01");
    expect(await codeOf(ins, [fx.orgId, fx.unitIds[0], fx.tenantBId, "2025-01-01", "2027-01-01"])).toBe("23P01");
  });

  it("adjacent leases (end + 1 day) on the same unit and same dates on another unit are allowed", async () => {
    expect(await codeOf(ins, [fx.orgId, fx.unitIds[0], fx.tenantBId, "2026-07-01", "2026-12-31"])).toBeNull();
    expect(await codeOf(ins, [fx.orgId, fx.unitIds[0], fx.tenantBId, "2025-01-01", "2025-12-31"])).toBeNull();
    expect(await codeOf(ins, [fx.orgId, fx.unitIds[1], fx.tenantBId, "2026-01-01", "2026-06-30"])).toBeNull();
  });

  it("lease on another org's unit is rejected 23503 (composite FK (org_id, unit_id))", async () => {
    expect(await codeOf(ins, [fx.orgId, other.unitIds[1], fx.tenantBId, "2031-01-01", "2031-02-01"])).toBe("23503");
  });

  it("lease for another org's tenant is rejected 23503 (composite FK (org_id, tenant_id))", async () => {
    expect(await codeOf(ins, [fx.orgId, fx.unitIds[1], other.tenantBId, "2031-01-01", "2031-02-01"])).toBe("23503");
  });

  it("lease whose org_id is the other org but unit+tenant are ours is rejected 23503", async () => {
    expect(await codeOf(ins, [other.orgId, fx.unitIds[1], fx.tenantBId, "2031-01-01", "2031-02-01"])).toBe("23503");
  });

  it("lease terms are immutable after insert (UPDATE raises P0409)", async () => {
    expect(await codeOf("update public.leases set monthly_rent_sen = 1 where id = $1", [leaseId])).toBe("P0409");
    expect(await codeOf("update public.leases set org_id = $2 where id = $1", [leaseId, other.orgId])).not.toBeNull();
    expect(await codeOf("update public.leases set end_date = '2027-01-01' where id = $1", [leaseId])).toBe("P0409");
  });

  it("a lease with invoices cannot be deleted (ON DELETE RESTRICT, 23503)", async () => {
    expect(await codeOf("delete from public.leases where id = $1", [leaseId])).toBe("23503");
  });
});

describe("R12 R14 R16 R46 invoices: kind/period checks (23514) and uniqueness (23505)", () => {
  const ins = `insert into public.invoices (org_id, lease_id, kind, period_index, period_start, period_end, due_date, amount_sen)
               values ($1, $2, $3, $4, $5::date, $6::date, $7::date, 100)`;

  it("unknown kind is rejected", async () => {
    expect(await codeOf(ins, [fx.orgId, leaseId, "fee", 50, "2027-01-01", "2027-01-31", "2027-01-01"])).toBe("23514");
  });

  it("deposit with period fields is rejected", async () => {
    expect(await codeOf(ins, [fx.orgId, leaseId, "deposit", 0, null, null, "2026-01-01"])).toBe("23514");
    expect(await codeOf(ins, [fx.orgId, leaseId, "deposit", null, "2026-01-01", "2026-01-31", "2026-01-01"])).toBe("23514");
  });

  it("rent without period fields, negative index, end before start, or due != period start is rejected", async () => {
    expect(await codeOf(ins, [fx.orgId, leaseId, "rent", null, null, null, "2027-01-01"])).toBe("23514");
    expect(await codeOf(ins, [fx.orgId, leaseId, "rent", 50, null, "2027-01-31", "2027-01-01"])).toBe("23514");
    expect(await codeOf(ins, [fx.orgId, leaseId, "rent", -1, "2027-01-01", "2027-01-31", "2027-01-01"])).toBe("23514");
    expect(await codeOf(ins, [fx.orgId, leaseId, "rent", 50, "2027-01-31", "2027-01-01", "2027-01-31"])).toBe("23514");
    expect(await codeOf(ins, [fx.orgId, leaseId, "rent", 50, "2027-01-01", "2027-01-31", "2027-01-05"])).toBe("23514");
  });

  it("valid extra rent row is accepted (positive control for the checks above)", async () => {
    expect(await codeOf(ins, [fx.orgId, leaseId, "rent", 50, "2027-01-01", "2027-01-31", "2027-01-01"])).toBeNull();
  });

  it("duplicate (lease_id, period_index) is rejected 23505", async () => {
    const p1 = fx.lease!.invoices.find((i) => i.periodIndex === 1)!;
    expect(await codeOf(ins, [fx.orgId, leaseId, "rent", 1, "2027-01-01", "2027-01-31", "2027-01-01"])).toBe("23505");
    expect(p1).toBeDefined();
  });

  it("duplicate period_start on one lease (different index) is rejected 23505", async () => {
    const p1 = fx.lease!.invoices.find((i) => i.periodIndex === 1)!;
    expect(await codeOf(ins, [fx.orgId, leaseId, "rent", 77, p1.periodStart, p1.periodEnd, p1.dueDate])).toBe("23505");
  });

  it("a second deposit invoice on one lease is rejected 23505", async () => {
    expect(await codeOf(ins, [fx.orgId, leaseId, "deposit", null, null, null, "2026-01-01"])).toBe("23505");
  });

  it("invoice whose org_id differs from its lease's org is rejected 23503", async () => {
    expect(await codeOf(ins, [other.orgId, leaseId, "rent", 60, "2028-01-01", "2028-01-31", "2028-01-01"])).toBe("23503");
  });

  it("invoice amount and dates are immutable (UPDATE raises P0409); invoice with allocations cannot be deleted", async () => {
    const inv = fx.lease!.invoices[0];
    expect(await codeOf("update public.invoices set amount_sen = 1 where id = $1", [inv.id])).toBe("P0409");
    expect(await codeOf("update public.invoices set due_date = '2030-01-01' where id = $1", [inv.id])).toBe("P0409");
    expect(await codeOf("delete from public.invoices where id = $1", [inv.id])).toBe("23503");
  });
});

describe("R20 R21 R24 R25 payments: checks, composite FKs, append-only guard", () => {
  const ins = `insert into public.payments (org_id, lease_id, amount_sen, method, status, received_at, slip_path, unapplied_sen)
               values ($1, $2, 100, $3, $4, now(), $5, $6)`;

  it("unknown method / status are rejected 23514", async () => {
    expect(await codeOf(ins, [fx.orgId, leaseId, "cheque", "approved", null, 0])).toBe("23514");
    expect(await codeOf(ins, [fx.orgId, leaseId, "cash", "paid", null, 0])).toBe("23514");
  });

  it("bank_transfer without slip, cash with slip, slip in another org's folder are rejected 23514", async () => {
    expect(await codeOf(ins, [fx.orgId, leaseId, "bank_transfer", "approved", null, 0])).toBe("23514");
    expect(await codeOf(ins, [fx.orgId, leaseId, "cash", "approved", `${fx.orgId}/${leaseId}/x.png`, 0])).toBe("23514");
    expect(
      await codeOf(ins, [fx.orgId, leaseId, "bank_transfer", "pending_verification", `${other.orgId}/${leaseId}/x.png`, 0]),
    ).toBe("23514");
  });

  it("online without a gateway bill, and unapplied_sen on a manual payment / above amount, are rejected 23514", async () => {
    expect(await codeOf(ins, [fx.orgId, leaseId, "online", "approved", null, 0])).toBe("23514");
    expect(await codeOf(ins, [fx.orgId, leaseId, "cash", "approved", null, 50])).toBe("23514");
    expect(await codeOf(ins, [fx.orgId, leaseId, "cash", "approved", null, -1])).toBe("23514");
  });

  it("rejected / voided with a too-short reason is rejected 23514", async () => {
    const withReason = `insert into public.payments (org_id, lease_id, amount_sen, method, status, received_at, reason)
                        values ($1, $2, 100, 'cash', $3, now(), $4)`;
    expect(await codeOf(withReason, [fx.orgId, leaseId, "rejected", "no"])).toBe("23514");
    expect(await codeOf(withReason, [fx.orgId, leaseId, "voided", "    x   "])).toBe("23514");
  });

  // FINDING: char_length(btrim(NULL)) is NULL, so the CHECK evaluates to NULL and passes.
  it("rejected / voided with NO reason (NULL) is rejected 23514", async () => {
    expect(await codeOf(ins, [fx.orgId, leaseId, "cash", "rejected", null, 0])).toBe("23514");
    expect(
      await codeOf("update public.payments set status = 'rejected', reason = null where id = $1", [pendingId]),
    ).toBe("23514");
  });

  it("payment whose org_id differs from its lease's org is rejected 23503", async () => {
    expect(await codeOf(ins, [other.orgId, leaseId, "cash", "approved", null, 0])).toBe("23503");
  });

  it("allocation linking a payment to an invoice of another lease is rejected 23503", async () => {
    const otherInvoice = other.lease!.invoices[0].id;
    expect(
      await codeOf(
        "insert into public.payment_allocations (org_id, lease_id, payment_id, invoice_id, amount_sen) values ($1, $2, $3, $4, 1)",
        [fx.orgId, leaseId, approvedId, otherInvoice],
      ),
    ).toBe("23503");
    expect(
      await codeOf(
        "insert into public.payment_allocations (org_id, lease_id, payment_id, invoice_id, amount_sen) values ($1, $2, $3, $4, 1)",
        [other.orgId, leaseId, approvedId, fx.lease!.invoices[2].id],
      ),
    ).toBe("23503");
  });

  it("DELETE of a payment raises, also under session_replication_role = replica", async () => {
    expect(await codeOf("delete from public.payments where id = $1", [approvedId])).toBe("P0409");
    expect(
      await codeOf("delete from public.payments where id = $1", [approvedId], [{ text: "set local session_replication_role = replica" }]),
    ).toBe("P0409");
  });

  it("DELETE of a payment raises as service_role too", async () => {
    expect(await codeOf("delete from public.payments where id = $1", [approvedId], [{ text: "set local role service_role" }])).toBe(
      "P0409",
    );
  });

  it("TRUNCATE payments raises", async () => {
    // TRUNCATE on payments would cascade-fail on FKs anyway; the guard trigger must raise first.
    expect(await codeOf("truncate public.payments cascade")).not.toBeNull();
    const [{ n }] = await sql<{ n: number }>("select count(*)::int as n from public.payments where id = $1", [approvedId]);
    expect(n).toBe(1);
  });

  it("UPDATE of amount_sen / method / received_at / lease_id / org_id raises P0409", async () => {
    expect(await codeOf("update public.payments set amount_sen = 1 where id = $1", [approvedId])).toBe("P0409");
    expect(await codeOf("update public.payments set amount_sen = amount_sen + 1 where id = $1", [pendingId])).toBe("P0409");
    expect(await codeOf("update public.payments set received_at = now() where id = $1", [approvedId])).toBe("P0409");
    expect(await codeOf("update public.payments set idempotency_key = $2 where id = $1", [approvedId, randomUUID()])).toBe(
      "P0409",
    );
    expect(await codeOf("update public.payments set org_id = $2 where id = $1", [approvedId, other.orgId])).not.toBeNull();
  });

  it("bad status transitions raise P0409: rejected->approved, voided->approved, approved->pending, rejected->voided", async () => {
    const up = "update public.payments set status = $2, reason = coalesce(reason, 'because') where id = $1";
    expect(await codeOf(up, [rejectedId, "approved"])).toBe("P0409");
    expect(await codeOf(up, [voidedId, "approved"])).toBe("P0409");
    expect(await codeOf(up, [approvedId, "pending_verification"])).toBe("P0409");
    expect(await codeOf(up, [rejectedId, "voided"])).toBe("P0409");
    expect(await codeOf(up, [pendingId, "voided"])).toBe("P0409");
  });

  it("allowed transition pending->approved passes the guard (positive control, rolled back)", async () => {
    expect(await codeOf("update public.payments set status = 'approved' where id = $1", [pendingId])).toBeNull();
  });

  it("payment_allocations rows cannot be updated in place", async () => {
    const [a] = await sql<{ id: string }>("select id from public.payment_allocations where payment_id = $1 limit 1", [approvedId]);
    expect(a).toBeDefined();
    expect(await codeOf("update public.payment_allocations set amount_sen = 1 where id = $1", [a.id])).toBe("P0409");
  });

  it("an allocated payment cannot be orphaned: deleting its invoice fails (RESTRICT)", async () => {
    const [a] = await sql<{ invoice_id: string }>("select invoice_id from public.payment_allocations where payment_id = $1 limit 1", [
      approvedId,
    ]);
    expect(await codeOf("delete from public.invoices where id = $1", [a.invoice_id])).toBe("23503");
  });
});

describe("R34 gateway_bills: status only moves forward, never deleted", () => {
  let billId: string;
  beforeAll(async () => {
    const [b] = await sql<{ id: string }>("select id from private.create_gateway_bill($1, $2, $3::timestamptz)", [
      fx.users.tenantA.userId,
      leaseId,
      "2026-03-15T12:00:00+08:00",
    ]);
    billId = b.id;
  });

  it("unknown status rejected 23514; paid without paid_at rejected 23514", async () => {
    // The BEFORE UPDATE guard trigger runs before the CHECK, so either SQLSTATE proves the refusal.
    expect(["23514", "P0409"]).toContain(await codeOf("update public.gateway_bills set status = 'refunded' where id = $1", [billId]));
    expect(await codeOf("update public.gateway_bills set status = 'paid' where id = $1", [billId])).toBe("23514");
  });

  it("paid -> pending and paid -> failed raise; amount is immutable; DELETE raises", async () => {
    const toPaid: Pre = { text: "update public.gateway_bills set status = 'paid', paid_at = now() where id = $1", params: [billId] };
    expect(await codeOf("update public.gateway_bills set status = 'pending' where id = $1", [billId], [toPaid])).toBe("P0409");
    expect(await codeOf("update public.gateway_bills set status = 'failed' where id = $1", [billId], [toPaid])).toBe("P0409");
    expect(await codeOf("update public.gateway_bills set amount_sen = 1 where id = $1", [billId])).toBe("P0409");
    expect(await codeOf("delete from public.gateway_bills where id = $1", [billId])).toBe("P0409");
  });
});

describe("R2 R37 memberships / tenants / units checks", () => {
  it("membership role outside manager/staff is rejected 23514 (no 'tenant' or 'owner' membership)", async () => {
    const u = fx.users.tenantA.userId;
    expect(await codeOf("insert into public.memberships (user_id, org_id, role) values ($1, $2, 'owner')", [u, fx.orgId])).toBe("23514");
    expect(await codeOf("insert into public.memberships (user_id, org_id, role) values ($1, $2, 'tenant')", [u, fx.orgId])).toBe(
      "23514",
    );
  });

  it("a staff/manager belongs to exactly one org: second membership for the same user is rejected 23505", async () => {
    expect(
      await codeOf("insert into public.memberships (user_id, org_id, role) values ($1, $2, 'manager')", [fx.users.staff.userId, other.orgId]),
    ).toBe("23505");
  });

  it("one tenant row per (org, user) and phone format is checked", async () => {
    expect(
      await codeOf("insert into public.tenants (org_id, user_id, full_name, email) values ($1, $2, 'Dup', 'd@x.test')", [
        fx.orgId,
        fx.users.tenantA.userId,
      ]),
    ).toBe("23505");
    expect(await codeOf("update public.tenants set phone = 'call me' where id = $1", [fx.tenantAId])).toBe("23514");
    expect(await codeOf("update public.tenants set phone = '+60 12-345 6789' where id = $1", [fx.tenantAId])).toBeNull();
  });

  it("duplicate unit name within an org is rejected 23505, same name in another org is fine", async () => {
    const name = `Dup-${randomUUID().slice(0, 6)}`;
    const id = await insertUnit(fx.orgId, name);
    expect(id).toBeTruthy();
    expect(await codeOf("insert into public.units (org_id, name) values ($1, $2)", [fx.orgId, name])).toBe("23505");
    expect(await codeOf("insert into public.units (org_id, name) values ($1, $2)", [other.orgId, name])).toBeNull();
  });

  it("insertTenant helper rows still satisfy the composite FK model (sanity)", async () => {
    const t = await insertTenant(fx.orgId, null, "Walk-in Tenant", "walkin@fixture.test");
    expect(t).toBeTruthy();
  });
});

describe("R43 audit_log append-only for every role, including owner and service_role", () => {
  let auditId: number;
  beforeAll(async () => {
    const [r] = await sql<{ id: number }>("select id from public.audit_log where org_id = $1 order by id limit 1", [fx.orgId]);
    expect(r).toBeDefined(); // written by private.record_payment in the outer beforeAll
    auditId = r.id;
  });

  it("UPDATE raises as postgres", async () => {
    expect(await codeOf("update public.audit_log set action = 'tampered' where id = $1", [auditId])).toBe("P0409");
    expect(await codeOf("update public.audit_log set details = '{}'::jsonb where org_id = $1", [fx.orgId])).toBe("P0409");
  });

  it("DELETE raises as postgres", async () => {
    expect(await codeOf("delete from public.audit_log where id = $1", [auditId])).toBe("P0409");
  });

  it("TRUNCATE raises as postgres", async () => {
    expect(await codeOf("truncate public.audit_log")).toBe("P0409");
  });

  it("UPDATE / DELETE / TRUNCATE raise as service_role", async () => {
    const asService: Pre[] = [{ text: "set local role service_role" }];
    expect(await codeOf("update public.audit_log set action = 'x' where id = $1", [auditId], asService)).not.toBeNull();
    expect(await codeOf("delete from public.audit_log where id = $1", [auditId], asService)).not.toBeNull();
    expect(await codeOf("truncate public.audit_log", [], asService)).not.toBeNull();
  });

  it("UPDATE / DELETE / TRUNCATE still raise under session_replication_role = replica (ALWAYS triggers)", async () => {
    const replica: Pre[] = [{ text: "set local session_replication_role = replica" }];
    expect(await codeOf("update public.audit_log set action = 'x' where id = $1", [auditId], replica)).toBe("P0409");
    expect(await codeOf("delete from public.audit_log where id = $1", [auditId], replica)).toBe("P0409");
    expect(await codeOf("truncate public.audit_log", [], replica)).toBe("P0409");
  });

  it("the row is unchanged after all attempts", async () => {
    const [r] = await sql<{ n: number }>("select count(*)::int as n from public.audit_log where id = $1", [auditId]);
    expect(r.n).toBe(1);
  });

  it("INSERT still works for the owner (append is allowed, rolled back)", async () => {
    expect(
      await codeOf("insert into public.audit_log (org_id, action, details) values ($1, 'test.append', '{}'::jsonb)", [fx.orgId]),
    ).toBeNull();
  });
});
