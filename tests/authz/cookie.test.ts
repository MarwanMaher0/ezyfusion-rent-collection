import { createClient, type Session as AuthSession } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool } from "../helpers/db";
import { env } from "../helpers/env";
import { createFixtureOrg, type FixtureOrg } from "../helpers/fixtures";
import { SEEDED } from "../helpers/seeded";
import { call, expectError, expectNoLeaks, forgedJwt, type Auth } from "./support";

// R40: the session cookie works exactly like `Authorization: Bearer`. The cookie is built the way
// @supabase/ssr 0.12 writes it (REFERENCE.md): name sb-<first host label>-auth-token, value
// "base64-" + base64url(JSON.stringify(session)), split into .0/.1/... chunks above 3180 chars.

const LEASE = { startDate: "2026-01-01", endDate: "2026-12-31", monthlyRentSen: 100000, depositSen: 50000 };
const cash = { amountSen: 1000, method: "cash", receivedAt: "2026-02-01T10:00:00+08:00" };
const CHUNK = 3180;

let F: FixtureOrg;
let G: FixtureOrg;
const sessions = new Map<string, AuthSession>();
const signedOut: AuthSession[] = [];

function cookieName(): string {
  return `sb-${new URL(env.supabaseUrl).hostname.split(".")[0]}-auth-token`;
}

function sessionCookie(session: object): Auth {
  const value = `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;
  const name = cookieName();
  if (value.length <= CHUNK) return { cookie: `${name}=${value}` };
  const parts: string[] = [];
  for (let i = 0; i * CHUNK < value.length; i++) parts.push(`${name}.${i}=${value.slice(i * CHUNK, (i + 1) * CHUNK)}`);
  return { cookie: parts.join("; ") };
}

async function freshSession(email: string): Promise<AuthSession> {
  const c = createClient(env.supabaseUrl, env.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await c.auth.signInWithPassword({ email, password: env.seedPassword });
  if (error || !data.session) throw new Error(`signIn(${email}) failed: ${error?.message}`);
  return data.session;
}

const cookieOf = (email: string) => sessionCookie(sessions.get(email)!);

beforeAll(async () => {
  [F, G] = await Promise.all([createFixtureOrg({ units: 2, lease: LEASE }), createFixtureOrg({ units: 1, lease: LEASE })]);
  const emails = [F.users.manager.email, F.users.staff.email, F.users.tenantA.email, F.users.tenantB.email, G.users.manager.email, SEEDED.aisyah];
  for (const e of emails) sessions.set(e, await freshSession(e));
  // A session that is signed out (revoked server-side) right after sign-in.
  const s = await freshSession(F.users.tenantB.email);
  const c = createClient(env.supabaseUrl, env.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  await c.auth.setSession({ access_token: s.access_token, refresh_token: s.refresh_token });
  const { error } = await c.auth.signOut({ scope: "local" });
  if (error) throw new Error(`signOut failed: ${error.message}`);
  signedOut.push(s);
});

afterAll(closePool);

describe("R40 R38 session cookie authenticates like Bearer on every kind of route", () => {
  it("manager cookie: GET lease 200, POST payment 201 approved, collections 200", async () => {
    const m = cookieOf(F.users.manager.email);
    expect((await call(m, "GET", `/api/leases/${F.lease!.id}`)).status).toBe(200);
    const p = await call(m, "POST", `/api/leases/${F.lease!.id}/payments`, cash);
    expect(p.status).toBe(201);
    expect((p.body as { status: string }).status).toBe("approved");
    expect((await call(m, "GET", "/api/reports/collections?from=2026-01&to=2026-02")).status).toBe(200);
    expect((await call(m, "GET", "/api/leases")).status).toBe(200);
  });

  it("staff cookie: record -> pending, approve -> 403, POST /api/leases -> 403", async () => {
    const s = cookieOf(F.users.staff.email);
    const p = await call(s, "POST", `/api/leases/${F.lease!.id}/payments`, cash);
    expect(p.status).toBe(201);
    const id = (p.body as { id: string }).id;
    expectError(await call(s, "POST", `/api/payments/${id}/approve`), 403);
    expectError(await call(s, "POST", "/api/leases", { unitId: F.unitIds[1], tenantId: F.tenantBId, ...LEASE }), 403);
  });

  it("tenant cookie: own lease 200, other tenant's lease 404, record payment 403, collections 403", async () => {
    const a = cookieOf(F.users.tenantA.email);
    expect((await call(a, "GET", `/api/leases/${F.lease!.id}`)).status).toBe(200);
    expectError(await call(cookieOf(F.users.tenantB.email), "GET", `/api/leases/${F.lease!.id}`), 404);
    expectError(await call(a, "POST", `/api/leases/${F.lease!.id}/payments`, cash), 403);
    expectError(await call(a, "GET", "/api/reports/collections?from=2026-01&to=2026-02"), 403);
  });

  it("seeded Aisyah cookie: own lease 200, a fixture org's lease 404", async () => {
    const a = cookieOf(SEEDED.aisyah);
    const own = await call(a, "GET", "/api/leases");
    expect(own.status).toBe(200);
    const [lease] = own.body as { id: string }[];
    expect((await call(a, "GET", `/api/leases/${lease.id}`)).status).toBe(200);
    expectError(await call(a, "GET", `/api/leases/${F.lease!.id}`), 404);
  });

  it("other org's manager cookie -> 404 on F's lease and payments", async () => {
    const g = cookieOf(G.users.manager.email);
    expectError(await call(g, "GET", `/api/leases/${F.lease!.id}`), 404);
    expectError(await call(g, "POST", `/api/leases/${F.lease!.id}/payments`, cash), 404);
  });

  it("cookie carrying a forged access token -> 401", async () => {
    const real = sessions.get(F.users.manager.email)!;
    const forged = sessionCookie({ ...real, access_token: forgedJwt(real.user.id) });
    expectError(await call(forged, "GET", `/api/leases/${F.lease!.id}`), 401);
    expectError(await call(forged, "POST", `/api/leases/${F.lease!.id}/payments`, cash), 401);
  });

  it("cookie / Bearer of a signed-out session -> 401", async () => {
    const s = signedOut[0];
    expectError(await call(sessionCookie(s), "GET", "/api/leases"), 401);
    expectError(await call(s.access_token, "GET", "/api/leases"), 401);
  });

  it("an invalid Bearer header wins over a valid cookie -> 401 (no fallback to the cookie)", async () => {
    const m = cookieOf(F.users.manager.email);
    expectError(await call({ ...m, raw: "Bearer garbage" }, "GET", `/api/leases/${F.lease!.id}`), 401);
  });
});

describe("R41 cookie responses leak nothing", () => {
  it("sweep", () => expectNoLeaks());
});
