import pg from "pg";
import { env } from "./env";

// Direct Postgres access as the `postgres` owner (DATABASE_URL). For fixtures, catalog checks
// (information_schema / pg_catalog) and asserting DB state. Never used to reset the DB.

// Per-connection type parsers (never the global pg.types, which Prisma's adapter-pg also uses):
// int8 -> number when it is a safe integer (money is bigint sen, D3); date -> raw "YYYY-MM-DD"
// string, never a local-time Date (TZ-independent).
const INT8 = 20;
const DATE = 1082;
const types: pg.CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: "text" | "binary") => {
    if (oid === INT8)
      return (v: string) => {
        const n = Number(v);
        if (!Number.isSafeInteger(n)) throw new Error(`int8 ${v} is not a safe integer`);
        return n;
      };
    if (oid === DATE) return (v: string) => v;
    return pg.types.getTypeParser(oid, format ?? "text");
  }) as pg.CustomTypesConfig["getTypeParser"],
};

let shared: pg.Pool | undefined;

/** Shared pool for the current test file (max 5). Call closePool() in afterAll. */
export function pool(): pg.Pool {
  shared ??= new pg.Pool({ connectionString: env.databaseUrl, max: 5, types });
  return shared;
}

/** Run one parameterized query on the shared pool and return its rows. */
export async function sql<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await pool().query<T>(text, params);
  return res.rows;
}

/** A separate, already-connected client (its own session) for race tests: caller must `await c.end()`. */
export async function newConnection(): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: env.databaseUrl, types });
  await c.connect();
  return c;
}

export async function closePool(): Promise<void> {
  if (shared) {
    const p = shared;
    shared = undefined;
    await p.end();
  }
}
