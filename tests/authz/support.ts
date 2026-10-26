import { createHmac, randomUUID } from "node:crypto";
import { expect } from "vitest";
import { sql } from "../helpers/db";
import { env } from "../helpers/env";
import { api, type HttpResult } from "../helpers/http";

// Shared by the tests/authz files (not a test file itself). Every HTTP result goes through `call`, which
// records it so each file can finish with one R41 sweep over everything the routes returned.

export type Auth = { bearer?: string; cookie?: string; raw?: string };
export interface Seen {
  label: string;
  status: number;
  text: string;
}

export const seen: Seen[] = [];

export const NONEXISTENT = "8f0c4f0e-5b0a-4d55-9a8e-000000000000";
export const MALFORMED = ["abc", "1", "not-a-uuid'or'1'='1"];

// A JWT with a valid shape and claims but signed with a key the Auth server does not know.
export function forgedJwt(sub: string = randomUUID()): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub, role: "authenticated", aud: "authenticated", exp: now + 3600, iat: now });
  const sig = createHmac("sha256", "not-the-real-secret").update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

export const GARBAGE_AUTH: Array<[string, Auth]> = [
  ["garbage Bearer", { raw: "Bearer garbage.token.value" }],
  ["forged JWT", { bearer: forgedJwt() }],
  ["empty Bearer", { raw: "Bearer " }],
  ["Basic scheme", { raw: "Basic YWRtaW46YWRtaW4=" }],
  ["garbage session cookie", { cookie: "sb-127-auth-token=base64-Z2FyYmFnZQ" }],
];

/** One request with any credential shape; the result is recorded for the R41 leak sweep. */
export async function call(
  auth: Auth | string | undefined,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<HttpResult> {
  const a: Auth = typeof auth === "string" ? { bearer: auth } : (auth ?? {});
  const headers: Record<string, string> = { ...extraHeaders };
  if (a.raw !== undefined) headers.Authorization = a.raw;
  if (a.cookie) headers.Cookie = a.cookie;
  let res: HttpResult;
  if (method === "GET") {
    res = await api(a.bearer).get(path, { headers });
  } else {
    res = await api(a.bearer).post(path, body === undefined ? {} : body, { headers });
  }
  const text = typeof res.body === "string" ? res.body : JSON.stringify(res.body);
  seen.push({ label: `${method} ${path}`, status: res.status, text: `${text}\n${headersText(res.headers)}` });
  return res;
}

function headersText(h: Headers): string {
  const out: string[] = [];
  h.forEach((v, k) => out.push(`${k}: ${v}`));
  return out.join("\n");
}

// Things that must never appear in any response (R41 + Error contract): the secret key, a stack frame,
// Prisma / driver internals, SQL text, Postgres error vocabulary.
const LEAK_PATTERNS: RegExp[] = [
  /\n\s*at\s+\S+/, // stack frame line
  /\bat\s+[\w.<>]+\s+\([^)]*:\d+:\d+\)/, // "at fn (file:1:2)"
  /prisma/i,
  /\b(select|insert|update|delete)\s+[\w*"., ]*\b(from|into|set)\b/i,
  /\b(public|private|storage|auth)\.[a-z_]+\s*\(/i,
  /sqlstate|duplicate key|violates|relation "|syntax error at/i,
  /node_modules|\.tsx?:\d+/,
];

export function leakProblems(text: string): string[] {
  const out: string[] = [];
  if (text.includes(env.secretKey)) out.push("contains SUPABASE_SECRET_KEY");
  for (const re of LEAK_PATTERNS) if (re.test(text)) out.push(`matches ${re}`);
  return out;
}

/** Error contract: exact status, JSON content-type, body exactly { error: string }, nothing leaked. */
export function expectError(res: HttpResult, status: number, mustNotContain: string[] = []): void {
  const text = typeof res.body === "string" ? res.body : JSON.stringify(res.body);
  expect(res.status, `status (body ${text.slice(0, 200)})`).toBe(status);
  expect(res.headers.get("content-type") ?? "").toMatch(/application\/json/);
  expect(res.headers.get("location")).toBeNull();
  expect(typeof res.body).toBe("object");
  const body = res.body as Record<string, unknown>;
  expect(Object.keys(body)).toEqual(["error"]);
  expect(typeof body.error).toBe("string");
  expect((body.error as string).length).toBeGreaterThan(0);
  expect(leakProblems(text)).toEqual([]);
  for (const s of mustNotContain) expect(text).not.toContain(s);
}

/** The R41 sweep, run at the end of each file. */
export function expectNoLeaks(): void {
  expect(seen.length).toBeGreaterThan(0);
  const bad = seen
    .map((s) => ({ label: s.label, status: s.status, problems: leakProblems(s.text) }))
    .filter((s) => s.problems.length > 0);
  expect(bad).toEqual([]);
  for (const s of seen) if (s.status >= 500) expect(s.text.split("\n")[0]).toBe(JSON.stringify({ error: "Internal error" }));
}

// ---- seeded data lookups (read-only, with pg as postgres) ----

export interface SeededIds {
  northwindOrgId: string;
  betaOrgId: string;
  aisyahLease: string;
  benLease: string;
  probeLease: string;
  chenLease: string;
  aisyahCash: string;
  aisyahTransfer: string;
  betaUnit: string;
  chenTenant: string;
  northwindTenantNames: string[];
}

async function one(text: string, params: unknown[]): Promise<string> {
  const rows = await sql<{ id: string }>(text, params);
  if (rows.length !== 1) throw new Error(`seed lookup expected 1 row, got ${rows.length}: ${text} ${JSON.stringify(params)}`);
  return rows[0].id;
}

const leaseOf = (email: string) =>
  one(
    "select l.id from public.leases l join public.tenants t on t.id = l.tenant_id and t.org_id = l.org_id where lower(t.email) = $1",
    [email],
  );

export async function loadSeededIds(): Promise<SeededIds> {
  const northwindOrgId = await one(
    "select m.org_id as id from public.memberships m join auth.users u on u.id = m.user_id where u.email = $1",
    ["manager@northwind.test"],
  );
  const betaOrgId = await one(
    "select m.org_id as id from public.memberships m join auth.users u on u.id = m.user_id where u.email = $1",
    ["manager@beta.test"],
  );
  const aisyahLease = await leaseOf("aisyah@northwind.test");
  const names = await sql<{ full_name: string }>("select full_name from public.tenants where org_id = $1", [northwindOrgId]);
  return {
    northwindOrgId,
    betaOrgId,
    aisyahLease,
    benLease: await leaseOf("ben@northwind.test"),
    probeLease: await leaseOf("probe@northwind.test"),
    chenLease: await leaseOf("chen@beta.test"),
    aisyahCash: await one("select id from public.payments where lease_id = $1 and method = 'cash'", [aisyahLease]),
    aisyahTransfer: await one("select id from public.payments where lease_id = $1 and method = 'bank_transfer'", [aisyahLease]),
    betaUnit: await one("select id from public.units where org_id = $1 and name = 'KL-1'", [betaOrgId]),
    chenTenant: await one("select id from public.tenants where org_id = $1 and lower(email) = 'chen@beta.test'", [betaOrgId]),
    northwindTenantNames: names.map((n) => n.full_name),
  };
}

export async function count(text: string, params: unknown[]): Promise<number> {
  const rows = await sql<{ n: number }>(`select count(*)::int as n from (${text}) q`, params);
  return rows[0].n;
}

export const paymentStatus = async (id: string): Promise<string> =>
  (await sql<{ status: string }>("select status from public.payments where id = $1", [id]))[0].status;
