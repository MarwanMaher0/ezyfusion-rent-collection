import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, newConnection } from "../helpers/db";
import { createFixtureOrg, type FixtureLease, type FixtureOrg } from "../helpers/fixtures";
import { newLease } from "../concurrency/support";

// R30 D5: the gateway bill's "amount due now" turns over at 00:00 Malaysia time (= 16:00Z the day
// before), not at UTC midnight or server-local midnight. Calls private.create_gateway_bill directly
// with an explicit p_as_of; every call runs inside BEGIN ... ROLLBACK, so no bill or audit row persists.

// Invoices due on 2026-01-01 (deposit + January), 2026-02-01 and 2026-03-01.
const LEASE_FIRST = { startDate: "2026-01-01", endDate: "2026-03-31", monthlyRentSen: 100_000, depositSen: 50_000 };
// Anchor day 31: due dates clamp to month end (Feb 28), so the boundary is tested on non-1st days too.
const LEASE_31ST = { startDate: "2026-01-31", endDate: "2026-04-29", monthlyRentSen: 123_457, depositSen: 70_001 };

let fx: FixtureOrg;
let c: pg.Client;

type BillResult = { amountSen: number } | { code: string | undefined; message: string };

/** One create_gateway_bill call as the lease's tenant at `asOf`, rolled back afterwards. */
async function billAt(lease: FixtureLease, asOf: string): Promise<BillResult> {
  await c.query("begin");
  try {
    const r = await c.query<{ id: string; amount_sen: number | string }>(
      "select * from private.create_gateway_bill($1::uuid, $2::uuid, $3::timestamptz)",
      [fx.users.tenantA.userId, lease.id, asOf],
    );
    return { amountSen: Number(r.rows[0].amount_sen) };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { code: err.code, message: err.message ?? "" };
  } finally {
    await c.query("rollback");
  }
}

/** "YYYY-MM-DD" minus one day, on calendar parts (UTC midnight is only a carrier, no local time). */
function dayBefore(d: string): string {
  const t = Date.parse(`${d}T00:00:00Z`) - 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** Independent model: Σ amount of invoices due on or before `myDate` (nothing is allocated on these leases). */
function dueOnOrBefore(lease: FixtureLease, myDate: string): number {
  return lease.invoices.filter((i) => i.dueDate <= myDate).reduce((s, i) => s + i.amountSen, 0);
}

beforeAll(async () => {
  fx = await createFixtureOrg({ units: 1 });
  c = await newConnection();
});

afterAll(async () => {
  await c?.end();
  await closePool();
});

describe("R30 D5 amount due now turns over at 00:00 MYT (16:00Z the day before)", () => {
  for (const [name, input] of [
    ["lease starting on the 1st", LEASE_FIRST],
    ["lease anchored on the 31st (month-end clamp)", LEASE_31ST],
  ] as const) {
    it(`${name}: at (D-1)T15:59:59Z invoices due on D are excluded; at (D-1)T16:00:00Z they are included`, async () => {
      const lease = await newLease(fx, input);
      const dueDates = [...new Set(lease.invoices.map((i) => i.dueDate))].sort();
      expect(dueDates.length).toBeGreaterThanOrEqual(3);

      for (const [k, d] of dueDates.entries()) {
        const prev = dayBefore(d);
        const before = await billAt(lease, `${prev}T15:59:59Z`);
        const after = await billAt(lease, `${prev}T16:00:00Z`);
        const dueOnD = lease.invoices.filter((i) => i.dueDate === d).reduce((s, i) => s + i.amountSen, 0);

        // at 16:00:00Z it is already D in Malaysia: everything due on or before D
        expect(after, `after boundary of ${d}`).toEqual({ amountSen: dueOnOrBefore(lease, d) });
        if (k === 0) {
          // the first due date: one second earlier nothing is due yet
          expect(before, `before boundary of ${d}`).toEqual({ code: "P0422", message: "Nothing is due" });
        } else {
          expect(before, `before boundary of ${d}`).toEqual({ amountSen: dueOnOrBefore(lease, prev) });
          // larger by exactly the invoices due on D
          expect((after as { amountSen: number }).amountSen - (before as { amountSen: number }).amountSen).toBe(dueOnD);
        }
      }

      // the rollbacks left no bill behind
      const { rows } = await c.query<{ n: number | string }>(
        "select count(*) as n from public.gateway_bills where lease_id = $1",
        [lease.id],
      );
      expect(Number(rows[0].n)).toBe(0);
    });
  }
});
