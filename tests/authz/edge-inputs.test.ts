import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool } from "../helpers/db";
import { createFixtureOrg, type FixtureOrg } from "../helpers/fixtures";
import { call, count, expectError } from "./support";

// D75 input edge cases through the real route handlers, on fresh fixture orgs (payments are
// append-only, so the fixture org is the unit of cleanup, as in routes.test.ts).

const LEASE = { startDate: "2026-01-01", endDate: "2026-12-31", monthlyRentSen: 100000, depositSen: 50000 };
const NOT_RFC = "11111111-1111-1111-1111-111111111111"; // 8-4-4-4-12 hex, but variant nibble '1' is not RFC 4122, so z.uuid() would 400 it
let F: FixtureOrg;

const paymentsOnLease = (leaseId: string) => count("select 1 from public.payments where lease_id = $1", [leaseId]);
const cash = () => ({ amountSen: 100, method: "cash", receivedAt: new Date().toISOString(), slipPath: null });
const pay = (body: unknown, headers: Record<string, string> = {}) =>
  call(F.tokens.staff, "POST", `/api/leases/${F.lease!.id}/payments`, body, headers);

beforeAll(async () => {
  F = await createFixtureOrg({ units: 3, lease: LEASE });
});

afterAll(async () => {
  await closePool();
});

describe("R39 R45 D75 edge inputs", () => {
  it("POST /api/leases with a well-formed but non-RFC nonexistent unitId -> 404 (not 400)", async () => {
    const r = await call(F.tokens.manager, "POST", "/api/leases", { unitId: NOT_RFC, tenantId: F.tenantBId, ...LEASE });
    expectError(r, 404);
  });

  it("POST /api/leases with a well-formed but non-RFC nonexistent tenantId -> 404 (not 400)", async () => {
    const r = await call(F.tokens.manager, "POST", "/api/leases", { unitId: F.unitIds[1], tenantId: NOT_RFC, ...LEASE });
    expectError(r, 404);
    expect(await count("select 1 from public.leases where unit_id = $1", [F.unitIds[1]])).toBe(0);
  });

  it("staff records cash with slipPath: null -> 201 (null treated as absent)", async () => {
    const before = await paymentsOnLease(F.lease!.id);
    const r = await pay(cash());
    expect(r.status).toBe(201);
    expect(await paymentsOnLease(F.lease!.id)).toBe(before + 1);
  });

  it("bank_transfer with slipPath: null -> 400 (a slip is still required) and no payment", async () => {
    const before = await paymentsOnLease(F.lease!.id);
    expectError(await pay({ ...cash(), method: "bank_transfer" }), 400);
    expect(await paymentsOnLease(F.lease!.id)).toBe(before);
  });

  it("a blank Idempotency-Key header is treated as no key: 201 twice, two payments", async () => {
    const before = await paymentsOnLease(F.lease!.id);
    const body = cash();
    for (const key of ["", "   "]) {
      const r1 = await pay(body, { "Idempotency-Key": key });
      expect({ key, status: r1.status }).toEqual({ key, status: 201 });
    }
    expect(await paymentsOnLease(F.lease!.id)).toBe(before + 2);
  });

  it("Idempotency-Key: abc (not a uuid) -> 400 and no payment", async () => {
    const before = await paymentsOnLease(F.lease!.id);
    expectError(await pay(cash(), { "Idempotency-Key": "abc" }), 400);
    expect(await paymentsOnLease(F.lease!.id)).toBe(before);
  });
});
