import { afterAll, describe, expect, it } from "vitest";
import { closePool, sql } from "../helpers/db";

// Catalog invariants, read as `postgres` from pg_catalog / information_schema. These pin the
// R42/R43/R44/R47 guarantees at the DB level, independent of any client: if a later migration
// adds a table without RLS, grants anon something, or exposes a function, one of these fails.

const TABLES = [
  "audit_log",
  "gateway_bills",
  "invoices",
  "leases",
  "memberships",
  "organizations",
  "payment_allocations",
  "payments",
  "tenants",
  "units",
];

const MONEY_FUNCTIONS = [
  "allocate_payment",
  "apply_gateway_callback",
  "approve_payment",
  "create_gateway_bill",
  "lock_payment_for_manager",
  "record_payment",
  "reject_payment",
  "void_payment",
];

// The only functions RLS (and Storage's RLS) needs to call as `authenticated` (SPEC Integration contracts).
const RLS_HELPERS = ["can_upload_slip", "is_lease_tenant", "is_org_member", "is_tenant_org"];

// Extension member functions (none expected in public today) are not "functions we create".
const OWN_FUNCTIONS = `
  select p.oid, n.nspname as schema, p.proname as name, p.prosecdef as secdef, p.proconfig as config
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = any($1::text[])
     and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')`;

afterAll(closePool);

describe("R42 R47 catalog: RLS enabled on every public table", () => {
  it("public holds exactly the 10 contract tables and nothing else (no views, no matviews, no foreign tables)", async () => {
    const rows = await sql<{ relname: string; relkind: string }>(
      `select c.relname, c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r','p','v','m','f') order by 1`,
    );
    expect(rows.map((r) => `${r.relname}:${r.relkind}`)).toEqual(TABLES.map((t) => `${t}:r`));
  });

  it("every public table has relrowsecurity = true", async () => {
    const rows = await sql<{ relname: string; rls: boolean }>(
      `select c.relname, c.relrowsecurity as rls from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r','p') order by 1`,
    );
    expect(rows.filter((r) => !r.rls).map((r) => r.relname)).toEqual([]);
    expect(rows.length).toBe(TABLES.length);
  });

  it("every public view (if any) is security_invoker", async () => {
    const rows = await sql<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'v'
          and not coalesce(c.reloptions @> array['security_invoker=true'] or c.reloptions @> array['security_invoker=on'], false)`,
    );
    expect(rows).toEqual([]);
    const mat = await sql(`select 1 from pg_matviews where schemaname = 'public'`);
    expect(mat).toEqual([]); // a matview cannot be security_invoker and has no RLS
  });
});

describe("R42 catalog: anon has zero privileges", () => {
  it("no table / column grants to anon in information_schema", async () => {
    const t = await sql(
      `select table_name, privilege_type from information_schema.role_table_grants
        where grantee = 'anon' and table_schema in ('public','private')`,
    );
    expect(t).toEqual([]);
    const c = await sql(
      `select table_name, column_name, privilege_type from information_schema.column_privileges
        where grantee = 'anon' and table_schema in ('public','private')`,
    );
    expect(c).toEqual([]);
  });

  it("has_table_privilege / has_any_column_privilege are false for anon on every public relation (incl. via PUBLIC)", async () => {
    const rows = await sql<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r','p','v','m','f')
          and (has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
               or has_any_column_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,REFERENCES'))`,
    );
    expect(rows).toEqual([]);
  });

  it("no sequence in public is usable by anon or authenticated", async () => {
    const rows = await sql<{ relname: string; role: string }>(
      `select c.relname, r.role from pg_class c join pg_namespace n on n.oid = c.relnamespace
        cross join (values ('anon'), ('authenticated')) r(role)
        where n.nspname = 'public' and c.relkind = 'S'
          and has_sequence_privilege(r.role, c.oid, 'USAGE,SELECT,UPDATE')`,
    );
    expect(rows).toEqual([]);
  });

  it("anon can execute no function in public or private and has no USAGE on private", async () => {
    const rows = await sql<{ schema: string; name: string }>(
      `${OWN_FUNCTIONS} and has_function_privilege('anon', p.oid, 'EXECUTE')`,
      [["public", "private"]],
    );
    expect(rows.map((r) => `${r.schema}.${r.name}`)).toEqual([]);
    const [u] = await sql<{ ok: boolean }>(`select has_schema_privilege('anon', 'private', 'USAGE') as ok`);
    expect(u.ok).toBe(false);
  });

  // Scoped to the migration role (postgres): Supabase's own supabase_admin default ACL in public
  // still grants anon everything, and postgres cannot change it. That is why the next test pins
  // every public/private object to owner postgres, so nothing is created under supabase_admin.
  it("default privileges of the migration role (postgres) in public/private grant nothing to anon/authenticated", async () => {
    const rows = await sql<{ schema: string; objtype: string; acl: string; grantee: string }>(
      `select n.nspname as schema, d.defaclobjtype as objtype, a.privilege_type as acl, a.grantee::regrole::text as grantee
         from pg_default_acl d
         join pg_namespace n on n.oid = d.defaclnamespace
         cross join lateral aclexplode(d.defaclacl) a
        where n.nspname in ('public','private') and d.defaclrole = 'postgres'::regrole
          and a.grantee in ('anon'::regrole, 'authenticated'::regrole, 0::oid)`,
    );
    expect(rows).toEqual([]);
  });

  it("every relation and function in public/private is owned by postgres (never supabase_admin, whose defaults grant anon)", async () => {
    const rels = await sql<{ name: string; owner: string }>(
      `select c.relname as name, c.relowner::regrole::text as owner from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname in ('public','private') and c.relowner <> 'postgres'::regrole`,
    );
    expect(rels).toEqual([]);
    const fns = await sql<{ name: string; owner: string }>(
      `select p.proname as name, p.proowner::regrole::text as owner from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('public','private') and p.proowner <> 'postgres'::regrole`,
    );
    expect(fns).toEqual([]);
  });
});

describe("R42 catalog: authenticated has only SELECT on the matrix tables + UPDATE(phone) on tenants", () => {
  it("table-level grants to authenticated are exactly SELECT on the 10 tables", async () => {
    const rows = await sql<{ table_name: string; privilege_type: string }>(
      `select table_name, privilege_type from information_schema.role_table_grants
        where grantee = 'authenticated' and table_schema = 'public' order by 1, 2`,
    );
    expect(rows.map((r) => `${r.table_name}:${r.privilege_type}`)).toEqual(TABLES.map((t) => `${t}:SELECT`));
  });

  it("no INSERT/DELETE/TRUNCATE/TRIGGER/REFERENCES on any public table for authenticated", async () => {
    const rows = await sql<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r','p')
          and (has_table_privilege('authenticated', c.oid, 'INSERT,DELETE,TRUNCATE,TRIGGER,REFERENCES')
               or has_any_column_privilege('authenticated', c.oid, 'INSERT,REFERENCES'))`,
    );
    expect(rows).toEqual([]);
  });

  it("UPDATE is granted on exactly one column: tenants.phone", async () => {
    const rows = await sql<{ rel: string; col: string }>(
      `select c.relname as rel, a.attname as col
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
         join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
        where n.nspname = 'public' and c.relkind in ('r','p')
          and has_column_privilege('authenticated', c.oid, a.attnum, 'UPDATE')
        order by 1, 2`,
    );
    expect(rows.map((r) => `${r.rel}.${r.col}`)).toEqual(["tenants.phone"]);
  });

  it("authenticated can execute exactly the four RLS helpers, nothing else in public/private", async () => {
    const rows = await sql<{ schema: string; name: string }>(
      `${OWN_FUNCTIONS} and has_function_privilege('authenticated', p.oid, 'EXECUTE') order by 3`,
      [["public", "private"]],
    );
    expect(rows.map((r) => `${r.schema}.${r.name}`)).toEqual(RLS_HELPERS.map((f) => `private.${f}`));
  });
});

// D51: the app never writes through service_role (all writes are Prisma as postgres -> private functions),
// so a leaked secret key must not be able to write money/tenancy rows through the Data API either.
describe("R42 catalog: service_role is read-only on public tables (D51)", () => {
  it("service_role has no INSERT/UPDATE/DELETE/TRUNCATE on any public table (table or column level)", async () => {
    const rows = await sql<{ relname: string; priv: string }>(
      `select c.relname, p.priv from pg_class c join pg_namespace n on n.oid = c.relnamespace
        cross join (values ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) p(priv)
        where n.nspname = 'public' and c.relkind in ('r','p')
          and has_table_privilege('service_role', c.oid, p.priv)
        order by 1, 2`,
    );
    expect(rows.map((r) => `${r.relname}:${r.priv}`)).toEqual([]);
    const cols = await sql<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r','p')
          and has_any_column_privilege('service_role', c.oid, 'INSERT,UPDATE')`,
    );
    expect(cols.map((r) => r.relname)).toEqual([]);
  });

  it("service_role still has SELECT on every public table", async () => {
    const rows = await sql<{ relname: string; ok: boolean }>(
      `select c.relname, has_table_privilege('service_role', c.oid, 'SELECT') as ok
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r','p') order by 1`,
    );
    expect(rows.map((r) => `${r.relname}:${r.ok}`)).toEqual(TABLES.map((t) => `${t}:true`));
  });
});

describe("R42 catalog: policies", () => {
  it("no INSERT/DELETE/ALL policies; the only UPDATE policy is the tenants own-row phone policy", async () => {
    const rows = await sql<{ tablename: string; policyname: string; cmd: string }>(
      `select tablename, policyname, cmd from pg_policies where schemaname = 'public' and cmd <> 'SELECT' order by 1`,
    );
    expect(rows).toEqual([{ tablename: "tenants", policyname: "tenants_update_own_phone", cmd: "UPDATE" }]);
  });

  it("every UPDATE/ALL policy (public and storage) has WITH CHECK", async () => {
    const rows = await sql<{ policyname: string }>(
      `select policyname from pg_policies
        where schemaname in ('public','storage') and cmd in ('UPDATE','ALL') and with_check is null`,
    );
    expect(rows).toEqual([]);
  });

  it("every public policy targets only the authenticated role (never public/anon)", async () => {
    const rows = await sql<{ policyname: string; roles: string[] }>(
      `select policyname, roles::text[] as roles from pg_policies where schemaname = 'public' and roles <> array['authenticated']::name[]`,
    );
    expect(rows).toEqual([]);
  });

  it("every matrix table has a SELECT policy (RLS on without a policy would hide the tenant portal)", async () => {
    const rows = await sql<{ tablename: string }>(
      `select distinct tablename from pg_policies where schemaname = 'public' and cmd = 'SELECT' order by 1`,
    );
    expect(rows.map((r) => r.tablename)).toEqual(TABLES);
  });
});

describe("R42 R47 catalog: functions", () => {
  it("no function at all in schema public (so /rest/v1/rpc exposes nothing)", async () => {
    const rows = await sql<{ name: string }>(OWN_FUNCTIONS, [["public"]]);
    expect(rows.map((r) => r.name)).toEqual([]);
  });

  it("no SECURITY DEFINER function in public", async () => {
    const rows = await sql<{ name: string }>(`${OWN_FUNCTIONS} and p.prosecdef`, [["public"]]);
    expect(rows).toEqual([]);
  });

  it("every SECURITY DEFINER function in public/private sets search_path = ''", async () => {
    const rows = await sql<{ schema: string; name: string; config: string[] | null }>(
      `${OWN_FUNCTIONS} and p.prosecdef`,
      [["public", "private"]],
    );
    expect(rows.length).toBeGreaterThan(0);
    const bad = rows.filter((r) => !(r.config ?? []).some((c) => c === 'search_path=""' || c === "search_path="));
    expect(bad.map((r) => `${r.schema}.${r.name}`)).toEqual([]);
  });

  it("the only SECURITY DEFINER functions are the four RLS helpers", async () => {
    const rows = await sql<{ name: string }>(`${OWN_FUNCTIONS} and p.prosecdef order by 3`, [["public", "private"]]);
    expect(rows.map((r) => r.name)).toEqual(RLS_HELPERS);
  });

  it("every function in private pins search_path (definer or not)", async () => {
    const rows = await sql<{ name: string; config: string[] | null }>(OWN_FUNCTIONS, [["private"]]);
    const bad = rows.filter((r) => !(r.config ?? []).some((c) => c.startsWith("search_path=")));
    expect(bad.map((r) => r.name)).toEqual([]);
  });

  it("every money function exists in private and is executable by none of PUBLIC, anon, authenticated", async () => {
    const rows = await sql<{ name: string; anon: boolean; auth: boolean; pub: boolean }>(
      `select p.proname as name,
              has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth,
              exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0) as pub
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'private' and p.proname = any($1::text[]) order by 1`,
      [MONEY_FUNCTIONS],
    );
    expect(rows.map((r) => r.name)).toEqual(MONEY_FUNCTIONS);
    expect(rows.filter((r) => r.anon || r.auth || r.pub)).toEqual([]);
  });

  it("no function in private is executable by PUBLIC", async () => {
    const rows = await sql<{ name: string }>(
      `${OWN_FUNCTIONS} and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0)`,
      [["private"]],
    );
    expect(rows.map((r) => r.name)).toEqual([]);
  });

  it("schema private is not exposed by PostgREST config (pgrst.db_schemas, if set, excludes it)", async () => {
    const rows = await sql<{ cfg: string }>(
      `select unnest(setconfig) as cfg from pg_db_role_setting where setconfig::text like '%pgrst.db_schemas%'`,
    );
    for (const r of rows) expect(r.cfg).not.toMatch(/private/);
  });
});

describe("R43 catalog: audit_log append-only triggers fire ALWAYS", () => {
  it("UPDATE/DELETE row trigger and TRUNCATE statement trigger exist and are enabled ALWAYS", async () => {
    const rows = await sql<{ tgname: string; tgenabled: string }>(
      `select tgname, tgenabled from pg_trigger where tgrelid = 'public.audit_log'::regclass and not tgisinternal order by 1`,
    );
    expect(rows).toEqual([
      { tgname: "audit_log_no_truncate", tgenabled: "A" },
      { tgname: "audit_log_no_update_delete", tgenabled: "A" },
    ]);
  });

  it("payments guard triggers (no delete, restricted update, no truncate) are enabled ALWAYS", async () => {
    const rows = await sql<{ tgname: string; tgenabled: string }>(
      `select tgname, tgenabled from pg_trigger where tgrelid = 'public.payments'::regclass and not tgisinternal order by 1`,
    );
    expect(rows).toEqual([
      { tgname: "payments_guard_row", tgenabled: "A" },
      { tgname: "payments_guard_truncate", tgenabled: "A" },
    ]);
  });
});

describe("R44 catalog: payment-slips bucket and storage policies", () => {
  it("bucket payment-slips is private, 5 MiB, jpeg/png/pdf only", async () => {
    const rows = await sql<{ public: boolean; file_size_limit: number; allowed_mime_types: string[] }>(
      `select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'payment-slips'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].public).toBe(false);
    expect(Number(rows[0].file_size_limit)).toBe(5242880);
    expect([...rows[0].allowed_mime_types].sort()).toEqual(["application/pdf", "image/jpeg", "image/png"]);
  });

  it("no bucket at all is public", async () => {
    const rows = await sql<{ id: string }>(`select id from storage.buckets where public`);
    expect(rows).toEqual([]);
  });

  // D74 (supersedes D50): staff/manager of the slip's org may read with their own token (short-lived
  // signed URLs); both policies share the same scope helper, and there is still no UPDATE/DELETE/ALL.
  it("storage.objects has exactly two policies: INSERT and SELECT to authenticated, both via can_upload_slip (D74)", async () => {
    const rows = await sql<{ policyname: string; cmd: string; roles: string[]; qual: string | null; with_check: string | null }>(
      `select policyname, cmd, roles::text[] as roles, qual, with_check from pg_policies
        where schemaname = 'storage' and tablename = 'objects' order by cmd`,
    );
    expect(rows.map((r) => r.cmd)).toEqual(["INSERT", "SELECT"]);
    for (const r of rows) expect(r.roles).toEqual(["authenticated"]);
    const ins = rows.find((r) => r.cmd === "INSERT")!;
    expect(ins.with_check).toMatch(/payment-slips/);
    expect(ins.with_check).toMatch(/can_upload_slip/);
    const sel = rows.find((r) => r.cmd === "SELECT")!;
    expect(sel.qual).toMatch(/payment-slips/);
    expect(sel.qual).toMatch(/can_upload_slip\(name\)/);
  });

  it("no UPDATE, DELETE or ALL policy on storage.objects (slips are immutable to clients) (D74)", async () => {
    const rows = await sql<{ policyname: string; cmd: string }>(
      `select policyname, cmd from pg_policies
        where schemaname = 'storage' and tablename = 'objects' and cmd in ('UPDATE','DELETE','ALL')`,
    );
    expect(rows).toEqual([]);
  });

  it("no policy on storage.buckets lets a client create or change buckets", async () => {
    const rows = await sql(`select policyname from pg_policies where schemaname = 'storage' and tablename = 'buckets'`);
    expect(rows).toEqual([]);
  });
});
