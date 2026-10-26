import { afterAll, describe, expect, it } from "vitest";
import { closePool, sql } from "../helpers/db";

// R48 R47: the brief's required tables/columns (SPEC Contracts) exist with the right types: money is
// bigint sen, calendar dates are `date`, instants `timestamptz`; the enum-like text columns accept
// exactly the SPEC values (read from the CHECK constraint definitions).

const REQUIRED: Record<string, Record<string, string>> = {
  organizations: { id: "uuid", name: "text" },
  memberships: { user_id: "uuid", org_id: "uuid", role: "text" },
  units: { id: "uuid", org_id: "uuid", name: "text" },
  tenants: { id: "uuid", org_id: "uuid", user_id: "uuid", full_name: "text", email: "text", phone: "text" },
  leases: {
    id: "uuid",
    org_id: "uuid",
    unit_id: "uuid",
    tenant_id: "uuid",
    start_date: "date",
    end_date: "date",
    monthly_rent_sen: "bigint",
    deposit_sen: "bigint",
  },
  invoices: {
    id: "uuid",
    org_id: "uuid",
    lease_id: "uuid",
    kind: "text",
    period_index: "integer",
    period_start: "date",
    period_end: "date",
    due_date: "date",
    amount_sen: "bigint",
  },
  payments: {
    id: "uuid",
    org_id: "uuid",
    lease_id: "uuid",
    amount_sen: "bigint",
    unapplied_sen: "bigint",
    method: "text",
    status: "text",
    received_at: "timestamp with time zone",
    slip_path: "text",
    gateway_bill_id: "uuid",
  },
  payment_allocations: { id: "uuid", org_id: "uuid", payment_id: "uuid", invoice_id: "uuid", amount_sen: "bigint" },
  gateway_bills: { id: "uuid", org_id: "uuid", lease_id: "uuid", amount_sen: "bigint", status: "text" },
  audit_log: {
    org_id: "uuid",
    actor_id: "uuid",
    action: "text",
    entity_id: "uuid",
    details: "jsonb",
    created_at: "timestamp with time zone",
  },
};

afterAll(async () => {
  await closePool();
});

describe("R48 R47 schema: required tables and columns with the contract types", () => {
  it.each(Object.entries(REQUIRED))("public.%s has the required columns and types", async (table, cols) => {
    const rows = await sql<{ column_name: string; data_type: string }>(
      "select column_name, data_type from information_schema.columns where table_schema = 'public' and table_name = $1",
      [table],
    );
    const actual = Object.fromEntries(rows.map((r) => [r.column_name, r.data_type]));
    for (const [col, type] of Object.entries(cols)) expect(actual[col], `${table}.${col}`).toBe(type);
  });

  it("no money column anywhere in public is a float, numeric or integer: every *_sen column is bigint", async () => {
    const rows = await sql<{ t: string; c: string; data_type: string }>(
      `select table_name as t, column_name as c, data_type from information_schema.columns
        where table_schema = 'public' and column_name like '%\\_sen' escape '\\'`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.data_type, `${r.t}.${r.c}`).toBe("bigint");
  });

  it("audit_log.id is an identity / generated key (append-only log)", async () => {
    const [row] = await sql<{ is_identity: string }>(
      "select is_identity from information_schema.columns where table_schema = 'public' and table_name = 'audit_log' and column_name = 'id'",
    );
    expect(row.is_identity).toBe("YES");
  });
});

// Every value SPEC lists appears in the column CHECK, and the CHECK lists no other value.
const ENUMS: Array<{ table: string; column: string; values: string[] }> = [
  { table: "payments", column: "status", values: ["pending_verification", "approved", "rejected", "voided"] },
  { table: "payments", column: "method", values: ["cash", "bank_transfer", "online"] },
  { table: "gateway_bills", column: "status", values: ["pending", "paid", "failed"] },
  { table: "memberships", column: "role", values: ["manager", "staff"] },
  { table: "invoices", column: "kind", values: ["deposit", "rent"] },
];

describe("R48 schema: status / method / role / kind values are exactly SPEC's", () => {
  it.each(ENUMS)("$table.$column CHECK allows exactly the SPEC values", async ({ table, column, values }) => {
    const defs = await sql<{ def: string }>(
      `select pg_get_constraintdef(c.oid) as def from pg_constraint c
        where c.conrelid = ('public.' || $1)::regclass and c.contype = 'c'`,
      [table],
    );
    // The column's own list constraint: CHECK ((col = ANY (ARRAY['a'::text, ...]))).
    const inList = defs.map((d) => d.def).find((d) => d.startsWith(`CHECK ((${column} = ANY (ARRAY[`));
    expect(inList, `${table}.${column} has an IN-list CHECK`).toBeDefined();
    const literals = [...inList!.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]);
    expect([...literals].sort()).toEqual([...values].sort());
  });
});
