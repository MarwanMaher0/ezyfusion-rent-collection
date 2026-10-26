import type pg from "pg";
import { expect } from "vitest";
import { sql } from "../helpers/db";
import { insertLease, insertUnit, type FixtureLease, type FixtureOrg, type LeaseInput } from "../helpers/fixtures";
import type { HttpResult } from "../helpers/http";

// Shared by tests/concurrency/** and tests/webhook/** (both owned by test-concurrency).
// Every race scenario gets its own lease on its own fresh unit, so rounds never share a cap, and the
// EXCLUDE overlap constraint never couples two scenarios.

export const ROUNDS = 5;

/** A lease for tenant A of `fx` on a brand-new unit, with exactly generateSchedule(lease) as invoices. */
export async function newLease(fx: FixtureOrg, lease: LeaseInput, tenantId = fx.tenantAId): Promise<FixtureLease> {
  const unitId = await insertUnit(fx.orgId);
  return insertLease(fx.orgId, unitId, tenantId, lease, fx.users.manager.userId);
}

export const sortedStatuses = (rs: HttpResult[]): number[] => rs.map((r) => r.status).sort((a, b) => a - b);

/** No response is ever a 5xx, whatever the interleaving. Prints the bodies when one is. */
export function expectNo5xx(rs: HttpResult[]): void {
  const bad = rs.filter((r) => r.status >= 500);
  expect(bad.map((r) => ({ status: r.status, body: r.body }))).toEqual([]);
}

/** Error contract (brief section 7): { "error": "<message>" }. */
export function expectErrorBody(r: HttpResult): void {
  expect(r.body).toEqual({ error: expect.any(String) });
}

export async function backendPid(c: pg.Client): Promise<number> {
  const { rows } = await c.query<{ pid: number }>("select pg_backend_pid() as pid");
  return rows[0].pid;
}

/**
 * Forced-overlap probe: waits until some backend is blocked by `holderPid` (pg_blocking_pids) and
 * returns its pid + wait_event_type. This polls a condition in pg_stat_activity; it is not a timing
 * sleep, so it proves the second request really queues on the first one's row lock.
 */
export async function waitForBlockedBy(
  holderPid: number,
  timeoutMs = 20_000,
): Promise<{ pid: number; wait_event_type: string | null; query: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await sql<{ pid: number; wait_event_type: string | null; query: string }>(
      `select pid, wait_event_type, query from pg_stat_activity
        where $1::int = any(pg_blocking_pids(pid))`,
      [holderPid],
    );
    if (rows.length > 0) return rows[0];
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`no backend became blocked by pid ${holderPid} within ${timeoutMs} ms`);
}

/** Waits until the given backend pid is waiting on a heavyweight lock. */
export async function waitForPidOnLock(pid: number, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await sql<{ wait_event_type: string | null }>(
      "select wait_event_type from pg_stat_activity where pid = $1",
      [pid],
    );
    if (rows[0]?.wait_event_type === "Lock") return "Lock";
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`pid ${pid} never waited on a lock within ${timeoutMs} ms`);
}

export interface InvoicePaid {
  id: string;
  amount_sen: number;
  paid_sen: number;
}

/** Per-invoice Σ allocations for a lease, straight from the DB (bypasses the API). */
export function invoicePaid(leaseId: string): Promise<InvoicePaid[]> {
  return sql<InvoicePaid>(
    `select i.id, i.amount_sen, coalesce(sum(a.amount_sen), 0)::bigint as paid_sen
       from public.invoices i
       left join public.payment_allocations a on a.invoice_id = i.id
      where i.lease_id = $1
      group by i.id, i.amount_sen`,
    [leaseId],
  );
}

export async function leaseAllocatedSen(leaseId: string): Promise<number> {
  const rows = await sql<{ s: number }>(
    "select coalesce(sum(amount_sen), 0)::bigint as s from public.payment_allocations where lease_id = $1",
    [leaseId],
  );
  return rows[0].s;
}

export async function paymentAllocations(paymentId: string): Promise<{ count: number; sum: number }> {
  const rows = await sql<{ count: number; sum: number }>(
    `select count(*)::bigint as count, coalesce(sum(amount_sen), 0)::bigint as sum
       from public.payment_allocations where payment_id = $1`,
    [paymentId],
  );
  return rows[0];
}

/** "Today" in Malaysia for an instant: UTC + 8 h, date part (MYT has no DST). Written independently of the app. */
export function mytToday(now: Date = new Date()): string {
  return new Date(now.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** Allocation order of the brief (section 4): due date, deposit before rent, period index. */
export function allocationOrder<T extends { dueDate: string; kind: string; periodIndex: number | null }>(xs: T[]): T[] {
  return [...xs].sort((a, b) => {
    if (a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
    if (a.kind !== b.kind) return a.kind === "deposit" ? -1 : 1;
    return (a.periodIndex ?? -1) - (b.periodIndex ?? -1);
  });
}

/** Independent model of the brief's allocation: fill invoices in order, each up to its unpaid amount. */
export function expectedFill(
  invoices: { id: string; dueDate: string; kind: string; periodIndex: number | null; amountSen: number }[],
  amounts: number[],
): Map<string, number> {
  const paid = new Map<string, number>(invoices.map((i) => [i.id, 0]));
  for (const amount of amounts) {
    let left = amount;
    for (const inv of allocationOrder(invoices)) {
      if (left <= 0) break;
      const take = Math.min(inv.amountSen - (paid.get(inv.id) ?? 0), left);
      if (take <= 0) continue;
      paid.set(inv.id, (paid.get(inv.id) ?? 0) + take);
      left -= take;
    }
  }
  return paid;
}
