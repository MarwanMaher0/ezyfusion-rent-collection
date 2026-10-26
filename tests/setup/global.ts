import { spawn, type ChildProcess } from "node:child_process";
import pg from "pg";

// globalSetup: make sure a Next server answers on TEST_BASE_URL. If the lead's dev server
// (http://127.0.0.1:3000) is down, start `next dev -p 3100` for this run and stop it in teardown,
// so `npm test` works from a clean shell after `supabase start && supabase db reset`.
const DEFAULT_BASE = "http://127.0.0.1:3000";
const FALLBACK_PORT = 3100;
const FALLBACK_BASE = `http://127.0.0.1:${FALLBACK_PORT}`;
const START_TIMEOUT_MS = 150_000;

let child: ChildProcess | undefined;

async function answers(base: string): Promise<boolean> {
  try {
    // Any HTTP response (even 404) means a server is listening.
    await fetch(base, { redirect: "manual", signal: AbortSignal.timeout(3_000) });
    return true;
  } catch {
    return false;
  }
}

// The fast gate resets the DB right before the suite, so the brief's seed may be missing. If the
// seeded manager account does not exist, run `npm run seed` once (the real seed, R5) and fail setup
// if it fails. The seed itself refuses when the brief orgs already exist (D48), so this never
// double-seeds.
const SEED_MARKER_EMAIL = "manager@northwind.test";
const SEED_TIMEOUT_MS = 180_000;

async function seededAccountExists(): Promise<boolean> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("globalSetup: DATABASE_URL is not set (expected in .env.local)");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const r = await client.query("select 1 from auth.users where lower(email) = $1", [SEED_MARKER_EMAIL]);
    return (r.rowCount ?? 0) > 0;
  } finally {
    await client.end().catch(() => undefined);
  }
}

function runSeed(): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn("npm", ["run", "seed"], { stdio: "inherit", env: { ...process.env } });
    const timer = setTimeout(() => {
      p.kill("SIGTERM");
      reject(new Error(`globalSetup: npm run seed did not finish in ${SEED_TIMEOUT_MS} ms`));
    }, SEED_TIMEOUT_MS);
    p.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`globalSetup: npm run seed failed (exit ${code ?? signal})`));
    });
  });
}

async function ensureSeeded(): Promise<void> {
  if (await seededAccountExists()) return;
  await runSeed();
  if (!(await seededAccountExists())) {
    throw new Error(`globalSetup: npm run seed exited 0 but ${SEED_MARKER_EMAIL} still does not exist`);
  }
}

export async function setup(): Promise<void> {
  await ensureServer();
  await ensureSeeded();
}

async function ensureServer(): Promise<void> {
  const base = (process.env.TEST_BASE_URL || DEFAULT_BASE).replace(/\/+$/, "");
  if (await answers(base)) {
    process.env.TEST_BASE_URL = base;
    return;
  }
  if (await answers(FALLBACK_BASE)) {
    process.env.TEST_BASE_URL = FALLBACK_BASE;
    return;
  }
  child = spawn("npx", ["next", "dev", "-p", String(FALLBACK_PORT)], {
    stdio: "ignore",
    detached: true, // own process group, so teardown can kill next and its workers together
    env: { ...process.env },
  });
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await answers(FALLBACK_BASE)) {
      process.env.TEST_BASE_URL = FALLBACK_BASE; // inherited by the test workers
      return;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  await teardown();
  throw new Error(`No server on ${base} and next dev did not come up on ${FALLBACK_BASE}`);
}

export async function teardown(): Promise<void> {
  if (child?.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // already gone
    }
    child = undefined;
  }
}
