import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, newConnection, sql } from "../helpers/db";
import { env } from "../helpers/env";
import { createFixtureOrg, type FixtureLease, type FixtureOrg } from "../helpers/fixtures";
import { gatewaySignature, signedCallback } from "../helpers/gateway";
import { api, postForm, type HttpResult } from "../helpers/http";
import {
  ROUNDS,
  allocationOrder,
  backendPid,
  expectErrorBody,
  expectNo5xx,
  expectedFill,
  invoicePaid,
  leaseAllocatedSen,
  mytToday,
  newLease,
  waitForBlockedBy,
  waitForPidOnLock,
} from "../concurrency/support";

// R30 R32-R35 D10 D11: the gateway webhook over real HTTP (form-urlencoded raw body) and the
// gateway-bills route, against the dev server. Each scenario creates its own bill on its own lease.

const HOOK = "/api/webhooks/gateway";
// Every invoice is long past due: deposit RM 500 + 3 x RM 1,000 = RM 3,500 due now.
const LEASE_PAST = { startDate: "2026-01-01", endDate: "2026-03-31", monthlyRentSen: 100_000, depositSen: 50_000 };
const PAST_TOTAL = 350_000;
// Some invoices due now, some in the future (relative to today in Malaysia).
const LEASE_SPAN = { startDate: "2026-09-01", endDate: "2027-02-28", monthlyRentSen: 100_000, depositSen: 50_000 };
// Nothing due yet: the first due date is in the future.
const LEASE_FUTURE = { startDate: "2027-06-01", endDate: "2027-12-31", monthlyRentSen: 100_000, depositSen: 50_000 };
// signedCallback's default paid_at "2026-04-01 00:30:12 +0800" as an instant.
const DEFAULT_PAID_AT_MS = Date.parse("2026-03-31T16:30:12Z");
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let fx: FixtureOrg;
let other: FixtureOrg;

interface Bill {
  billId: string;
  amountSen: number;
}

async function createBill(lease: FixtureLease, token = fx.tokens.tenantA): Promise<Bill> {
  const r = await api(token).post<Bill>(`/api/leases/${lease.id}/gateway-bills`);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
}

async function billRow(id: string) {
  const rows = await sql<{ status: string; amount_sen: number; paid_at: Date | null; transaction_id: string | null }>(
    "select status, amount_sen, paid_at, transaction_id from public.gateway_bills where id = $1",
    [id],
  );
  return rows[0];
}

async function billPayments(billId: string) {
  return sql<{
    id: string;
    method: string;
    status: string;
    amount_sen: number;
    unapplied_sen: number;
    received_at: Date;
    lease_id: string;
  }>(
    `select id, method, status, amount_sen, unapplied_sen, received_at, lease_id
       from public.payments where gateway_bill_id = $1`,
    [billId],
  );
}

const hook = (fields: Record<string, string> | Array<[string, string]>) => postForm(HOOK, fields);
const tx = () => `TX-${randomUUID().slice(0, 12)}`;

/** A bill on a fresh LEASE_PAST lease. */
async function freshBill(): Promise<{ lease: FixtureLease; bill: Bill }> {
  const lease = await newLease(fx, LEASE_PAST);
  return { lease, bill: await createBill(lease) };
}

beforeAll(async () => {
  [fx, other] = await Promise.all([createFixtureOrg({ units: 1 }), createFixtureOrg({ units: 1 })]);
});

afterAll(async () => {
  await closePool();
});

describe("R33 signature: the brief's test vector", () => {
  it("reproduces 06994fab… with key test_x_signature_key", () => {
    const fields = {
      id: "bill_8f3a2c",
      paid: "true",
      paid_amount: "210050",
      paid_at: "2026-04-01 00:30:12 +0800",
      transaction_id: "TX-000123",
      transaction_status: "completed",
    };
    expect(gatewaySignature(fields, "test_x_signature_key")).toBe(
      "06994fab2d674e7829144eaa2204631716d3c099b503d38945e92b6296531641",
    );
    // the local key is the brief's test key, so the app verifies with the same secret
    expect(env.gatewayKey).toBe("test_x_signature_key");
  });
});

describe("R34 R33 forged or missing signatures -> 401, no effect", () => {
  it("missing, empty, wrong, wrong-length, non-hex and other-key signatures are 401", async () => {
    const { lease, bill } = await freshBill();
    const good = signedCallback(bill.billId, bill.amountSen, true, { transaction_id: tx() });
    const unsigned: Record<string, string> = { ...good };
    delete unsigned.x_signature;
    const flipped = good.x_signature.replace(/^./, (c) => (c === "0" ? "1" : "0"));
    const cases: Record<string, string>[] = [
      unsigned,
      { ...good, x_signature: "" },
      { ...good, x_signature: flipped },
      { ...good, x_signature: good.x_signature.slice(0, 32) },
      { ...good, x_signature: `${good.x_signature}00` },
      { ...good, x_signature: "z".repeat(64) },
      signedCallback(bill.billId, bill.amountSen, true, { transaction_id: tx() }, "not_the_key"),
    ];
    const rs = await Promise.all(cases.map(hook));
    for (const r of rs) {
      expect(r.status).toBe(401);
      expectErrorBody(r);
    }
    expect((await billRow(bill.billId)).status).toBe("pending");
    expect(await billPayments(bill.billId)).toHaveLength(0);
    expect(await leaseAllocatedSen(lease.id)).toBe(0);
  });

  it("a signature over different field values -> 401 (amount, paid flag, bill id, paid_at tampered)", async () => {
    const { bill } = await freshBill();
    const good = signedCallback(bill.billId, bill.amountSen, true, { transaction_id: tx() });
    const tampered: Record<string, string>[] = [
      { ...good, paid_amount: String(bill.amountSen + 1) },
      { ...signedCallback(bill.billId, bill.amountSen, false), paid: "true", paid_amount: String(bill.amountSen) },
      { ...good, paid_at: "2026-04-02 00:30:12 +0800" },
      { ...good, transaction_status: "failed" },
    ];
    for (const f of tampered) expect((await hook(f)).status).toBe(401);
    expect((await billRow(bill.billId)).status).toBe("pending");
    expect(await billPayments(bill.billId)).toHaveLength(0);
  });

  it("hostile bodies never 500: empty, JSON, garbage -> 401", async () => {
    const raw = (body: string, type = "application/x-www-form-urlencoded") =>
      fetch(`${env.baseUrl}${HOOK}`, { method: "POST", headers: { "content-type": type }, body, redirect: "manual" });
    const rs = await Promise.all([
      raw(""),
      raw(JSON.stringify({ id: randomUUID(), paid: "true" }), "application/json"),
      raw("%%%&&&==="),
      raw("x_signature"),
    ]);
    for (const r of rs) expect(r.status).toBe(401);
  });

  // D52: a repeated key makes the signed source ambiguous, so it is a signature failure (401), not a 400.
  it("duplicate keys in the body (a field, the id, x_signature itself) -> 401 { error }, no effect (D52)", async () => {
    const { bill } = await freshBill();
    const good = signedCallback(bill.billId, bill.amountSen, true, { transaction_id: tx() });
    const pairs = Object.entries(good);
    const rs = await Promise.all([
      hook([...pairs, ["paid", "false"]]),
      hook([["id", randomUUID()], ...pairs]),
      hook([...pairs, ["x_signature", good.x_signature]]),
    ]);
    for (const r of rs) {
      expect(r.status).toBe(401);
      expectErrorBody(r);
    }
    expect((await billRow(bill.billId)).status).toBe("pending");
    expect(await billPayments(bill.billId)).toHaveLength(0);
  });

  it("extra unknown field included in the signature -> 200 accepted; an extra field NOT signed -> 401", async () => {
    const a = await freshBill();
    const unsignedExtra = { ...signedCallback(a.bill.billId, a.bill.amountSen, true, { transaction_id: tx() }), currency: "MYR" };
    expect((await hook(unsignedExtra)).status).toBe(401);
    expect((await billRow(a.bill.billId)).status).toBe("pending");

    const signedExtra = signedCallback(a.bill.billId, a.bill.amountSen, true, {
      transaction_id: tx(),
      currency: "MYR",
      Zeta: "upper-case key sorts before lower-case",
      _meta: "underscore",
    });
    const r = await hook(signedExtra);
    expect(r.status).toBe(200);
    expect((await billRow(a.bill.billId)).status).toBe("paid");
    expect(await billPayments(a.bill.billId)).toHaveLength(1);
  });
});

describe("R34 webhook state table, row by row", () => {
  it("unknown bill: a random uuid and the brief's 'bill_8f3a2c' -> 404 (correctly signed)", async () => {
    const rs = await Promise.all([
      hook(signedCallback(randomUUID(), 1000, true)),
      hook(signedCallback(randomUUID(), 0, false)),
      hook(signedCallback("bill_8f3a2c", 210050, true, { transaction_id: "TX-000123" })),
    ]);
    for (const r of rs) {
      expect(r.status).toBe(404);
      expectErrorBody(r);
    }
  });

  it("paid=true with the wrong amount -> 422, no effect (bill pending, no payment)", async () => {
    const { lease, bill } = await freshBill();
    for (const amt of [bill.amountSen + 1, bill.amountSen - 1, 0]) {
      const r = await hook(signedCallback(bill.billId, bill.amountSen, true, { paid_amount: String(amt), transaction_id: tx() }));
      expect(r.status).toBe(422);
      expectErrorBody(r);
    }
    expect((await billRow(bill.billId)).status).toBe("pending");
    expect(await billPayments(bill.billId)).toHaveLength(0);
    expect(await leaseAllocatedSen(lease.id)).toBe(0);
  });

  // D53: a non-integer paid_amount is "not the bill's amount" (422); a malformed paid_at on a pending bill is 400.
  it("malformed paid_amount -> 422, malformed paid_at -> 400 with a valid signature, never 500, no effect", async () => {
    const { bill } = await freshBill();
    const rs = await Promise.all([
      hook(signedCallback(bill.billId, bill.amountSen, true, { paid_amount: "3500.00" })),
      hook(signedCallback(bill.billId, bill.amountSen, true, { paid_amount: "-350000" })),
      hook(signedCallback(bill.billId, bill.amountSen, true, { paid_amount: "1e9" })),
    ]);
    for (const r of rs) {
      expect(r.status).toBe(422);
      expectErrorBody(r);
    }
    const badAt = await hook(signedCallback(bill.billId, bill.amountSen, true, { paid_at: "yesterday" }));
    expect(badAt.status).toBe(400);
    expectErrorBody(badAt);
    const odd = await hook(signedCallback(bill.billId, bill.amountSen, true, { paid: "maybe" }));
    expect(odd.status).toBeGreaterThanOrEqual(400);
    expect(odd.status).toBeLessThan(500);
    expect((await billRow(bill.billId)).status).toBe("pending");
    expect(await billPayments(bill.billId)).toHaveLength(0);
  });

  it("paid=true on a pending bill -> 200, bill paid, one approved online payment with received_at = paid_at, allocated in order; repeat -> 200, nothing new", async () => {
    const lease = await newLease(fx, LEASE_SPAN);
    const today = mytToday();
    const due = lease.invoices.filter((i) => i.dueDate <= today).reduce((s, i) => s + i.amountSen, 0);
    const bill = await createBill(lease);
    expect(bill.amountSen).toBe(due);

    const transactionId = tx();
    const r = await hook(signedCallback(bill.billId, bill.amountSen, true, { transaction_id: transactionId }));
    expect(r.status).toBe(200);
    const b = await billRow(bill.billId);
    expect(b.status).toBe("paid");
    expect(b.paid_at?.getTime()).toBe(DEFAULT_PAID_AT_MS);
    expect(b.transaction_id).toBe(transactionId);

    const pays = await billPayments(bill.billId);
    expect(pays).toHaveLength(1);
    expect(pays[0]).toMatchObject({ method: "online", status: "approved", amount_sen: due, unapplied_sen: 0, lease_id: lease.id });
    // received_at = paid_at, the exact instant ("2026-04-01 00:30:12 +0800" = 2026-03-31T16:30:12Z)
    expect(pays[0].received_at.getTime()).toBe(DEFAULT_PAID_AT_MS);
    const exact = await sql<{ ok: boolean }>(
      "select received_at = '2026-03-31T16:30:12Z'::timestamptz as ok from public.payments where id = $1",
      [pays[0].id],
    );
    expect(exact[0].ok).toBe(true);

    // allocated in the brief's order: exactly the invoices due now are filled, nothing beyond
    const expected = expectedFill(lease.invoices, [due]);
    const actual = new Map((await invoicePaid(lease.id)).map((i) => [i.id, i.paid_sen]));
    for (const inv of allocationOrder(lease.invoices)) expect(actual.get(inv.id)).toBe(expected.get(inv.id));

    // the API shows the same: online payment, receivedAt in MYT with an offset
    const view = await api(fx.tokens.tenantA).get<{ payments: { id: string; method: string; status: string; receivedAt: string }[] }>(
      `/api/leases/${lease.id}`,
    );
    expect(view.status).toBe(200);
    const shown = view.body.payments.find((p) => p.id === pays[0].id)!;
    expect(shown).toMatchObject({ method: "online", status: "approved" });
    expect(Date.parse(shown.receivedAt)).toBe(DEFAULT_PAID_AT_MS);

    // repeat delivery (and a fresh transaction id from a retrying gateway) -> 200, no effect
    for (const t of [transactionId, tx()]) {
      const again = await hook(signedCallback(bill.billId, bill.amountSen, true, { transaction_id: t }));
      expect(again.status).toBe(200);
    }
    expect(await billPayments(bill.billId)).toHaveLength(1);
    expect((await billRow(bill.billId)).transaction_id).toBe(transactionId);
    expect(await leaseAllocatedSen(lease.id)).toBe(due);
  });

  it("paid=false on a pending bill -> 200 failed; repeat -> 200 still failed; paid=true after failed -> 200 paid + one payment", async () => {
    const { lease, bill } = await freshBill();
    const f1 = await hook(signedCallback(bill.billId, bill.amountSen, false, { transaction_id: tx() }));
    expect(f1.status).toBe(200);
    expect((await billRow(bill.billId)).status).toBe("failed");
    const f2 = await hook(signedCallback(bill.billId, bill.amountSen, false, { transaction_id: tx() }));
    expect(f2.status).toBe(200);
    expect((await billRow(bill.billId)).status).toBe("failed");
    expect(await billPayments(bill.billId)).toHaveLength(0);

    const p = await hook(signedCallback(bill.billId, bill.amountSen, true, { transaction_id: tx() }));
    expect(p.status).toBe(200);
    expect((await billRow(bill.billId)).status).toBe("paid");
    expect(await billPayments(bill.billId)).toHaveLength(1);
    expect(await leaseAllocatedSen(lease.id)).toBe(PAST_TOTAL);
  });

  it("paid=false after paid (late / out of order) -> 200, the bill stays paid, payment untouched", async () => {
    const { lease, bill } = await freshBill();
    expect((await hook(signedCallback(bill.billId, bill.amountSen, true, { transaction_id: tx() }))).status).toBe(200);
    const late = await Promise.all([
      hook(signedCallback(bill.billId, bill.amountSen, false, { transaction_id: tx() })),
      hook(signedCallback(bill.billId, bill.amountSen, false, { transaction_id: tx(), transaction_status: "pending" })),
    ]);
    for (const r of late) expect(r.status).toBe(200);
    expect((await billRow(bill.billId)).status).toBe("paid");
    const pays = await billPayments(bill.billId);
    expect(pays).toHaveLength(1);
    expect(pays[0].status).toBe("approved");
    expect(await leaseAllocatedSen(lease.id)).toBe(PAST_TOTAL);
  });

  it("paid=true with the wrong amount on an already paid bill -> 422, still one payment", async () => {
    const { bill } = await freshBill();
    expect((await hook(signedCallback(bill.billId, bill.amountSen, true, { transaction_id: tx() }))).status).toBe(200);
    const r = await hook(signedCallback(bill.billId, bill.amountSen, true, { paid_amount: "1", transaction_id: tx() }));
    expect(r.status).toBe(422);
    expect(await billPayments(bill.billId)).toHaveLength(1);
  });
});

describe("R35 D10 concurrent deliveries: a bill creates at most one payment, ever", () => {
  it(`10 identical paid=true callbacks at the same moment -> all 200, exactly one payment, x${ROUNDS}`, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const { lease, bill } = await freshBill();
      const body = signedCallback(bill.billId, bill.amountSen, true, { transaction_id: tx() });
      const rs = await Promise.all(Array.from({ length: 10 }, () => hook(body)));
      expectNo5xx(rs);
      expect(rs.map((r) => r.status)).toEqual(Array(10).fill(200));
      expect(await billPayments(bill.billId)).toHaveLength(1);
      expect((await billRow(bill.billId)).status).toBe("paid");
      expect(await leaseAllocatedSen(lease.id)).toBe(PAST_TOTAL);
      const audits = await sql<{ n: number }>(
        "select count(*)::bigint as n from public.audit_log where action = 'gateway_bill.paid' and entity_id = $1",
        [bill.billId],
      );
      expect(audits[0].n).toBe(1);
    }
  });

  it(`10 paid=true deliveries with DIFFERENT transaction ids at once -> one payment, x${ROUNDS}`, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const { bill } = await freshBill();
      const rs = await Promise.all(
        Array.from({ length: 10 }, () => hook(signedCallback(bill.billId, bill.amountSen, true, { transaction_id: tx() }))),
      );
      expectNo5xx(rs);
      expect(rs.every((r) => r.status === 200)).toBe(true);
      expect(await billPayments(bill.billId)).toHaveLength(1);
    }
  });

  it(`mixed concurrent paid=true and paid=false -> final paid with one payment, never paid -> failed, x${ROUNDS}`, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const { lease, bill } = await freshBill();
      const bodies = Array.from({ length: 10 }, (_, i) =>
        signedCallback(bill.billId, bill.amountSen, i % 2 === 0, { transaction_id: tx() }),
      );
      const rs = await Promise.all(bodies.map(hook));
      expectNo5xx(rs);
      expect(rs.every((r) => r.status === 200)).toBe(true);
      expect((await billRow(bill.billId)).status).toBe("paid");
      expect(await billPayments(bill.billId)).toHaveLength(1);
      expect(await leaseAllocatedSen(lease.id)).toBe(PAST_TOTAL);
      // the audit trail shows no gateway_bill.failed after gateway_bill.paid (status only moves forward)
      const trail = await sql<{ action: string }>(
        `select action from public.audit_log
          where entity_id = $1 and action in ('gateway_bill.paid', 'gateway_bill.failed') order by id`,
        [bill.billId],
      );
      const paidAt = trail.findIndex((t) => t.action === "gateway_bill.paid");
      expect(paidAt).toBeGreaterThanOrEqual(0);
      expect(trail.slice(paidAt + 1).map((t) => t.action)).toEqual([]);
    }
  });

  it("two different bills of one lease paid at once -> two payments; the second is unapplied, balance never exceeded", async () => {
    const lease = await newLease(fx, LEASE_PAST);
    const [b1, b2] = await Promise.all([createBill(lease), createBill(lease)]);
    expect(b1.billId).not.toBe(b2.billId);
    const rs = await Promise.all([
      hook(signedCallback(b1.billId, b1.amountSen, true, { transaction_id: tx() })),
      hook(signedCallback(b2.billId, b2.amountSen, true, { transaction_id: tx() })),
    ]);
    expect(rs.map((r) => r.status)).toEqual([200, 200]);
    const pays = [...(await billPayments(b1.billId)), ...(await billPayments(b2.billId))];
    expect(pays).toHaveLength(2);
    expect(pays.map((p) => p.unapplied_sen).sort((a, b) => a - b)).toEqual([0, PAST_TOTAL]);
    expect(await leaseAllocatedSen(lease.id)).toBe(PAST_TOTAL);
  });
});

describe("R35 D7 D10 forced overlap: apply_gateway_callback holds the bill lock until commit", () => {
  const applySql = "select * from private.apply_gateway_callback($1::uuid, true, $2::bigint, $3::timestamptz, $4, 'completed')";

  it("SQL x SQL: session 2 waits on a Lock while session 1 is uncommitted, then returns 'duplicate'", async () => {
    const { bill } = await freshBill();
    const c1 = await newConnection();
    const c2 = await newConnection();
    let second: Promise<pg.QueryResult<{ outcome: string; payment_id: string }>> | undefined;
    try {
      await c1.query("begin");
      const first = await c1.query<{ outcome: string; payment_id: string }>(applySql, [
        bill.billId,
        bill.amountSen,
        "2026-04-01T00:30:12+08:00",
        tx(),
      ]);
      expect(first.rows[0].outcome).toBe("paid");
      const pid2 = await backendPid(c2);
      second = c2.query(applySql, [bill.billId, bill.amountSen, "2026-04-01T00:30:12+08:00", tx()]);
      second.catch(() => undefined);
      expect(await waitForPidOnLock(pid2)).toBe("Lock");
      await c1.query("commit");
      const res = await second;
      expect(res.rows[0]).toEqual({ outcome: "duplicate", payment_id: first.rows[0].payment_id });
      expect(await billPayments(bill.billId)).toHaveLength(1);
    } finally {
      await c1.query("rollback").catch(() => undefined);
      if (second) await second.catch(() => undefined);
      await c1.end();
      await c2.end();
    }
  });

  it("SQL x HTTP: the webhook blocks on the bill lock held by an open transaction, then answers 200 with no second payment", async () => {
    const { bill } = await freshBill();
    const c1 = await newConnection();
    let http: Promise<HttpResult> | undefined;
    try {
      await c1.query("begin");
      const first = await c1.query<{ outcome: string; payment_id: string }>(applySql, [
        bill.billId,
        bill.amountSen,
        "2026-04-01T00:30:12+08:00",
        tx(),
      ]);
      const holder = await backendPid(c1);
      http = hook(signedCallback(bill.billId, bill.amountSen, true, { transaction_id: tx() }));
      const blocked = await waitForBlockedBy(holder);
      expect(blocked.wait_event_type).toBe("Lock");
      expect(blocked.query).toMatch(/apply_gateway_callback/);
      await c1.query("commit");
      const res = await http;
      expect(res.status).toBe(200);
      const pays = await billPayments(bill.billId);
      expect(pays.map((p) => p.id)).toEqual([first.rows[0].payment_id]);
    } finally {
      await c1.query("rollback").catch(() => undefined);
      if (http) await http.catch(() => undefined);
      await c1.end();
    }
  });
});

describe("R26 R34 captured money is never rejected: paid after a manual payment settled the invoices", () => {
  it("tenant bill, manager pays everything by cash, then the callback -> 200, approved online payment fully unapplied", async () => {
    const { lease, bill } = await freshBill();
    expect(bill.amountSen).toBe(PAST_TOTAL);
    const cash = await api(fx.tokens.manager).post<{ status: string }>(`/api/leases/${lease.id}/payments`, {
      amountSen: PAST_TOTAL,
      method: "cash",
      receivedAt: "2026-03-01T09:00:00+08:00",
    });
    expect(cash.status).toBe(201);
    expect(cash.body.status).toBe("approved");

    const r = await hook(signedCallback(bill.billId, bill.amountSen, true, { transaction_id: tx() }));
    expect(r.status).toBe(200);
    const pays = await billPayments(bill.billId);
    expect(pays).toHaveLength(1);
    expect(pays[0]).toMatchObject({ status: "approved", method: "online", amount_sen: PAST_TOTAL, unapplied_sen: PAST_TOTAL });
    // balance consistent: no invoice over-allocated, total allocations = total invoiced
    for (const inv of await invoicePaid(lease.id)) expect(inv.paid_sen).toBe(inv.amount_sen);
    expect(await leaseAllocatedSen(lease.id)).toBe(PAST_TOTAL);
  });

  it("a partial cash payment first -> the online payment allocates what is left and keeps the rest unapplied", async () => {
    const { lease, bill } = await freshBill();
    const cash = await api(fx.tokens.manager).post(`/api/leases/${lease.id}/payments`, {
      amountSen: 100_000,
      method: "cash",
      receivedAt: "2026-03-01T09:00:00+08:00",
    });
    expect(cash.status).toBe(201);
    expect((await hook(signedCallback(bill.billId, bill.amountSen, true, { transaction_id: tx() }))).status).toBe(200);
    const [p] = await billPayments(bill.billId);
    expect(p.unapplied_sen).toBe(100_000);
    expect(await leaseAllocatedSen(lease.id)).toBe(PAST_TOTAL);
    for (const inv of await invoicePaid(lease.id)) expect(inv.paid_sen).toBeLessThanOrEqual(inv.amount_sen);
  });
});

describe("R30 gateway bill creation (POST /api/leases/:leaseId/gateway-bills)", () => {
  it("tenant on a lease with something due -> 201 { billId (uuid v4), amountSen = Σ unpaid of invoices due on or before today MYT }", async () => {
    const lease = await newLease(fx, LEASE_SPAN);
    // a manager cash payment first, so 'unpaid' is not just 'amount'
    const cash = await api(fx.tokens.manager).post(`/api/leases/${lease.id}/payments`, {
      amountSen: 30_000,
      method: "cash",
      receivedAt: "2026-09-01T09:00:00+08:00",
    });
    expect(cash.status).toBe(201);
    const today = mytToday();
    const paid = expectedFill(lease.invoices, [30_000]);
    const due = lease.invoices
      .filter((i) => i.dueDate <= today)
      .reduce((s, i) => s + i.amountSen - (paid.get(i.id) ?? 0), 0);

    const r = await api(fx.tokens.tenantA).post<Bill>(`/api/leases/${lease.id}/gateway-bills`);
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ billId: expect.stringMatching(UUID_V4), amountSen: due });
    const row = await billRow(r.body.billId);
    expect(row).toMatchObject({ status: "pending", amount_sen: due });
  });

  it("two bills (sequential and concurrent) have different uuid v4 ids", async () => {
    const lease = await newLease(fx, LEASE_PAST);
    const a = await createBill(lease);
    const rest = await Promise.all(Array.from({ length: 4 }, () => createBill(lease)));
    const ids = [a, ...rest].map((b) => b.billId);
    for (const id of ids) expect(id).toMatch(UUID_V4);
    expect(new Set(ids).size).toBe(ids.length);
    for (const b of rest) expect(b.amountSen).toBe(PAST_TOTAL);
  });

  it("nothing due -> 422: a lease starting in the future, and a fully paid lease", async () => {
    const future = await newLease(fx, LEASE_FUTURE);
    const r1 = await api(fx.tokens.tenantA).post(`/api/leases/${future.id}/gateway-bills`);
    expect(r1.status).toBe(422);
    expectErrorBody(r1);

    const paidUp = await newLease(fx, LEASE_PAST);
    const cash = await api(fx.tokens.manager).post(`/api/leases/${paidUp.id}/payments`, {
      amountSen: PAST_TOTAL,
      method: "cash",
      receivedAt: "2026-03-01T09:00:00+08:00",
    });
    expect(cash.status).toBe(201);
    const r2 = await api(fx.tokens.tenantA).post(`/api/leases/${paidUp.id}/gateway-bills`);
    expect(r2.status).toBe(422);
    const bills = await sql<{ n: number }>("select count(*)::bigint as n from public.gateway_bills where lease_id = any($1)", [
      [future.id, paidUp.id],
    ]);
    expect(bills[0].n).toBe(0);
  });

  it("staff / manager of the org -> 403; another tenant, another org, unknown lease -> 404; no login -> 401; no bill created", async () => {
    const lease = await newLease(fx, LEASE_PAST);
    const p = `/api/leases/${lease.id}/gateway-bills`;
    const [staff, manager, tenantB, otherTenant, otherManager, anon] = await Promise.all([
      api(fx.tokens.staff).post(p),
      api(fx.tokens.manager).post(p),
      api(fx.tokens.tenantB).post(p),
      api(other.tokens.tenantA).post(p),
      api(other.tokens.manager).post(p),
      api().post(p),
    ]);
    expect(staff.status).toBe(403);
    expect(manager.status).toBe(403);
    expect(tenantB.status).toBe(404);
    expect(otherTenant.status).toBe(404);
    expect(otherManager.status).toBe(404);
    expect(anon.status).toBe(401);
    for (const r of [staff, manager, tenantB, otherTenant, otherManager, anon]) expectErrorBody(r);
    expect((await api(fx.tokens.tenantA).post(`/api/leases/${randomUUID()}/gateway-bills`)).status).toBe(404);
    expect((await api(fx.tokens.tenantA).post("/api/leases/not-a-uuid/gateway-bills")).status).toBe(404);
    const bills = await sql<{ n: number }>("select count(*)::bigint as n from public.gateway_bills where lease_id = $1", [
      lease.id,
    ]);
    expect(bills[0].n).toBe(0);
  });
});

describe("R32 R34 the brief's simulator (gateway-sim.mjs, README) produces an accepted callback", () => {
  it("node gateway-sim.mjs <bill_id> <amount_sen> true -> 200 and the bill is paid with one payment", async () => {
    const { lease, bill } = await freshBill();
    const before = Date.now();
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [path.join(process.cwd(), "gateway-sim.mjs"), bill.billId, String(bill.amountSen), "true"],
      { env: { ...process.env, WEBHOOK_URL: `${env.baseUrl}${HOOK}`, GATEWAY_X_SIGNATURE_KEY: env.gatewayKey } },
    );
    expect(stdout.trim()).toMatch(/^200\b/);
    expect((await billRow(bill.billId)).status).toBe("paid");
    const pays = await billPayments(bill.billId);
    expect(pays).toHaveLength(1);
    // the simulator stamps paid_at = now in MYT, to the second
    expect(pays[0].received_at.getTime()).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
    expect(pays[0].received_at.getTime()).toBeLessThanOrEqual(Date.now());
    expect(await leaseAllocatedSen(lease.id)).toBe(PAST_TOTAL);

    // a paid=false run of the simulator afterwards is acknowledged and changes nothing
    const late = await promisify(execFile)(
      process.execPath,
      [path.join(process.cwd(), "gateway-sim.mjs"), bill.billId, String(bill.amountSen), "false"],
      { env: { ...process.env, WEBHOOK_URL: `${env.baseUrl}${HOOK}`, GATEWAY_X_SIGNATURE_KEY: env.gatewayKey } },
    );
    expect(late.stdout.trim()).toMatch(/^200\b/);
    expect((await billRow(bill.billId)).status).toBe("paid");
  });
});
