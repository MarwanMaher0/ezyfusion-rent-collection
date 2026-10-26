import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminClient, userClient } from "../helpers/clients";
import { errorBody } from "../helpers/contract";
import { closePool, sql } from "../helpers/db";
import { createFixtureOrg, type FixtureOrg } from "../helpers/fixtures";
import { api } from "../helpers/http";

// R20 "If recording fails after the upload, the file must not be left behind." Every case uploads a
// real slip with the staff token (the UI path, D22), then makes POST /api/leases/:leaseId/payments fail,
// and checks storage.objects with pg (postgres) that the object is gone. R44: a failing request must never
// delete a slip in ANOTHER org's folder (the server deletes only inside the caller's own org folder).

const BUCKET = "payment-slips";
// 1x1 transparent PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const LEASE = { startDate: "2026-01-01", endDate: "2026-06-30", monthlyRentSen: 100000, depositSen: 0 };
const RECEIVED_AT = "2026-02-01T10:00:00+08:00";

let A: FixtureOrg;
let B: FixtureOrg;
const created = new Set<string>();

async function objectExists(name: string): Promise<boolean> {
  const rows = await sql("select 1 from storage.objects where bucket_id = $1 and name = $2", [BUCKET, name]);
  return rows.length === 1;
}

/** Uploads a PNG slip as `org`'s staff into `<org>/<org.lease>/<uuid>.png` and proves it landed. */
async function uploadPng(org: FixtureOrg): Promise<string> {
  const path = `${org.orgId}/${org.lease!.id}/${randomUUID()}.png`;
  created.add(path);
  const { error } = await userClient(org.tokens.staff)
    .storage.from(BUCKET)
    .upload(path, PNG, { contentType: "image/png", upsert: false });
  expect(error).toBeNull();
  expect(await objectExists(path)).toBe(true);
  return path;
}

const body = (slipPath: string, receivedAt = RECEIVED_AT) => ({
  amountSen: 1000,
  method: "bank_transfer",
  receivedAt,
  slipPath,
});

function expectErrorBody(res: { body: unknown }) {
  expect(errorBody.safeParse(res.body).success).toBe(true);
}

beforeAll(async () => {
  [A, B] = await Promise.all([createFixtureOrg({ lease: LEASE }), createFixtureOrg({ lease: LEASE })]);
});

afterAll(async () => {
  if (created.size) await adminClient().storage.from(BUCKET).remove([...created]);
  await closePool();
});

describe("R20 R44 POST /api/leases/:leaseId/payments failing after the upload removes the caller's slip", () => {
  it("nonexistent (well-formed) lease id -> 404 and the slip is gone", async () => {
    const path = await uploadPng(A);
    const res = await api(A.tokens.staff).post(`/api/leases/${randomUUID()}/payments`, body(path));
    expect(res.status).toBe(404);
    expectErrorBody(res);
    expect(await objectExists(path)).toBe(false);
  });

  it("another org's lease -> 404 and the slip (in the caller's own org folder) is gone", async () => {
    const path = await uploadPng(A);
    const res = await api(A.tokens.staff).post(`/api/leases/${B.lease!.id}/payments`, body(path));
    expect(res.status).toBe(404);
    expectErrorBody(res);
    expect(await objectExists(path)).toBe(false);
  });

  it("own lease, receivedAt without an offset -> 400 and the slip is gone", async () => {
    const path = await uploadPng(A);
    const res = await api(A.tokens.staff).post(`/api/leases/${A.lease!.id}/payments`, body(path, "2026-02-01T10:00:00"));
    expect(res.status).toBe(400);
    expectErrorBody(res);
    expect(await objectExists(path)).toBe(false);
  });

  // Not recoverable: with an unparseable body the server cannot learn slipPath, so it has nothing to
  // delete. Cleaning such orphans needs a sweeper (objects with no payments.slip_path), which SPEC does not have.
  // So there is no test for that case; the next test pins that such a request never deletes anything.

  it("malformed JSON body -> 400 JSON and never deletes anything", async () => {
    const path = await uploadPng(A);
    const res = await api(A.tokens.staff).post(`/api/leases/${A.lease!.id}/payments`, `{"slipPath":"${path}",`);
    expect(res.status).toBe(400);
    expectErrorBody(res);
    expect(await objectExists(path)).toBe(true);
  });
});

describe("R20 R44 a failing POST /api/leases/:leaseId/payments never deletes a slip in another org's folder", () => {
  it("org A staff names org B's slip on org A's lease with a bad receivedAt -> 400, B's slip stays", async () => {
    const bPath = await uploadPng(B);
    const res = await api(A.tokens.staff).post(`/api/leases/${A.lease!.id}/payments`, body(bPath, "2026-02-01T10:00:00"));
    expect(res.status).toBe(400);
    expectErrorBody(res);
    expect(await objectExists(bPath)).toBe(true);
  });

  it("org A staff names org B's slip on org A's lease with a valid body -> 400 (not its org folder), B's slip stays", async () => {
    const bPath = await uploadPng(B);
    const res = await api(A.tokens.staff).post(`/api/leases/${A.lease!.id}/payments`, body(bPath));
    expect(res.status).toBe(400);
    expectErrorBody(res);
    expect(await objectExists(bPath)).toBe(true);
  });

  it("org A staff names org B's slip on org B's lease -> 404, B's slip stays", async () => {
    const bPath = await uploadPng(B);
    const res = await api(A.tokens.staff).post(`/api/leases/${B.lease!.id}/payments`, body(bPath));
    expect(res.status).toBe(404);
    expectErrorBody(res);
    expect(await objectExists(bPath)).toBe(true);
  });

  it("org A staff names org B's slip on a nonexistent lease -> 404, B's slip stays", async () => {
    const bPath = await uploadPng(B);
    const res = await api(A.tokens.staff).post(`/api/leases/${randomUUID()}/payments`, body(bPath));
    expect(res.status).toBe(404);
    expectErrorBody(res);
    expect(await objectExists(bPath)).toBe(true);
  });

  it("org A's tenant (not a recorder) naming org A's slip -> 403, and the slip is not deleted by a non-member", async () => {
    const path = await uploadPng(A);
    const res = await api(A.tokens.tenantA).post(`/api/leases/${A.lease!.id}/payments`, body(path));
    expect(res.status).toBe(403);
    expectErrorBody(res);
    // A tenant has no staff/manager membership, so the server has no org folder to clean for it.
    expect(await objectExists(path)).toBe(true);
  });
});
