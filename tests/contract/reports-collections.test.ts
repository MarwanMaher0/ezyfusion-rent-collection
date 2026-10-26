import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectionsBody, errorBody, recordPaymentBody } from "../helpers/contract";
import { closePool } from "../helpers/db";
import { createFixtureOrg, type FixtureOrg } from "../helpers/fixtures";
import { api } from "../helpers/http";
import { seeded } from "../helpers/seeded";

// GET /api/reports/collections?from=YYYY-MM&to=YYYY-MM (SPEC Contracts): staff, manager; 200
// [{ month, collectedSen }] one entry per month in order, empty months included; 400 invalid range.
// Approved payments only, bucketed by the Malaysia calendar month of received_at (R3, R29).

let fx: FixtureOrg;

const report = (token: string | undefined, query: string) => api(token).get(`/api/reports/collections${query}`);

async function pay(token: string, amountSen: number, receivedAt: string): Promise<string> {
  const r = await api(token).post(`/api/leases/${fx.lease!.id}/payments`, { amountSen, method: "cash", receivedAt });
  expect(r.status).toBe(201);
  return recordPaymentBody.parse(r.body).id;
}

beforeAll(async () => {
  fx = await createFixtureOrg({
    lease: { startDate: "2025-12-01", endDate: "2026-12-31", monthlyRentSen: 100000, depositSen: 0 },
  });
  // Month boundaries in MYT vs UTC:
  await pay(fx.tokens.manager, 1001, "2026-01-31T23:59:59+08:00"); // Jan MYT (15:59:59Z)
  await pay(fx.tokens.manager, 2002, "2026-01-31T16:00:00Z"); // = 2026-02-01 00:00 MYT -> Feb
  await pay(fx.tokens.manager, 4004, "2025-12-31T16:30:00Z"); // = 2026-01-01 00:30 MYT -> Jan
  await pay(fx.tokens.manager, 8008, "2025-12-31T15:59:59Z"); // = 2025-12-31 23:59:59 MYT -> Dec
  // Not collected: a pending, a rejected and a voided payment in March.
  await pay(fx.tokens.staff, 50000, "2026-03-10T10:00:00+08:00");
  const rejected = await pay(fx.tokens.staff, 60000, "2026-03-11T10:00:00+08:00");
  expect((await api(fx.tokens.manager).post(`/api/payments/${rejected}/reject`, { reason: "Wrong amount" })).status).toBe(200);
  const voided = await pay(fx.tokens.manager, 70000, "2026-03-12T10:00:00+08:00");
  expect((await api(fx.tokens.manager).post(`/api/payments/${voided}/void`, { reason: "Recorded twice" })).status).toBe(200);
  // Approved staff payment counts in its month once approved.
  const approved = await pay(fx.tokens.staff, 16016, "2026-04-30T23:00:00+08:00");
  expect((await api(fx.tokens.manager).post(`/api/payments/${approved}/approve`)).status).toBe(200);
});

afterAll(async () => {
  await closePool();
});

describe("R29 R45 GET /api/reports/collections on the seed (read-only)", () => {
  it.each(["northwindManager", "northwindStaff"] as const)("%s: Northwind 2026-01..2026-03 is exactly [300000, 0, 200000]", async (key) => {
    const s = await seeded(key);
    const r = await report(s.accessToken, "?from=2026-01&to=2026-03");
    expect(r.status).toBe(200);
    expect(collectionsBody.parse(r.body)).toEqual([
      { month: "2026-01", collectedSen: 300000 },
      { month: "2026-02", collectedSen: 0 },
      { month: "2026-03", collectedSen: 200000 },
    ]);
  });

  it("Beta's manager never sees Northwind's money: 2026-01..2026-02 is all zero", async () => {
    const s = await seeded("betaManager");
    const r = await report(s.accessToken, "?from=2026-01&to=2026-02");
    expect(r.status).toBe(200);
    expect(collectionsBody.parse(r.body)).toEqual([
      { month: "2026-01", collectedSen: 0 },
      { month: "2026-02", collectedSen: 0 },
    ]);
  });
});

describe("R29 R3 GET /api/reports/collections: MYT months, approved only, every month in order", () => {
  it("fixture org 2025-11..2026-05: MYT month boundaries, pending/rejected/voided excluded", async () => {
    const r = await report(fx.tokens.staff, "?from=2025-11&to=2026-05");
    expect(r.status).toBe(200);
    expect(collectionsBody.parse(r.body)).toEqual([
      { month: "2025-11", collectedSen: 0 },
      { month: "2025-12", collectedSen: 8008 },
      { month: "2026-01", collectedSen: 1001 + 4004 },
      { month: "2026-02", collectedSen: 2002 },
      { month: "2026-03", collectedSen: 0 },
      { month: "2026-04", collectedSen: 16016 },
      { month: "2026-05", collectedSen: 0 },
    ]);
  });

  it("from == to -> exactly one entry", async () => {
    const r = await report(fx.tokens.manager, "?from=2026-02&to=2026-02");
    expect(r.status).toBe(200);
    expect(collectionsBody.parse(r.body)).toEqual([{ month: "2026-02", collectedSen: 2002 }]);
  });

  it("24 months across two year boundaries: one entry per month, consecutive, in order", async () => {
    const r = await report(fx.tokens.manager, "?from=2025-06&to=2027-05");
    expect(r.status).toBe(200);
    const body = collectionsBody.parse(r.body);
    expect(body).toHaveLength(24);
    const expected: string[] = [];
    for (let i = 0; i < 24; i++) {
      const m = 5 + i; // 0-based month index from 2025-06
      expected.push(`${2025 + Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, "0")}`);
    }
    expect(body.map((e) => e.month)).toEqual(expected);
    expect(body.reduce((s, e) => s + e.collectedSen, 0)).toBe(8008 + 1001 + 4004 + 2002 + 16016);
  });
});

describe("R29 R45 GET /api/reports/collections: 400 invalid range, 401, 403", () => {
  it.each([
    ["from > to", "?from=2026-03&to=2026-01"],
    ["month 13", "?from=2026-13&to=2026-13"],
    ["month 00", "?from=2026-00&to=2026-01"],
    ["unpadded month", "?from=2026-1&to=2026-03"],
    ["full date", "?from=2026-01-01&to=2026-03-31"],
    ["garbage", "?from=abcd-ef&to=2026-03"],
    ["missing from", "?to=2026-03"],
    ["missing to", "?from=2026-01"],
    ["no params", ""],
    ["empty values", "?from=&to="],
  ])("%s -> 400 { error }", async (_l, q) => {
    const r = await report(fx.tokens.manager, q);
    expect(r.status).toBe(400);
    errorBody.parse(r.body);
  });

  it("no token -> 401; a tenant -> 403 (checked before the range)", async () => {
    const anon = await report(undefined, "?from=2026-01&to=2026-03");
    expect(anon.status).toBe(401);
    errorBody.parse(anon.body);
    for (const q of ["?from=2026-01&to=2026-03", "?from=bad"]) {
      const t = await report(fx.tokens.tenantA, q);
      expect(t.status).toBe(403);
      errorBody.parse(t.body);
    }
    const aisyah = await seeded("aisyah");
    const a = await report(aisyah.accessToken, "?from=2026-01&to=2026-03");
    expect(a.status).toBe(403);
    errorBody.parse(a.body);
  });
});
