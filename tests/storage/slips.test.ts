import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminClient, anonClient, userClient } from "../helpers/clients";
import { closePool, sql } from "../helpers/db";
import { createFixtureOrg, type FixtureOrg } from "../helpers/fixtures";

// R44 / R20 Storage: bucket payment-slips through the Storage API with the publishable key + user
// JWTs. Every object this file creates is tracked and removed in afterAll with the secret key;
// object existence is always double-checked in storage.objects with pg.

const BUCKET = "payment-slips";
// 1x1 transparent PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
const LEASE = { startDate: "2026-01-01", endDate: "2026-06-30", monthlyRentSen: 100000, depositSen: 0 };

let A: FixtureOrg;
let B: FixtureOrg;
let staffPath: string; // uploaded by A.staff into org A's folder
let managerPath: string;
let bPath: string; // uploaded by B.staff into org B's folder
const created = new Set<string>();

const store = (c: SupabaseClient) => c.storage.from(BUCKET);
const slipPath = (org: FixtureOrg, ext = "png") => `${org.orgId}/${org.lease!.id}/${randomUUID()}.${ext}`;

async function objectExists(name: string): Promise<boolean> {
  const rows = await sql("select 1 from storage.objects where bucket_id = $1 and name = $2", [BUCKET, name]);
  return rows.length === 1;
}

async function objectsUnder(prefix: string): Promise<string[]> {
  const rows = await sql<{ name: string }>("select name from storage.objects where bucket_id = $1 and name like $2", [
    BUCKET,
    `${prefix}%`,
  ]);
  return rows.map((r) => r.name);
}

async function upload(c: SupabaseClient, path: string, body: Buffer = PNG, contentType = "image/png", upsert = false) {
  created.add(path);
  return store(c).upload(path, body, { contentType, upsert });
}

beforeAll(async () => {
  [A, B] = await Promise.all([createFixtureOrg({ lease: LEASE }), createFixtureOrg({ lease: LEASE })]);
  staffPath = slipPath(A);
  managerPath = slipPath(A, "pdf");
  bPath = slipPath(B);
});

afterAll(async () => {
  const names = [...created];
  // Also sweep anything a traversal probe may have produced under either fixture org.
  for (const org of [A, B]) if (org) names.push(...(await objectsUnder(`${org.orgId}/`)));
  if (names.length) await store(adminClient()).remove([...new Set(names)]);
  await closePool();
});

describe("R44 R20 storage upload: only staff/manager of the org, into their own org folder", () => {
  it("staff uploads a small PNG to <own_org_id>/<lease_id>/<uuid>.png", async () => {
    const { error } = await upload(userClient(A.tokens.staff), staffPath);
    expect(error).toBeNull();
    expect(await objectExists(staffPath)).toBe(true);
  });

  it("manager uploads a PDF to their own org folder", async () => {
    const { error } = await upload(userClient(A.tokens.manager), managerPath, PDF, "application/pdf");
    expect(error).toBeNull();
    expect(await objectExists(managerPath)).toBe(true);
  });

  it("staff of org B uploads into org B (setup for cross-org reads)", async () => {
    const { error } = await upload(userClient(B.tokens.staff), bPath);
    expect(error).toBeNull();
  });

  for (const who of ["tenantA", "tenantB", "anon"] as const) {
    it(`${who} cannot upload into org A's folder`, async () => {
      const c = who === "anon" ? anonClient() : userClient(A.tokens[who]);
      const p = slipPath(A);
      const { error } = await upload(c, p);
      expect(error).not.toBeNull();
      expect(await objectExists(p)).toBe(false);
    });
  }

  for (const who of ["staff", "manager"] as const) {
    it(`org B ${who} cannot upload into org A's folder`, async () => {
      const p = slipPath(A);
      const { error } = await upload(userClient(B.tokens[who]), p);
      expect(error).not.toBeNull();
      expect(await objectExists(p)).toBe(false);
    });
  }

  it("staff cannot upload outside an org folder: bucket root, random uuid folder, non-uuid folder", async () => {
    for (const p of [`${randomUUID()}.png`, `${randomUUID()}/${randomUUID()}.png`, `not-an-org/${randomUUID()}.png`]) {
      const { error } = await upload(userClient(A.tokens.staff), p);
      expect({ p, refused: error !== null }).toEqual({ p, refused: true });
      expect(await objectExists(p)).toBe(false);
    }
  });

  it("path traversal ('../' and encoded) from own folder into another org's folder is refused or stays inside own folder", async () => {
    const target = `${B.orgId}/${randomUUID()}.png`;
    const probes = [
      `${A.orgId}/../${target}`,
      `${A.orgId}/%2e%2e/${target}`,
      `${A.orgId}/..%2f${target}`,
      `./${A.orgId}/../${target}`,
    ];
    for (const p of probes) {
      const { data, error } = await upload(userClient(A.tokens.staff), p);
      if (!error) {
        // Accepted only as an opaque key that still starts with A's folder.
        expect(data?.path.startsWith(`${A.orgId}/`)).toBe(true);
      }
    }
    expect(await objectsUnder(target)).toEqual([]);
    const [b] = await sql<{ n: number }>(
      "select count(*)::int as n from storage.objects where bucket_id = $1 and name like $2 and name not in ($3)",
      [BUCKET, `${B.orgId}/%`, bPath],
    );
    expect(b.n).toBe(0);
    // And org B's own staff cannot find anything planted at the traversal target.
    const { error } = await store(userClient(B.tokens.staff)).download(target);
    expect(error).not.toBeNull();
  });

  it("oversize file (> 5 MiB) is rejected", async () => {
    const p = slipPath(A);
    const big = Buffer.alloc(5 * 1024 * 1024 + 1, 0);
    PNG.copy(big);
    const { error } = await upload(userClient(A.tokens.staff), p, big, "image/png");
    expect(error).not.toBeNull();
    expect(await objectExists(p)).toBe(false);
  });

  it("wrong MIME types are rejected (text/plain, text/html, image/svg+xml, application/octet-stream)", async () => {
    for (const mime of ["text/plain", "text/html", "image/svg+xml", "application/octet-stream"]) {
      const p = slipPath(A, "png");
      const { error } = await upload(userClient(A.tokens.staff), p, Buffer.from("<script>alert(1)</script>"), mime);
      expect({ mime, refused: error !== null }).toEqual({ mime, refused: true });
      expect(await objectExists(p)).toBe(false);
    }
  });

  it("staff cannot overwrite (upsert) an existing slip: no UPDATE policy", async () => {
    const [before] = await sql<{ j: unknown }>(
      "select to_jsonb(o) - 'last_accessed_at' as j from storage.objects o where bucket_id = $1 and name = $2",
      [BUCKET, staffPath],
    );
    const { error } = await upload(userClient(A.tokens.manager), staffPath, PNG, "image/png", true);
    expect(error).not.toBeNull();
    const [after] = await sql<{ j: unknown }>(
      "select to_jsonb(o) - 'last_accessed_at' as j from storage.objects o where bucket_id = $1 and name = $2",
      [BUCKET, staffPath],
    );
    expect(after.j).toEqual(before.j);
  });

  it("nobody (staff, manager, tenant, other org, anon) can delete or move a slip: no DELETE/UPDATE policy", async () => {
    const clients = [
      userClient(A.tokens.staff),
      userClient(A.tokens.manager),
      userClient(A.tokens.tenantA),
      userClient(B.tokens.manager),
      anonClient(),
    ];
    for (const c of clients) {
      await store(c).remove([staffPath]);
      await store(c).move(staffPath, `${A.orgId}/${randomUUID()}.png`);
      expect(await objectExists(staffPath)).toBe(true);
    }
  });
});

describe("R44 D74 storage read: own-org staff/manager read with their own token (short-lived signed URL); nobody else can read, list or sign", () => {
  it("a 60 s signed URL created with the secret key serves the exact bytes (positive control: the server's read path)", async () => {
    const { data, error } = await store(adminClient()).createSignedUrl(staffPath, 60);
    expect(error).toBeNull();
    expect(data?.signedUrl).toBeTruthy();
    const res = await fetch(data!.signedUrl);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
  });

  for (const who of ["staff", "manager"] as const) {
    it(`org A ${who} downloads its own org's slips with their own token (D74 SELECT policy)`, async () => {
      for (const [p, bytes] of [
        [staffPath, PNG],
        [managerPath, PDF],
      ] as const) {
        const { data, error } = await store(userClient(A.tokens[who])).download(p);
        expect({ p, error }).toEqual({ p, error: null });
        expect(Buffer.from(await data!.arrayBuffer()).equals(bytes)).toBe(true);
      }
    });

    it(`org A ${who} creates a 60 s signed URL with their own token and it serves the bytes`, async () => {
      const { data, error } = await store(userClient(A.tokens[who])).createSignedUrl(staffPath, 60);
      expect(error).toBeNull();
      expect(data?.signedUrl).toBeTruthy();
      const res = await fetch(data!.signedUrl);
      expect(res.status).toBe(200);
      expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
    });

    it(`org A ${who} cannot read or sign org B's slip`, async () => {
      const c = store(userClient(A.tokens[who]));
      const dl = await c.download(bPath);
      expect(dl.error).not.toBeNull();
      const signed = await c.createSignedUrl(bPath, 60);
      expect(signed.error !== null || !signed.data?.signedUrl).toBe(true);
    });

    it(`org A ${who} still uploads a new slip into their own org folder (upsert false)`, async () => {
      const p = slipPath(A);
      const { error } = await upload(userClient(A.tokens[who]), p, PNG, "image/png", false);
      expect(error).toBeNull();
      expect(await objectExists(p)).toBe(true);
    });
  }

  const outsiders = () =>
    [
      ["anon", anonClient()],
      ["tenantA (lease's own tenant)", userClient(A.tokens.tenantA)],
      ["tenantB", userClient(A.tokens.tenantB)],
      ["org B staff", userClient(B.tokens.staff)],
      ["org B manager", userClient(B.tokens.manager)],
    ] as const;

  it("outsiders cannot download the slip", async () => {
    for (const [who, c] of outsiders()) {
      const { data, error } = await store(c).download(staffPath);
      expect({ who, refused: error !== null && data === null }).toEqual({ who, refused: true });
    }
  });

  it("outsiders cannot create a signed URL for it", async () => {
    for (const [who, c] of outsiders()) {
      const { data, error } = await store(c).createSignedUrl(staffPath, 60);
      expect({ who, refused: error !== null || !data?.signedUrl }).toEqual({ who, refused: true });
    }
  });

  it("outsiders listing org A's folders see nothing", async () => {
    for (const [who, c] of outsiders()) {
      for (const prefix of [A.orgId, `${A.orgId}/${A.lease!.id}`, ""]) {
        const { data } = await store(c).list(prefix);
        const names = (data ?? []).map((o) => o.name);
        expect({ who, prefix, names: names.filter((n) => staffPath.includes(n) && n.length > 0) }).toEqual({
          who,
          prefix,
          names: [],
        });
      }
    }
  });

  it("the public URL of the slip does not serve the file (bucket is private)", async () => {
    const { data } = store(anonClient()).getPublicUrl(staffPath);
    const res = await fetch(data.publicUrl);
    expect(res.status).toBeGreaterThanOrEqual(400);
    await res.arrayBuffer();
  });

  it("an authenticated object URL with a tenant token is refused", async () => {
    const { data } = store(anonClient()).getPublicUrl(staffPath);
    const url = data.publicUrl.replace("/object/public/", "/object/authenticated/");
    const res = await fetch(url, { headers: { Authorization: `Bearer ${A.tokens.tenantA}` } });
    expect(res.status).toBeGreaterThanOrEqual(400);
    await res.arrayBuffer();
  });

  it("org A staff cannot read org B's slip", async () => {
    const { error } = await store(userClient(A.tokens.staff)).download(bPath);
    expect(error).not.toBeNull();
  });

  it("listing buckets as anon/tenant does not reveal payment-slips config to write to", async () => {
    // Bucket metadata is not secret, but no client may create or update a bucket.
    const { error } = await userClient(A.tokens.manager).storage.createBucket(`evil-${randomUUID().slice(0, 6)}`, { public: true });
    expect(error).not.toBeNull();
    const { error: e2 } = await userClient(A.tokens.manager).storage.updateBucket(BUCKET, { public: true });
    expect(e2).not.toBeNull();
    const [b] = await sql<{ public: boolean }>("select public from storage.buckets where id = $1", [BUCKET]);
    expect(b.public).toBe(false);
  });
});

describe("R44 R20 slip_path must point to an existing file in its own org's folder (record_payment)", () => {
  const rec = (actor: string, leaseId: string, slip: string) =>
    sql("select * from private.record_payment($1, $2, 100, 'bank_transfer', now(), $3, null)", [actor, leaseId, slip]);

  it("a slip that exists but lives in another org's folder is refused P0400", async () => {
    await expect(rec(A.users.staff.userId, A.lease!.id, bPath)).rejects.toMatchObject({ code: "P0400" });
  });

  it("a path in the own org folder with no uploaded object is refused P0400", async () => {
    await expect(rec(A.users.staff.userId, A.lease!.id, slipPath(A))).rejects.toMatchObject({ code: "P0400" });
  });

  it("a traversal-looking slip path is refused", async () => {
    await expect(rec(A.users.staff.userId, A.lease!.id, `${A.orgId}/../${bPath}`)).rejects.toMatchObject({ code: "P0400" });
  });
});
