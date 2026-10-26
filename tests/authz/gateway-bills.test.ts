import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, sql } from "../helpers/db";
import { createFixtureOrg, createFixtureUser, type FixtureOrg } from "../helpers/fixtures";
import { seeded, type SeededKey, type Session } from "../helpers/seeded";
import { GARBAGE_AUTH, MALFORMED, NONEXISTENT, call, count, expectError, expectNoLeaks, loadSeededIds, type SeededIds } from "./support";

// R30 R31 R36 R38: the two gateway-bill routes. Bills are only ever created on fixture leases, except
// for cross-org / wrong-role probes on the seeded leases, which are also blocked inside
// private.create_gateway_bill (actor must be the lease's tenant), so a route hole could not write.

const DUE = { startDate: "2026-01-01", endDate: "2026-12-31", monthlyRentSen: 100000, depositSen: 50000 };
const FUTURE = { startDate: "2099-01-01", endDate: "2099-06-30", monthlyRentSen: 100000, depositSen: 0 };
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let S: Record<"northwindManager" | "northwindStaff" | "aisyah" | "ben" | "betaManager" | "chen", Session>;
let ids: SeededIds;
let F: FixtureOrg; // lease with invoices due now
let G: FixtureOrg; // another org
let N: FixtureOrg; // lease with nothing due yet
let noRole: Session;
let billId: string;

const enc = encodeURIComponent;
const billsOn = (leaseId: string) => count("select 1 from public.gateway_bills where lease_id = $1", [leaseId]);
const create = (token: string | undefined, leaseId: string) => call(token, "POST", `/api/leases/${leaseId}/gateway-bills`);

beforeAll(async () => {
  const keys = ["northwindManager", "northwindStaff", "aisyah", "ben", "betaManager", "chen"] as const;
  const sessions = await Promise.all(keys.map((k: SeededKey) => seeded(k)));
  S = Object.fromEntries(keys.map((k, i) => [k, sessions[i]])) as typeof S;
  ids = await loadSeededIds();
  [F, G, N, noRole] = await Promise.all([
    createFixtureOrg({ units: 1, lease: DUE }),
    createFixtureOrg({ units: 1, lease: DUE }),
    createFixtureOrg({ units: 1, lease: FUTURE }),
    createFixtureUser("norole-bill"),
  ]);
});

afterAll(closePool);

describe("R30 R36 R38 POST /api/leases/:leaseId/gateway-bills", () => {
  it("no credentials -> 401 JSON, never a redirect", async () => {
    expectError(await create(undefined, F.lease!.id), 401);
  });
  for (const [label, auth] of GARBAGE_AUTH) {
    it(`${label} -> 401`, async () => {
      expectError(await call(auth, "POST", `/api/leases/${F.lease!.id}/gateway-bills`), 401);
    });
  }

  it("staff and manager of the lease's org -> 403, no bill created (fixture and seeded)", async () => {
    const before = await billsOn(F.lease!.id);
    expectError(await create(F.tokens.staff, F.lease!.id), 403);
    expectError(await create(F.tokens.manager, F.lease!.id), 403);
    expect(await billsOn(F.lease!.id)).toBe(before);
    const seededBefore = await billsOn(ids.aisyahLease);
    expectError(await create(S.northwindStaff.accessToken, ids.aisyahLease), 403);
    expectError(await create(S.northwindManager.accessToken, ids.aisyahLease), 403);
    expect(await billsOn(ids.aisyahLease)).toBe(seededBefore);
  });

  it("other tenant in the same org, other org's manager / tenant, no-role user -> 404, no bill", async () => {
    const before = await billsOn(F.lease!.id);
    for (const t of [F.tokens.tenantB, G.tokens.manager, G.tokens.staff, G.tokens.tenantA, noRole.accessToken]) {
      expectError(await create(t, F.lease!.id), 404);
    }
    expect(await billsOn(F.lease!.id)).toBe(before);
  });

  it("seeded: Ben, Beta manager and Chen on Aisyah's lease -> 404, no bill", async () => {
    const before = await billsOn(ids.aisyahLease);
    for (const s of [S.ben, S.betaManager, S.chen]) expectError(await create(s.accessToken, ids.aisyahLease), 404);
    expect(await billsOn(ids.aisyahLease)).toBe(before);
  });

  for (const bad of MALFORMED) {
    it(`malformed lease id '${bad}' -> 404`, async () => {
      expectError(await create(F.tokens.tenantA, enc(bad)), 404);
    });
  }

  it("well-formed nonexistent lease id -> 404", async () => {
    expectError(await create(F.tokens.tenantA, NONEXISTENT), 404);
  });

  it("the lease's tenant with nothing due yet -> 422 (business rule only after authorization)", async () => {
    expectError(await create(N.tokens.tenantA, N.lease!.id), 422);
    expect(await billsOn(N.lease!.id)).toBe(0);
  });

  it("positive control: the lease's tenant -> 201 { billId (uuid v4), amountSen } on their own lease", async () => {
    const r = await create(F.tokens.tenantA, F.lease!.id);
    expect(r.status).toBe(201);
    const b = r.body as { billId: string; amountSen: number };
    expect(Object.keys(b).sort()).toEqual(["amountSen", "billId"]);
    expect(b.billId).toMatch(UUID_V4);
    expect(Number.isSafeInteger(b.amountSen) && b.amountSen > 0).toBe(true);
    billId = b.billId;
    const rows = await sql<{ org_id: string; lease_id: string; status: string }>(
      "select org_id, lease_id, status from public.gateway_bills where id = $1",
      [billId],
    );
    expect(rows).toEqual([{ org_id: F.orgId, lease_id: F.lease!.id, status: "pending" }]);
  });
});

describe("R31 R36 R38 GET /api/gateway-bills/:billId", () => {
  const path = (id: string) => `/api/gateway-bills/${id}`;

  it("no credentials -> 401 JSON", async () => {
    expectError(await call(undefined, "GET", path(billId)), 401);
  });
  for (const [label, auth] of GARBAGE_AUTH) {
    it(`${label} -> 401`, async () => {
      expectError(await call(auth, "GET", path(billId)), 401);
    });
  }

  it("the lease's tenant, staff and manager -> 200 with the bill", async () => {
    for (const t of [F.tokens.tenantA, F.tokens.staff, F.tokens.manager]) {
      const r = await call(t, "GET", path(billId));
      expect(r.status).toBe(200);
      expect((r.body as { billId: string }).billId).toBe(billId);
    }
  });

  it("other tenant in the same org, other org, seeded accounts, no-role user -> 404 with no bill data", async () => {
    const tokens = [
      F.tokens.tenantB,
      G.tokens.manager,
      G.tokens.staff,
      G.tokens.tenantA,
      noRole.accessToken,
      S.northwindManager.accessToken,
      S.betaManager.accessToken,
      S.chen.accessToken,
      S.aisyah.accessToken,
    ];
    for (const t of tokens) expectError(await call(t, "GET", path(billId)), 404, [F.lease!.id, "amountSen"]);
  });

  it("GET with ?paid=true (the return-page pattern) changes nothing: the bill stays pending", async () => {
    const r = await call(F.tokens.tenantA, "GET", `${path(billId)}?paid=true&bill_id=${billId}`);
    expect(r.status).toBe(200);
    expect((r.body as { status: string }).status).toBe("pending");
    const rows = await sql<{ status: string }>("select status from public.gateway_bills where id = $1", [billId]);
    expect(rows[0].status).toBe("pending");
    expect(await count("select 1 from public.payments where gateway_bill_id = $1", [billId])).toBe(0);
  });

  for (const bad of MALFORMED) {
    it(`malformed bill id '${bad}' -> 404`, async () => {
      expectError(await call(F.tokens.manager, "GET", path(enc(bad))), 404);
    });
  }

  it("well-formed nonexistent bill id -> 404", async () => {
    expectError(await call(F.tokens.manager, "GET", path(NONEXISTENT)), 404);
  });
});

describe("R41 gateway-bill responses leak nothing", () => {
  it("sweep", () => expectNoLeaks());
});
