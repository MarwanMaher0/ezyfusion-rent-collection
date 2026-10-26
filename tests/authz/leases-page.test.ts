import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { listLeasesPage } from "@/server/services/leases";
import { closePool, pool, sql } from "../helpers/db";
import { createFixtureOrg, createFixtureUser, insertUnit, type FixtureOrg } from "../helpers/fixtures";

// listLeasesPage runs on Prisma (bypasses RLS), so org/tenant scoping of BOTH the page (skip/take)
// and the total count is the service's job. Expected sets/orders are read independently with pg.

let A: FixtureOrg;
let B: FixtureOrg;
let outsiderId: string;
const PAGE_SIZE = 5;

async function insertBareLease(org: FixtureOrg, unitId: string, tenantId: string, start: string, end: string): Promise<string> {
  // Leases only (no invoices): pagination only reads leases + unit/tenant names.
  const { rows } = await pool().query<{ id: string }>(
    `insert into public.leases (org_id, unit_id, tenant_id, start_date, end_date, monthly_rent_sen, deposit_sen, created_by)
     values ($1, $2, $3, $4::date, $5::date, 150000, 0, $6) returning id`,
    [org.orgId, unitId, tenantId, start, end, org.users.manager.userId],
  );
  return rows[0].id;
}

/** Expected order of a where clause, computed by the DB itself (same collation the service sorts with). */
async function expectedIds(where: string, params: unknown[]): Promise<string[]> {
  const rows = await sql<{ id: string }>(
    `select l.id from public.leases l
       join public.units u on u.id = l.unit_id
       join public.tenants t on t.id = l.tenant_id
      where ${where}
      order by u.name asc, l.start_date asc, l.id asc`,
    params,
  );
  return rows.map((r) => r.id);
}

async function allPages(userId: string, q: string | null, pageSize: number): Promise<string[]> {
  const first = await listLeasesPage({ userId }, { q, page: 1, pageSize });
  const ids = first.items.map((i) => i.id);
  for (let p = 2; p <= first.pageCount; p++) {
    const page = await listLeasesPage({ userId }, { q, page: p, pageSize });
    expect(page.page).toBe(p);
    expect(page.total).toBe(first.total);
    ids.push(...page.items.map((i) => i.id));
  }
  return ids;
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
  [A, B] = await Promise.all([
    createFixtureOrg({ units: 0 }),
    createFixtureOrg({ lease: { startDate: "2026-01-01", endDate: "2026-06-30", monthlyRentSen: 120000, depositSen: 0 } }),
  ]);
  // 12 leases on 12 distinct units P-01..P-12 (tenant A on odd, tenant B on even), plus a second,
  // earlier, non-overlapping lease on P-03 so the start_date tiebreak is exercised.
  for (let i = 1; i <= 12; i++) {
    const unitId = await insertUnit(A.orgId, `P-${String(i).padStart(2, "0")}`);
    await insertBareLease(A, unitId, i % 2 === 1 ? A.tenantAId : A.tenantBId, "2026-03-01", "2027-02-28");
    if (i === 3) await insertBareLease(A, unitId, A.tenantBId, "2025-01-01", "2025-12-31");
  }
  // A unit in org B whose name also matches q='P-1': must never show up for org A.
  const bUnit = await insertUnit(B.orgId, "P-10");
  await insertBareLease(B, bUnit, B.tenantAId, "2026-03-01", "2027-02-28");
  outsiderId = (await createFixtureUser(`nomember-${randomUUID().slice(0, 8)}`)).userId;
});

afterAll(async () => {
  await closePool();
  await prisma.$disconnect();
});

describe("R36 R56 leases pagination (listLeasesPage service): scoped skip/take, total, clamping", () => {
  it("manager A, page 1, pageSize 5 -> 5 items, total = org A lease count, pageCount = ceil(total/5)", async () => {
    const expected = await expectedIds("l.org_id = $1", [A.orgId]);
    expect(expected.length).toBe(13);
    const out = await listLeasesPage({ userId: A.users.manager.userId }, { page: 1, pageSize: PAGE_SIZE });
    expect(out.items.length).toBe(5);
    expect(out.total).toBe(expected.length);
    expect(out.page).toBe(1);
    expect(out.pageSize).toBe(5);
    expect(out.pageCount).toBe(Math.ceil(expected.length / 5));
    expect(out.q).toBe("");
  });

  it("pages 1..pageCount contain every org A lease exactly once, in unit name / start_date / id order, and no org B lease", async () => {
    const expected = await expectedIds("l.org_id = $1", [A.orgId]);
    const seen = await allPages(A.users.manager.userId, null, PAGE_SIZE);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(expected);
    const bIds = await expectedIds("l.org_id = $1", [B.orgId]);
    expect(bIds.length).toBe(2);
    for (const id of bIds) expect(seen.includes(id), `org B lease ${id} leaked`).toBe(false);
  });

  it("items carry the same fields as listLeases (unitName, tenantName from the lease's own unit/tenant)", async () => {
    const out = await listLeasesPage({ userId: A.users.manager.userId }, { page: 1, pageSize: 50 });
    const rows = await sql<{ id: string; unit_name: string; tenant_name: string }>(
      `select l.id, u.name as unit_name, t.full_name as tenant_name from public.leases l
         join public.units u on u.id = l.unit_id join public.tenants t on t.id = l.tenant_id
        where l.org_id = $1`,
      [A.orgId],
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(out.items.length).toBe(rows.length);
    for (const item of out.items) {
      const row = byId.get(item.id);
      expect(row, `lease ${item.id} is not an org A lease`).toBeDefined();
      expect(item.unitName).toBe(row?.unit_name);
      expect(item.tenantName).toBe(row?.tenant_name);
      expect(item.monthlyRentSen).toBe(150000);
    }
  });

  it("q='P-1' (case-insensitive, trimmed) filters both items and total; org B's 'P-10' never appears", async () => {
    const expected = await expectedIds("l.org_id = $1 and (u.name ilike $2 or t.full_name ilike $2)", [A.orgId, "%P-1%"]);
    expect(expected.length).toBe(3); // P-10, P-11, P-12
    for (const q of ["P-1", "  p-1  "]) {
      const out = await listLeasesPage({ userId: A.users.manager.userId }, { q, page: 1, pageSize: PAGE_SIZE });
      expect(out.total).toBe(3);
      expect(out.pageCount).toBe(1);
      expect(out.q).toBe(q.trim());
      expect(out.items.map((i) => i.id)).toEqual(expected);
      expect(out.items.map((i) => i.unitName)).toEqual(["P-10", "P-11", "P-12"]);
    }
    const paged = await allPages(A.users.manager.userId, "P-1", 2);
    expect(paged).toEqual(expected);
  });

  it("empty / whitespace q = no filter", async () => {
    for (const q of ["", "   ", null, undefined]) {
      const out = await listLeasesPage({ userId: A.users.manager.userId }, { q, page: 1, pageSize: PAGE_SIZE });
      expect(out.total).toBe(13);
    }
  });

  it("invalid page ('abc', '0', '-1', '1.5', '', 0, -3, 1.5, null) -> page 1", async () => {
    const first = (await expectedIds("l.org_id = $1", [A.orgId])).slice(0, 5);
    for (const page of ["abc", "0", "-1", "1.5", "", 0, -3, 1.5, null]) {
      const out = await listLeasesPage({ userId: A.users.manager.userId }, { page, pageSize: PAGE_SIZE });
      expect(out.page, `page=${String(page)}`).toBe(1);
      expect(out.items.map((i) => i.id)).toEqual(first);
    }
  });

  it("page beyond the last page (999) -> the last page; a filter with no match -> page 1, total 0", async () => {
    const expected = await expectedIds("l.org_id = $1", [A.orgId]);
    const lastPage = Math.ceil(expected.length / PAGE_SIZE);
    const out = await listLeasesPage({ userId: A.users.manager.userId }, { page: "999", pageSize: PAGE_SIZE });
    expect(out.page).toBe(lastPage);
    expect(out.items.map((i) => i.id)).toEqual(expected.slice((lastPage - 1) * PAGE_SIZE));
    const none = await listLeasesPage({ userId: A.users.manager.userId }, { q: "zz-no-such-lease", page: "3" });
    expect(none).toMatchObject({ total: 0, page: 1, pageCount: 1, items: [] });
  });

  it("pageSize '0', '51', 'x', '2.5', -1 and missing -> 10; '50' is accepted", async () => {
    for (const pageSize of ["0", "51", "x", "2.5", -1, undefined]) {
      const out = await listLeasesPage({ userId: A.users.manager.userId }, { page: 1, pageSize });
      expect(out.pageSize, `pageSize=${String(pageSize)}`).toBe(10);
      expect(out.items.length).toBe(10);
      expect(out.pageCount).toBe(2);
    }
    const big = await listLeasesPage({ userId: A.users.manager.userId }, { page: 1, pageSize: "50" });
    expect(big.pageSize).toBe(50);
    expect(big.items.length).toBe(13);
  });

  it("staff A sees exactly what manager A sees", async () => {
    const manager = await allPages(A.users.manager.userId, null, PAGE_SIZE);
    const staff = await allPages(A.users.staff.userId, null, PAGE_SIZE);
    expect(staff).toEqual(manager);
  });

  it("tenant A sees only their own leases (items and total); never tenant B's or org B's", async () => {
    const expected = await expectedIds("l.tenant_id = $1", [A.tenantAId]);
    expect(expected.length).toBe(6);
    const out = await listLeasesPage({ userId: A.users.tenantA.userId }, { page: 1, pageSize: PAGE_SIZE });
    expect(out.total).toBe(6);
    expect(out.pageCount).toBe(2);
    const seen = await allPages(A.users.tenantA.userId, null, PAGE_SIZE);
    expect(seen).toEqual(expected);
    const tb = await listLeasesPage({ userId: A.users.tenantB.userId }, { page: 1, pageSize: 50 });
    expect(tb.total).toBe(7);
    for (const id of tb.items.map((i) => i.id)) expect(expected.includes(id)).toBe(false);
  });

  it("manager of B sees only org B's leases", async () => {
    const expected = await expectedIds("l.org_id = $1", [B.orgId]);
    const seen = await allPages(B.users.manager.userId, null, PAGE_SIZE);
    expect(seen).toEqual(expected);
  });

  it("a user with no membership and no tenant row -> 403; an unknown user id -> 403", async () => {
    await expectStatus(listLeasesPage({ userId: outsiderId }, { page: 1 }), 403);
    await expectStatus(listLeasesPage({ userId: randomUUID() }, {}), 403);
  });
});
