import { afterAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ApiError, badRequest, conflict, forbidden, notFound, toErrorResponse, unauthorized, unprocessable, withRetry } from "@/lib/errors";
import { prisma } from "@/lib/prisma";

// Error contract (SPEC): body is exactly { error: string }; private.* SQLSTATEs P0400/P0404/P0409/P0422,
// 23P01/23505 -> 409, 22P02 -> 400, 40001/40P01 -> one retry then 409; anything else -> 500
// { error: 'Internal error' } with no SQL and no stack. The DB errors are raised for real through
// Prisma 7 + adapter-pg (no mocks), so the test proves errors.ts finds the SQLSTATE where Prisma puts it.

const errorBody = z.object({ error: z.string().min(1) }).strict();

async function raised(sqlstate: string, message = `boom ${sqlstate}`): Promise<unknown> {
  try {
    await prisma.$executeRawUnsafe(
      `do $$ begin raise exception using errcode = '${sqlstate}', message = '${message}'; end $$`,
    );
  } catch (e) {
    return e;
  }
  throw new Error(`expected ${sqlstate} to be raised`);
}

async function failing(query: string): Promise<unknown> {
  try {
    await prisma.$queryRawUnsafe(query);
  } catch (e) {
    return e;
  }
  throw new Error(`expected "${query}" to fail`);
}

async function respond(e: unknown): Promise<{ status: number; body: { error: string }; type: string | null }> {
  const res = toErrorResponse(e);
  return { status: res.status, body: errorBody.parse(await res.json()), type: res.headers.get("content-type") };
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe("R45 Error contract: private.* SQLSTATEs through Prisma keep their own message", () => {
  it.each([
    ["P0400", 400],
    ["P0404", 404],
    ["P0409", 409],
    ["P0422", 422],
  ])("%s -> %d { error: <the plpgsql message> }", async (code, status) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = await respond(await raised(code, `Readable ${code} message`));
    expect(r.status).toBe(status);
    expect(r.body).toEqual({ error: `Readable ${code} message` });
    expect(r.type).toMatch(/application\/json/);
  });

  it("the real private.record_payment P0404 (unknown lease) maps to 404 'Lease not found'", async () => {
    const e = await failing(
      `select * from private.record_payment(gen_random_uuid(), gen_random_uuid(), 100, 'cash', now(), null, null)`,
    );
    const r = await respond(e);
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: "Lease not found" });
  });
});

describe("R45 R46 Error contract: Postgres constraint / input / concurrency SQLSTATEs", () => {
  it("23P01 (exclusion, lease overlap) -> 409 with a fixed message, never the constraint text", async () => {
    const r = await respond(await raised("23P01", "conflicting key value violates exclusion constraint leases_no_overlap"));
    expect(r.status).toBe(409);
    expect(r.body.error).not.toMatch(/constraint|leases_no_overlap/);
  });

  it("23505 (unique) -> 409 with a fixed message", async () => {
    const r = await respond(await raised("23505", 'duplicate key value violates unique constraint "x_key"'));
    expect(r.status).toBe(409);
    expect(r.body.error).not.toMatch(/duplicate key|x_key/);
  });

  it("22P02 raised for real ('x'::uuid) -> 400, no SQL in the body", async () => {
    const r = await respond(await failing(`select 'not-a-uuid'::uuid`));
    expect(r.status).toBe(400);
    expect(r.body.error).not.toMatch(/uuid|syntax|select/i);
  });

  it.each(["40001", "40P01"])("%s (serialization / deadlock) -> 409", async (code) => {
    const r = await respond(await raised(code));
    expect(r.status).toBe(409);
  });

  it("an unmapped SQLSTATE (42P01, relation does not exist) -> 500 { error: 'Internal error' }", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = await respond(await failing("select * from public.no_such_table_t9"));
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: "Internal error" });
    // The server log never carries the SQL text.
    expect(JSON.stringify(spy.mock.calls)).not.toMatch(/no_such_table_t9/);
    spy.mockRestore();
  });

  it("an unmapped plpgsql code (P0001, a bare RAISE) -> 500, message not leaked", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = await respond(await raised("P0001", "secret internal detail"));
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: "Internal error" });
  });
});

describe("R45 Error contract: ApiError, ZodError and unknown errors", () => {
  it.each([
    [badRequest("bad"), 400, "bad"],
    [unauthorized(), 401, undefined],
    [forbidden(), 403, undefined],
    [notFound("Lease not found"), 404, "Lease not found"],
    [conflict("Payment is not pending"), 409, "Payment is not pending"],
    [unprocessable("Payment exceeds the remaining balance"), 422, "Payment exceeds the remaining balance"],
    [new ApiError(418, "teapot"), 418, "teapot"],
  ])("ApiError -> its status and { error: message }", async (e, status, message) => {
    const r = await respond(e);
    expect(r.status).toBe(status);
    if (message) expect(r.body).toEqual({ error: message });
  });

  it("ZodError -> 400 { error: string }", async () => {
    const parsed = z.object({ amountSen: z.number().int() }).strict().safeParse({ amountSen: "1" });
    expect(parsed.success).toBe(false);
    const r = await respond(parsed.error);
    expect(r.status).toBe(400);
  });

  it.each([
    ["a plain Error with SQL in its message", new Error("select * from payments where secret")],
    ["a thrown string", "boom"],
    ["null", null],
    ["undefined", undefined],
    ["an object with a fake SQLSTATE but no severity", { code: "P0409", message: "fake" }],
  ])("%s -> 500 { error: 'Internal error' }", async (_l, e) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = await respond(e);
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: "Internal error" });
  });
});

describe("R28 Error contract: withRetry retries a serialization failure / deadlock exactly once", () => {
  it.each(["40001", "40P01"])("%s once then success -> the value, 2 calls", async (code) => {
    const err = await raised(code);
    let calls = 0;
    const v = await withRetry(async () => {
      calls += 1;
      if (calls === 1) throw err;
      return "ok";
    });
    expect(v).toBe("ok");
    expect(calls).toBe(2);
  });

  it("40001 every time -> rethrown after exactly 2 calls, and maps to 409", async () => {
    const err = await raised("40001");
    let calls = 0;
    const p = withRetry(async () => {
      calls += 1;
      throw err;
    });
    await expect(p).rejects.toBe(err);
    expect(calls).toBe(2);
    expect((await respond(err)).status).toBe(409);
  });

  it.each(["P0409", "P0422", "23505", "23P01"])("non-retryable %s -> 1 call, rethrown", async (code) => {
    const err = await raised(code);
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls += 1;
        throw err;
      }),
    ).rejects.toBe(err);
    expect(calls).toBe(1);
  });

  it("a real DB call through withRetry succeeds on the first try", async () => {
    let calls = 0;
    const rows = await withRetry(async () => {
      calls += 1;
      return prisma.$queryRawUnsafe<{ one: number }[]>("select 1::int as one");
    });
    expect(rows).toEqual([{ one: 1 }]);
    expect(calls).toBe(1);
  });
});
