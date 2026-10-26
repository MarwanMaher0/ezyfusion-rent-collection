import { spawn, type ChildProcess } from "node:child_process";

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

export async function setup(): Promise<void> {
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
