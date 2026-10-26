import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { anonClient } from "./clients";
import { env } from "./env";

/** The 7 seeded accounts from the brief (npm run seed). All share SEED_PASSWORD. */
export const SEEDED = {
  northwindManager: "manager@northwind.test",
  northwindStaff: "staff@northwind.test",
  aisyah: "aisyah@northwind.test",
  ben: "ben@northwind.test",
  probe: "probe@northwind.test",
  betaManager: "manager@beta.test",
  chen: "chen@beta.test",
} as const;
export type SeededKey = keyof typeof SEEDED;

export interface Session {
  userId: string;
  email: string;
  accessToken: string;
}

// GoTrue rate-limits /token per IP (150 burst, then 1 per 2 s locally). Real sign-ins are cached
// in-process and on disk (node_modules/.cache) and reused only while the token has > 10 min left
// AND its session row still exists for the same user (so a db reset or sign-out invalidates it).
const CACHE_DIR = path.join(process.cwd(), "node_modules", ".cache", "rent-tests-sessions");
const MIN_TTL_S = 600;
const memo = new Map<string, Session>();

interface JwtClaims {
  sub: string;
  exp: number;
  session_id?: string;
}

function claims(token: string): JwtClaims {
  const part = token.split(".")[1] ?? "";
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as JwtClaims;
}

function cacheFile(email: string, password: string): string {
  const h = createHash("sha256").update(`${env.supabaseUrl}|${email}|${password}`).digest("hex");
  return path.join(CACHE_DIR, `${h.slice(0, 32)}.json`);
}

async function stillValid(s: Session): Promise<boolean> {
  let c: JwtClaims;
  try {
    c = claims(s.accessToken);
  } catch {
    return false;
  }
  if (c.sub !== s.userId || c.exp - Date.now() / 1000 < MIN_TTL_S || !c.session_id) return false;
  const client = new pg.Client({ connectionString: env.databaseUrl });
  try {
    await client.connect();
    const r = await client.query(
      `select 1 from auth.sessions s join auth.users u on u.id = s.user_id
        where s.id = $1 and u.id = $2 and lower(u.email) = lower($3)`,
      [c.session_id, s.userId, s.email],
    );
    return (r.rowCount ?? 0) === 1;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

function readCache(file: string): Session | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Session;
  } catch {
    return undefined;
  }
}

function writeCache(file: string, s: Session): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(s));
    renameSync(tmp, file); // atomic, so parallel workers never read half a file
  } catch {
    // cache is an optimisation only
  }
}

async function passwordGrant(email: string, password: string): Promise<Session> {
  for (let attempt = 0; ; attempt++) {
    const { data, error } = await anonClient().auth.signInWithPassword({ email, password });
    if (!error && data.session && data.user) {
      return { userId: data.user.id, email, accessToken: data.session.access_token };
    }
    const rateLimited = error?.status === 429 || /rate limit/i.test(error?.message ?? "");
    if (!rateLimited || attempt >= 20) {
      throw new Error(`signIn(${email}) failed: ${error?.status ?? ""} ${error?.message ?? "no session"}`);
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
}

/**
 * Real Supabase password sign-in (no mocks). Returns the user's id and access token.
 * `password` defaults to SEED_PASSWORD. Pass `{ fresh: true }` to bypass the cache
 * (e.g. a test that signs the session out afterwards).
 */
export async function signIn(
  email: string,
  password: string = env.seedPassword,
  opts: { fresh?: boolean } = {},
): Promise<Session> {
  const file = cacheFile(email, password);
  if (!opts.fresh) {
    const hit = memo.get(file) ?? readCache(file);
    if (hit && (await stillValid(hit))) {
      memo.set(file, hit);
      return hit;
    }
  }
  const s = await passwordGrant(email, password);
  if (!opts.fresh) {
    memo.set(file, s);
    writeCache(file, s);
  }
  return s;
}

/** Sign in one of the seeded accounts by key, e.g. `await seeded('aisyah')`. */
export function seeded(key: SeededKey): Promise<Session> {
  return signIn(SEEDED[key]);
}

/** `{ userId }` ctx for calling services directly (src/server/services/**) as a real seeded user. */
export async function ctxFor(key: SeededKey): Promise<{ userId: string }> {
  const s = await seeded(key);
  return { userId: s.userId };
}
