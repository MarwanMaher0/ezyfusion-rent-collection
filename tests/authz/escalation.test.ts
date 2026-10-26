import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool } from "../helpers/db";
import { env } from "../helpers/env";
import { createFixtureOrg, createFixtureUser, type FixtureOrg } from "../helpers/fixtures";
import { call, count, expectError, expectNoLeaks, paymentStatus } from "./support";

// R37: roles come from memberships / tenants.user_id, never from user_metadata. Each attacker edits
// their OWN user_metadata through the normal Auth API (supabase.auth.updateUser, which any signed-in
// user may call), takes a fresh access token that carries the forged claims, and retries manager-only
// actions over HTTP. Only fixture users are modified.

const LEASE = { startDate: "2026-01-01", endDate: "2026-12-31", monthlyRentSen: 100000, depositSen: 50000 };
const cash = { amountSen: 1000, method: "cash", receivedAt: "2026-02-01T10:00:00+08:00" };

let E: FixtureOrg;
let other: FixtureOrg;
let pendingId: string;
let approvedId: string;
let otherPendingId: string;

interface Claims {
  user_metadata?: Record<string, unknown>;
  app_metadata?: Record<string, unknown>;
}
const claimsOf = (jwt: string): Claims => JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8")) as Claims;

/** Signs in for real, writes forged role claims into the user's own user_metadata, returns the refreshed token. */
async function forgeManagerToken(email: string, orgId: string): Promise<string> {
  const c = createClient(env.supabaseUrl, env.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { error: signInError } = await c.auth.signInWithPassword({ email, password: env.seedPassword });
  if (signInError) throw new Error(`signIn failed: ${signInError.message}`);
  const { error } = await c.auth.updateUser({ data: { role: "manager", org_id: orgId, orgId, is_manager: true } });
  expect(error).toBeNull();
  const { data, error: refreshError } = await c.auth.refreshSession();
  expect(refreshError).toBeNull();
  const token = data.session!.access_token;
  expect(claimsOf(token).user_metadata?.role).toBe("manager");
  expect(claimsOf(token).app_metadata?.role).toBeUndefined();
  return token;
}

beforeAll(async () => {
  [E, other] = await Promise.all([
    createFixtureOrg({ units: 3, lease: LEASE }),
    createFixtureOrg({ units: 1, lease: LEASE }),
  ]);
  const p = await call(E.tokens.staff, "POST", `/api/leases/${E.lease!.id}/payments`, cash);
  expect(p.status).toBe(201);
  pendingId = (p.body as { id: string }).id;
  const a = await call(E.tokens.manager, "POST", `/api/leases/${E.lease!.id}/payments`, cash);
  expect(a.status).toBe(201);
  approvedId = (a.body as { id: string }).id;
  const o = await call(other.tokens.staff, "POST", `/api/leases/${other.lease!.id}/payments`, cash);
  expect(o.status).toBe(201);
  otherPendingId = (o.body as { id: string }).id;
});

afterAll(closePool);

describe("R37 R38 escalation: tenant sets user_metadata.role = 'manager'", () => {
  let token: string;
  beforeAll(async () => {
    token = await forgeManagerToken(E.users.tenantA.email, E.orgId);
  });

  it("POST /api/leases with a valid body -> 403 and no lease created", async () => {
    const body = { unitId: E.unitIds[1], tenantId: E.tenantAId, ...LEASE };
    expectError(await call(token, "POST", "/api/leases", body), 403);
    expect(await count("select 1 from public.leases where unit_id = $1", [E.unitIds[1]])).toBe(0);
  });

  it("approve / reject a pending payment on own lease -> 403, stays pending", async () => {
    expectError(await call(token, "POST", `/api/payments/${pendingId}/approve`), 403);
    expectError(await call(token, "POST", `/api/payments/${pendingId}/reject`, { reason: "escalated reject" }), 403);
    expect(await paymentStatus(pendingId)).toBe("pending_verification");
  });

  it("void an approved payment on own lease -> 403, stays approved", async () => {
    expectError(await call(token, "POST", `/api/payments/${approvedId}/void`, { reason: "escalated void" }), 403);
    expect(await paymentStatus(approvedId)).toBe("approved");
  });

  it("record a payment on own lease -> 403; collections -> 403", async () => {
    const before = await count("select 1 from public.payments where lease_id = $1", [E.lease!.id]);
    expectError(await call(token, "POST", `/api/leases/${E.lease!.id}/payments`, cash), 403);
    expect(await count("select 1 from public.payments where lease_id = $1", [E.lease!.id])).toBe(before);
    expectError(await call(token, "GET", "/api/reports/collections?from=2026-01&to=2026-03"), 403);
  });

  it("another org's lease / payment stays 404", async () => {
    expectError(await call(token, "GET", `/api/leases/${other.lease!.id}`), 404);
    expectError(await call(token, "POST", `/api/payments/${otherPendingId}/approve`), 404);
    expect(await paymentStatus(otherPendingId)).toBe("pending_verification");
  });
});

describe("R37 R38 escalation: staff sets user_metadata.role = 'manager'", () => {
  let token: string;
  beforeAll(async () => {
    token = await forgeManagerToken(E.users.staff.email, E.orgId);
  });

  it("approve / reject / void -> 403; payments unchanged", async () => {
    expectError(await call(token, "POST", `/api/payments/${pendingId}/approve`), 403);
    expectError(await call(token, "POST", `/api/payments/${pendingId}/reject`, { reason: "escalated reject" }), 403);
    expectError(await call(token, "POST", `/api/payments/${approvedId}/void`, { reason: "escalated void" }), 403);
    expect(await paymentStatus(pendingId)).toBe("pending_verification");
    expect(await paymentStatus(approvedId)).toBe("approved");
  });

  it("POST /api/leases -> 403, no lease created", async () => {
    expectError(await call(token, "POST", "/api/leases", { unitId: E.unitIds[2], tenantId: E.tenantBId, ...LEASE }), 403);
    expect(await count("select 1 from public.leases where unit_id = $1", [E.unitIds[2]])).toBe(0);
  });

  it("staff of E still cannot reach another org's lease (404) even with org_id forged to it", async () => {
    const t2 = await forgeManagerToken(E.users.staff.email, other.orgId);
    expectError(await call(t2, "GET", `/api/leases/${other.lease!.id}`), 404);
    expectError(await call(t2, "POST", `/api/leases/${other.lease!.id}/payments`, cash), 404);
  });
});

describe("R37 R38 escalation: a user with no role forges manager + org_id", () => {
  it("POST /api/leases -> 403; GET the org's lease -> 404; approve -> 404", async () => {
    const u = await createFixtureUser("forger");
    const token = await forgeManagerToken(u.email, E.orgId);
    expectError(await call(token, "POST", "/api/leases", { unitId: E.unitIds[2], tenantId: E.tenantBId, ...LEASE }), 403);
    expectError(await call(token, "GET", `/api/leases/${E.lease!.id}`), 404);
    expectError(await call(token, "POST", `/api/payments/${pendingId}/approve`), 404);
    expect(await paymentStatus(pendingId)).toBe("pending_verification");
  });
});

describe("R41 escalation responses leak nothing", () => {
  it("sweep", () => expectNoLeaks());
});
