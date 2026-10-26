import { randomUUID } from "node:crypto";
import { generateSchedule, type ScheduledInvoice } from "@/lib/billing";
import { adminClient } from "./clients";
import { pool } from "./db";
import { env } from "./env";
import { signIn, type Session } from "./seeded";

// Fixture orgs are never deleted (D29: audit_log and payments are append-only by design); every
// fixture uses random names/emails so tests never collide and never touch the seeded data.
// Rows are written with pg as `postgres` (bypasses RLS) against the T1 schema names in SPEC.md.

export type FixtureRole = "manager" | "staff" | "tenantA" | "tenantB";

export interface LeaseInput {
  startDate: string;
  endDate: string;
  monthlyRentSen: number;
  depositSen: number;
}

export interface FixtureInvoice extends ScheduledInvoice {
  id: string;
}

export interface FixtureLease extends LeaseInput {
  id: string;
  orgId: string;
  unitId: string;
  tenantId: string;
  /** Exactly generateSchedule(lease), in its order, with the inserted ids. */
  invoices: FixtureInvoice[];
}

export interface FixtureOrg {
  orgId: string;
  orgName: string;
  /** Unit ids, in creation order (default 2 units). */
  unitIds: string[];
  /** tenants.id rows linked (tenants.user_id) to users.tenantA / users.tenantB. */
  tenantAId: string;
  tenantBId: string;
  users: Record<FixtureRole, Session>;
  /** Shorthand for users[role].accessToken. */
  tokens: Record<FixtureRole, string>;
  /** Present when opts.lease was given: a lease on unitIds[0] for tenant A (or opts.leaseTenant). */
  lease?: FixtureLease;
}

export interface FixtureOpts {
  name?: string;
  units?: number;
  lease?: LeaseInput;
  leaseTenant?: "A" | "B";
}

const rand = () => randomUUID().slice(0, 8);

/** Creates a confirmed auth user with SEED_PASSWORD via the Admin API and signs it in for real. */
export async function createFixtureUser(label: string): Promise<Session> {
  const email = `${label}-${rand()}@fixture.test`.toLowerCase();
  const { error } = await adminClient().auth.admin.createUser({
    email,
    password: env.seedPassword,
    email_confirm: true,
  });
  if (error) throw new Error(`createUser(${email}) failed: ${error.message}`);
  return signIn(email, env.seedPassword);
}

/**
 * Inserts a lease and exactly generateSchedule(lease) as its invoices, in one transaction,
 * directly with pg (no audit row; this is setup, not the createLease code path under test).
 */
export async function insertLease(
  orgId: string,
  unitId: string,
  tenantId: string,
  lease: LeaseInput,
  createdBy: string | null = null,
): Promise<FixtureLease> {
  const schedule = generateSchedule(lease);
  const client = await pool().connect();
  try {
    await client.query("begin");
    const { rows } = await client.query<{ id: string }>(
      `insert into public.leases (org_id, unit_id, tenant_id, start_date, end_date, monthly_rent_sen, deposit_sen, created_by)
       values ($1, $2, $3, $4::date, $5::date, $6, $7, $8) returning id`,
      [orgId, unitId, tenantId, lease.startDate, lease.endDate, lease.monthlyRentSen, lease.depositSen, createdBy],
    );
    const leaseId = rows[0].id;
    const invoices: FixtureInvoice[] = [];
    for (const inv of schedule) {
      const r = await client.query<{ id: string }>(
        `insert into public.invoices (org_id, lease_id, kind, period_index, period_start, period_end, due_date, amount_sen)
         values ($1, $2, $3, $4, $5::date, $6::date, $7::date, $8) returning id`,
        [orgId, leaseId, inv.kind, inv.periodIndex, inv.periodStart, inv.periodEnd, inv.dueDate, inv.amountSen],
      );
      invoices.push({ ...inv, id: r.rows[0].id });
    }
    await client.query("commit");
    return { id: leaseId, orgId, unitId, tenantId, ...lease, invoices };
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/** Adds one more unit to an org (random name unless given). */
export async function insertUnit(orgId: string, name = `U-${rand()}`): Promise<string> {
  const { rows } = await pool().query<{ id: string }>(
    "insert into public.units (org_id, name) values ($1, $2) returning id",
    [orgId, name],
  );
  return rows[0].id;
}

/** Adds a tenant row (optionally linked to an auth user) to an org. */
export async function insertTenant(orgId: string, userId: string | null, fullName: string, email: string): Promise<string> {
  const { rows } = await pool().query<{ id: string }>(
    "insert into public.tenants (org_id, user_id, full_name, email) values ($1, $2, $3, $4) returning id",
    [orgId, userId, fullName, email],
  );
  return rows[0].id;
}

/**
 * A fresh, isolated organization: manager + staff (memberships), units, two tenants linked to
 * their own auth users, optionally a lease (unit 0, tenant A by default) with its invoices.
 * Every user is real (Admin API) and signed in with the password grant.
 */
export async function createFixtureOrg(opts: FixtureOpts = {}): Promise<FixtureOrg> {
  const tag = rand();
  const orgName = opts.name ?? `Fixture Org ${tag}`;
  const [manager, staff, tenantA, tenantB] = await Promise.all([
    createFixtureUser(`manager-${tag}`),
    createFixtureUser(`staff-${tag}`),
    createFixtureUser(`tenanta-${tag}`),
    createFixtureUser(`tenantb-${tag}`),
  ]);

  const { rows: orgRows } = await pool().query<{ id: string }>(
    "insert into public.organizations (name) values ($1) returning id",
    [orgName],
  );
  const orgId = orgRows[0].id;
  await pool().query(
    "insert into public.memberships (user_id, org_id, role) values ($1, $3, 'manager'), ($2, $3, 'staff')",
    [manager.userId, staff.userId, orgId],
  );
  const unitIds: string[] = [];
  for (let i = 0; i < (opts.units ?? 2); i++) unitIds.push(await insertUnit(orgId, `U${i + 1}-${tag}`));
  const tenantAId = await insertTenant(orgId, tenantA.userId, `Tenant A ${tag}`, tenantA.email);
  const tenantBId = await insertTenant(orgId, tenantB.userId, `Tenant B ${tag}`, tenantB.email);

  const users = { manager, staff, tenantA, tenantB };
  const fx: FixtureOrg = {
    orgId,
    orgName,
    unitIds,
    tenantAId,
    tenantBId,
    users,
    tokens: {
      manager: manager.accessToken,
      staff: staff.accessToken,
      tenantA: tenantA.accessToken,
      tenantB: tenantB.accessToken,
    },
  };
  if (opts.lease) {
    if (unitIds.length === 0) throw new Error("createFixtureOrg: a lease needs at least one unit");
    const tenantId = opts.leaseTenant === "B" ? tenantBId : tenantAId;
    fx.lease = await insertLease(orgId, unitIds[0], tenantId, opts.lease, manager.userId);
  }
  return fx;
}
