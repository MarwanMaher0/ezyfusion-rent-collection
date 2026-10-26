import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { leaseFormOptions } from "@/server/services/leases";
import { closePool, sql } from "../helpers/db";
import { createFixtureOrg, createFixtureUser, insertTenant, insertUnit, type FixtureOrg } from "../helpers/fixtures";

// leaseFormOptions feeds the "new lease" form with the caller's org units and tenants. Prisma bypasses
// RLS, so the only thing keeping org B's rows out is the service's requireMember + org_id scoping.
// Expected sets are read independently with pg as postgres, never from the service itself.

let A: FixtureOrg;
let B: FixtureOrg;
let outsiderId: string;

const sorted = (xs: string[]) => [...xs].sort();

async function idsOf(table: "units" | "tenants", orgId: string): Promise<string[]> {
  const rows = await sql<{ id: string }>(`select id from public.${table} where org_id = $1`, [orgId]);
  return sorted(rows.map((r) => r.id));
}

async function expectStatus(p: Promise<unknown>, status: number): Promise<void> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err, "expected the service to throw").toBeInstanceOf(ApiError);
  expect((err as ApiError).status).toBe(status);
}

beforeAll(async () => {
  [A, B] = await Promise.all([createFixtureOrg(), createFixtureOrg()]);
  // An extra unit and an unlinked tenant (user_id null) so A's sets are not just the fixture defaults.
  const tag = randomUUID().slice(0, 8);
  await insertUnit(A.orgId);
  await insertTenant(A.orgId, null, `Walk-in ${tag}`, `walkin-${tag}@fixture.test`);
  outsiderId = (await createFixtureUser(`nomember-${tag}`)).userId;
});

afterAll(async () => {
  await closePool();
  await prisma.$disconnect();
});

describe("R36 R39 leaseFormOptions (service) is manager-only and scoped to the caller's org", () => {
  it("manager of A gets exactly A's unit ids and tenant ids", async () => {
    const out = await leaseFormOptions({ userId: A.users.manager.userId });
    expect(sorted(out.units.map((u) => u.id))).toEqual(await idsOf("units", A.orgId));
    expect(sorted(out.tenants.map((t) => t.id))).toEqual(await idsOf("tenants", A.orgId));
    expect(out.units.length).toBe(3);
    expect(out.tenants.length).toBe(3);
  });

  it("manager of A sees none of B's units or tenants", async () => {
    const out = await leaseFormOptions({ userId: A.users.manager.userId });
    const seen = new Set([...out.units.map((u) => u.id), ...out.tenants.map((t) => t.id)]);
    const bIds = [...(await idsOf("units", B.orgId)), ...(await idsOf("tenants", B.orgId))];
    expect(bIds.length).toBeGreaterThan(0);
    for (const id of bIds) expect(seen.has(id), `B row ${id} leaked to A's manager`).toBe(false);
  });

  it("manager of B gets exactly B's sets (scoping follows the caller, not a fixed org)", async () => {
    const out = await leaseFormOptions({ userId: B.users.manager.userId });
    expect(sorted(out.units.map((u) => u.id))).toEqual(await idsOf("units", B.orgId));
    expect(sorted(out.tenants.map((t) => t.id))).toEqual(await idsOf("tenants", B.orgId));
  });

  it("staff of A -> 403", async () => {
    await expectStatus(leaseFormOptions({ userId: A.users.staff.userId }), 403);
  });

  it("tenant of A (no membership, linked tenant row) -> 403", async () => {
    await expectStatus(leaseFormOptions({ userId: A.users.tenantA.userId }), 403);
  });

  it("a signed-up user with no membership and no tenant row -> 403", async () => {
    await expectStatus(leaseFormOptions({ userId: outsiderId }), 403);
  });

  it("a well-formed but unknown user id -> 403 (no membership found)", async () => {
    await expectStatus(leaseFormOptions({ userId: randomUUID() }), 403);
  });
});
