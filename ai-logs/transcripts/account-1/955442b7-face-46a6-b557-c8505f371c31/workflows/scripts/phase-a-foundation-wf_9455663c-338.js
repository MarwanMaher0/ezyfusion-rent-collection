export const meta = {
  name: 'phase-a-foundation',
  description: 'T1-T6: schema+RLS, money functions, lib/billing, test harness, services+routes+seed, RLS tests, UI shell; per-item review',
  phases: [
    { title: 'Implement', detail: 'db-engineer, backend-engineer, test-engineer, test-authz, ui-builder lanes' },
    { title: 'Verify', detail: 'reviewer per item, skeptic on money functions' },
  ],
}

const COMMON = `You are a lane in a timed build (lead = the main session). Working directory: ./app (the Next.js repo). Kit files are in the parent folder: ../BRIEF.md (the assessment brief, source of truth), ../SPEC.md (Contracts, Error contract, Domain rules, and "Integration contracts" = the exact names every lane codes against), ../DECISIONS.md (D-ids to cite in comments), ../REFERENCE.md (verified snippets).
OVERRIDES — the brief wins over CLAUDE.md and your agent file wherever SPEC.md says so. In particular: error body is { "error": "message" } (a string); NO required idempotency key (optional Idempotency-Key header only, D9); NO webhook_events table and NO 5-minute replay window (D10); money columns are bigint sen, number in TS (D3); invoice status is never stored, computed with invoiceStatus from src/lib/billing.ts (R27); payments are updated in place for status only (trigger restricts, D12); seed is npm run seed through the services, supabase/seed.sql does not exist and [db.seed] is disabled (D20); env file is .env.local with names NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY, DATABASE_URL, DIRECT_URL, GATEWAY_X_SIGNATURE_KEY, SEED_PASSWORD, TEST_BASE_URL (D21); business timezone is fixed Asia/Kuala_Lumpur (no properties table); no late fee; overdue grace 0.
Rules: edit ONLY the files listed for your task; one simple command per Bash call (no VAR=x; chains, no cd chains, no heredocs); never npm i (list packages in your report); never commit; DB-touching commands go through bash ../scripts/with-db.sh <cmd>. Local stack: Supabase API http://127.0.0.1:54321, DB postgresql://postgres:postgres@127.0.0.1:54322/postgres (psql is installed), Next dev server already running at http://127.0.0.1:3000 (do not start or kill it). Seed password RentDemo#2026. Put every choice SPEC.md does not fix under assumptions in your structured output.`

const IMPL_SCHEMA = {
  type: 'object',
  properties: {
    task: { type: 'string' },
    status: { type: 'string', enum: ['done', 'partial', 'blocked'] },
    files_changed: { type: 'array', items: { type: 'string' } },
    tests_added: { type: 'array', items: { type: 'string' } },
    checks_run: { type: 'array', items: { type: 'string' }, description: 'each command you ran to prove done, with its last result line' },
    assumptions: { type: 'array', items: { type: 'string' } },
    contract_gaps: { type: 'array', items: { type: 'string' }, description: 'anything in SPEC Integration contracts you could not follow or changed, with the exact new name/signature' },
    packages_needed: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
  required: ['task', 'status', 'files_changed', 'checks_run', 'assumptions', 'contract_gaps'],
}
const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'FAIL'] },
    findings: { type: 'array', items: { type: 'object', properties: {
      severity: { type: 'string', enum: ['blocker', 'major', 'minor'] }, file: { type: 'string' }, line: { type: 'string' },
      problem: { type: 'string' }, scenario: { type: 'string' }, fix: { type: 'string' } }, required: ['severity', 'file', 'problem', 'fix'] } },
    assumptions: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict', 'findings'],
}
const SKEPTIC_SCHEMA = {
  type: 'object',
  properties: {
    refuted: { type: 'boolean', description: 'true if ANY hard rule / brief rule fails' },
    findings: { type: 'array', items: { type: 'object', properties: {
      rule: { type: 'string' }, file: { type: 'string' }, line: { type: 'string' }, scenario: { type: 'string' }, fix: { type: 'string' } }, required: ['rule', 'scenario', 'fix'] } },
  },
  required: ['refuted', 'findings'],
}

const MARK_T1 = 'prisma/schema.prisma contains the line "model payments {" (db-engineer T1 runs prisma db pull as its last step)'
const MARK_T4 = 'the file supabase/migrations/20261026000002_money.sql exists AND psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -tAc "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname=\'private\' and p.proname=\'apply_gateway_callback\'" prints 1'
const waitFor = (what) => `Before the step that needs it, WAIT until ${what}: check, and if not yet true run "sleep 60" and check again (up to 30 times). Do everything that does not need it first.`

const T1 = { id: 'T1', lane: 'db-engineer', agentType: 'db-engineer', review: true, skeptic: false,
  files: 'supabase/migrations/20261026000001_schema.sql, supabase/config.toml (only if needed), prisma/schema.prisma, prisma7.config.ts (already set up; avoid changes)',
  prompt: `Task T1 (BOARD.md row T1) — R2, R37, R42, R43, R44, R46, R47, R48.
Write migration supabase/migrations/20261026000001_schema.sql implementing EXACTLY ../SPEC.md "Integration contracts > Schema (T1)" (tables, columns, checks, composite FKs, EXCLUDE leases_no_overlap with btree_gist in schema extensions, indexes on every FK and policy column, triggers in schema private, RLS helpers, RLS policies per the Data API matrix, grants, storage bucket payment-slips + storage.objects policies).
Key points:
- First: create extension btree_gist with schema extensions; create schema private; revoke all on all tables/sequences/functions in schema public from anon, authenticated; alter default privileges (for role postgres) in schema public revoke all on tables, sequences, functions from anon, authenticated; revoke execute on all functions in schema private from public; same default-privilege revoke in private. Then grant usage on schema private to authenticated and execute on ONLY the four RLS helpers to authenticated.
- RLS enabled on every public table. Policies: SELECT only (to authenticated) per matrix: organizations (member of org, or tenant in org), memberships (member of org — staff and manager; tenants none), units (member, or tenant with a lease on that unit), tenants (member of org, or own row user_id = (select auth.uid())), leases/invoices/payments/payment_allocations/gateway_bills (member of org, or private.is_lease_tenant(lease_id)), audit_log (manager of org only). Plus tenants UPDATE policy for own row with USING and WITH CHECK (user_id = (select auth.uid())), and column grant: grant update (phone) on public.tenants to authenticated. Every UPDATE policy has WITH CHECK. No INSERT/DELETE policies anywhere. Use (select auth.uid()).
- Helpers SECURITY DEFINER, language sql, stable, set search_path = '' : private.is_org_member(p_org uuid, p_roles text[]), private.is_lease_tenant(p_lease uuid), private.is_tenant_org(p_org uuid), private.can_upload_slip(p_object_name text) (true when (storage.foldername(p_object_name))[1] equals an org_id text where the caller is manager or staff; compare as text so garbage folder names do not raise).
- audit_log append-only: BEFORE UPDATE OR DELETE row trigger + BEFORE TRUNCATE statement trigger raising (errcode P0409 message 'audit_log is append-only'); this must also stop service_role and postgres (D19).
- payments guard trigger (D12): block DELETE; on UPDATE allow only changes to status, decided_by, decided_at, reason, unapplied_sen; allowed status transitions pending_verification->approved, pending_verification->rejected, approved->voided, or unchanged; anything else raises P0409.
- payment_allocations: allow DELETE (void removes allocations) but block UPDATE.
- Storage: insert bucket payment-slips (public false, file_size_limit 5242880, allowed_mime_types image/jpeg,image/png,application/pdf) with on conflict do nothing; policies on storage.objects for INSERT (with check) and SELECT (using) to authenticated: bucket_id = 'payment-slips' and private.can_upload_slip(name). No update/delete policies.
- Comments with DECISIONS ids at non-obvious points (D7, D12, D16, D17, D19, D22).
Done means: (1) bash ../scripts/db-reset.sh succeeds (show last lines; if it fails with DbSetupError right after start, rerun once); (2) npx prisma db pull then npx prisma generate succeed and prisma/schema.prisma has models organizations, memberships, units, tenants, leases, invoices, payments, payment_allocations, gateway_bills, audit_log; (3) curl probes with the publishable key (read it from .env.local with grep) as anon: GET /rest/v1/organizations?select=* returns 401/permission denied or [] — report the exact result; (4) a psql check that relrowsecurity is true for all 10 tables. Report the RLS matrix you implemented.`,
}

const T2 = { id: 'T2', lane: 'backend-engineer', agentType: 'backend-engineer', review: true, skeptic: false,
  files: 'src/lib/billing.ts, src/lib/money.ts, src/lib/dates.ts, src/lib/errors.ts, src/lib/prisma.ts, src/lib/supabase/server.ts, src/lib/supabase/browser.ts, src/lib/supabase/admin.ts, src/server/auth.ts, src/server/access.ts, src/server/http.ts, src/proxy.ts',
  prompt: `Task T2 (BOARD.md row T2) — R3, R10-R18, R36-R41, R45. Implement the modules in ../SPEC.md "Integration contracts > Server modules (T2)" with those exact names and signatures.
1. FIRST and most important: src/lib/billing.ts with EXACTLY the brief's exports (../BRIEF.md section 3, copied in SPEC Contracts): InvoiceKind, ScheduledInvoice, generateSchedule, InvoiceStatus, invoiceStatus(invoice, now), parseRinggitToSen, plus toMytDate(now), addMonthsClamped(startDate, k), roundHalfUpDiv(numerator, denominator). It must import NOTHING (D4). Calendar math only on y/m/d integers with Date.UTC (never local getters, never Date parsing of 'YYYY-MM-DD' through the local zone). Rules:
 - validation: dates must match ^\\d{4}-\\d{2}-\\d{2}$ AND be real calendar dates (2026-02-30 throws), endDate >= startDate, monthlyRentSen Number.isSafeInteger and > 0, depositSen safe integer >= 0; otherwise throw Error.
 - deposit first if depositSen > 0 (kind deposit, period fields null, dueDate = startDate).
 - anchor k = startDate + k months counted from the START date, day clamped to that month's last day (Jan 31 -> Feb 28/29, Mar 31, Apr 30). Period k = anchor k .. anchor(k+1) - 1 day; due anchor k; a period for every anchor <= endDate. Last period cut at endDate; if shorter than its full length amount = roundHalfUpDiv(monthlyRentSen * daysUsed, daysInFullPeriod), else monthlyRentSen. Days counted inclusive.
 - roundHalfUpDiv for non-negative integers: Math.floor((2*n + d) / (2*d)) with exact integer math (guard Number.isSafeInteger of intermediates, else use BigInt internally and convert back — no BigInt in the API). Worked example: 150000*16/31 -> 77419; Ben 100029*15/30 -> 50015.
 - invoiceStatus order: paid if paidSen >= amountSen; overdue if toMytDate(now) > dueDate (string compare of YYYY-MM-DD); partially_paid if paidSen > 0; else unpaid. toMytDate(now) = new Date(now.getTime() + 8*3600*1000).toISOString().slice(0,10) (D5: MYT has no DST). Due 2026-03-01 is overdue at 2026-03-01T16:00:00Z, not at 15:59:59.999Z.
 - parseRinggitToSen: trim, then ^(\\d{1,3}(,\\d{3})+|\\d+)(\\.\\d{1,2})?$ ; '1,500.50'->150050, '1.15'->115, '7'->700, '1.1'->110; throws on '', '-5', '1.234', '1e3', 'RM 10', '1,23', '1,500.', '.5'; result must be a safe integer. Pure string-to-integer math (no parseFloat, no Number() of a decimal string).
 After writing it, sanity-check with one command: npx tsx -e "import('./src/lib/billing.ts').then(m=>console.log(JSON.stringify(m.generateSchedule({startDate:'2026-01-31',endDate:'2026-07-15',monthlyRentSen:150000,depositSen:300000}))))" and confirm it equals the brief's worked table.
2. src/lib/money.ts (re-export parseRinggitToSen, roundHalfUpDiv; formatSen(sen) 'RM 1,500.00'; toSen(v: bigint|number) throws if not safe integer). src/lib/dates.ts (formatInstantMyt -> '2026-01-31T10:00:00+08:00', parseInstantWithOffset(s) accepts ISO 8601 with Z or ±HH:MM offset only, else throws; mytLocalToIso('2026-01-31T10:00') -> '2026-01-31T10:00:00+08:00'; dateToIso(d) = d.toISOString().slice(0,10); formatMytDisplay(d) using fixed timeZone 'Asia/Kuala_Lumpur' so server and browser render identically; isYearMonth(s) ^\\d{4}-(0[1-9]|1[0-2])$).
3. src/lib/errors.ts per SPEC (ApiError, helpers, toErrorResponse(e) returning a Response: ApiError -> its status; ZodError -> 400 with a short message; Postgres errors: find the SQLSTATE from Prisma errors (PrismaClientKnownRequestError meta, driver-adapter error cause, or e.code on pg errors) — P0400->400, P0404->404, P0409->409, P0422->422 using the exception message as the body; 23P01->409 'Lease overlaps another lease on this unit'; 23505->409; 22P02/P2023->400; 23503/23514->400; P2025->404; 40001/40P01->409; unknown -> 500 { error: 'Internal error' } and console.error of the error name/code only (no payloads, no SQL)). Export also a helper withRetry(fn) that retries once on 40001/40P01.
4. src/lib/prisma.ts (REFERENCE.md snippet; connectionString DATABASE_URL), supabase clients: server.ts (createServerClient with getAll/setAll, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY), browser.ts (createBrowserClient), admin.ts (import 'server-only'; createClient with SUPABASE_SECRET_KEY, persistSession false).
5. src/server/auth.ts: getUserId(req?: Request) — if Authorization: Bearer <token> present use a stateless supabase-js client .auth.getUser(token); otherwise the cookie server client .auth.getUser(); return user.id or null; never getSession; requireUserId throws ApiError 401 'Unauthorized'.
6. src/server/http.ts: route(handler) wrapper catching -> toErrorResponse; readJson(req) -> 400 on malformed JSON or non-object body.
7. src/server/access.ts: Caller type, loadCaller(userId) (membership by user_id; tenant ids from tenants.user_id), requireMember(caller, roles) -> 403, requireLeaseAccess(caller, leaseId, roles) -> lease row or 404 (malformed uuid, nonexistent, other org, other tenant's lease) / 403 (visible but role not allowed), requirePaymentAccess(caller, paymentId, roles) same via the payment's lease. Role ONLY from memberships / tenants.user_id (R37), never user_metadata. This file needs the Prisma models: ${waitFor(MARK_T1)} Then run npx prisma generate is NOT yours — db-engineer runs it; just import from @/generated/prisma/client.
8. src/proxy.ts per REFERENCE.md (publishable key env name), matcher excludes api/webhooks and static assets, never redirects.
Done means: npx tsc --noEmit and npx eslint . --max-warnings=0 are clean (show output) and the billing sanity check prints the worked example (deposit 300000, five x 150000, 77419 with the brief's dates).`,
}

const T3 = { id: 'T3', lane: 'test-engineer', agentType: 'test-engineer', review: false,
  files: 'vitest.config.mts, tests/setup/**, tests/helpers/**, tests/unit/**',
  prompt: `Task T3 (BOARD.md row T3) — R10-R18. Marwan wants billing.ts green first.
1. vitest.config.mts (REFERENCE.md skeleton, but load env with dotenv config({ path: ['.env.local', '.env'] }) since the env file is .env.local), include tests/**/*.test.ts, environment node, testTimeout 30000, hookTimeout 180000, globalSetup tests/setup/global.ts (use TEST_BASE_URL default http://127.0.0.1:3000; if nothing answers, start next dev -p 3100 and point TEST_BASE_URL there; kill in teardown). Tests must pass under TZ=UTC, Asia/Kuala_Lumpur, America/New_York.
2. tests/helpers/ (other lanes import these — keep signatures stable and document them in tests/helpers/README.md): env.ts (typed env), clients.ts (anonClient() with publishable key; userClient(accessToken) supabase-js with Authorization header; adminClient() with secret key), db.ts (pg Pool on DATABASE_URL + newConnection() for race tests), seeded.ts (SEEDED map of the 7 brief accounts -> email; signIn(email, password = process.env.SEED_PASSWORD) -> { userId, accessToken }), http.ts (api(token?) with get/post returning { status, body } using Authorization: Bearer and redirect: 'manual'; form-post helper for the webhook), fixtures.ts (createFixtureOrg(opts?) — creates via admin API fresh users with random emails @fixture.test and the seed password, and via pg as postgres: an organization, memberships manager + staff, units, two tenants linked to users, and optionally a lease with invoices computed by generateSchedule from src/lib/billing.ts inserted directly; returns ids + access tokens for manager, staff, tenantA, tenantB). Fixtures are never deleted (D29: audit_log/payments are append-only); use random names so tests never collide. Code fixtures against ../SPEC.md "Integration contracts > Schema (T1)" table/column names; ${waitFor(MARK_T1)} before running anything that touches the DB.
3. tests/unit/billing.test.ts — describe names start with the R-numbers. Cover: the brief's worked example (Aisyah) exactly, all fields; Ben (2026-01-01..2026-04-15, 100029, no deposit -> last period 50015); Probe (2026-02-28..2027-02-27: 12 periods, all full, deposit first); Chen (2026-03-15..2027-03-14); depositSen 0 -> no deposit; start == end -> one prorated 1-day period; end exactly on an anchor -> extra 1-day period; end = anchor(k+1)-1 -> full price; Jan 31 start in a leap year (2028) -> Feb 29; start 2028-02-29 anchors Mar 29, Apr 29, ..., Feb 28 2029 (no drift); clamp then back to 31; validation throws (2026-02-30, 2026-1-05, '2026-01-31T00:00', end < start, rent 0, rent 1.5, rent -1, deposit -1, deposit 1.5, NaN, Infinity); rounding .5 boundary half up (e.g. a case giving exactly x.5) and below .5; order deposit then periodIndex; invoiceStatus all four, rule order (paid beats overdue; partial overdue -> overdue; overpaid -> paid), boundary due 2026-03-01: 2026-03-01T15:59:59.999Z not overdue, 2026-03-01T16:00:00Z overdue; parseRinggitToSen accept/reject tables from the brief plus ' 1,500 ', '1.1', '0', '0.05', '1,000,000.00', reject '1,500.', '.5', '+5', '1 500', '1,5000', '12,34,567', 'NaN'. Also tests/unit/dates.test.ts for src/lib/dates.ts (formatInstantMyt, parseInstantWithOffset rejects naive, mytLocalToIso) and tests/unit/money.test.ts (formatSen, toSen). src/lib/billing.ts and dates.ts are being written in parallel by backend-engineer (T2): ${waitFor('src/lib/billing.ts and src/lib/dates.ts exist and export the contract names')}
4. Add a test proving billing.ts imports nothing (read the file, assert no import/require statements).
Done means: bash ../scripts/with-db.sh npx vitest run tests/unit passes under TZ=UTC, TZ=Asia/Kuala_Lumpur and TZ=America/New_York (run with: env TZ=Asia/Kuala_Lumpur bash ../scripts/with-db.sh npx vitest run tests/unit). If a billing test fails because of an implementation bug, DO NOT weaken the test: report the failing case (input, expected per the brief, actual) in contract_gaps.`,
}

const T4 = { id: 'T4', lane: 'db-engineer', agentType: 'db-engineer', review: true, skeptic: true,
  files: 'supabase/migrations/20261026000002_money.sql, supabase/tests/** (psql smoke scripts), prisma/schema.prisma (db pull only)',
  prompt: `Task T4 (BOARD.md row T4) — R19-R30, R34, R35. Write migration supabase/migrations/20261026000002_money.sql implementing EXACTLY ../SPEC.md "Integration contracts > Money functions (T4)": private.allocate_payment, private.record_payment, private.approve_payment, private.reject_payment, private.void_payment, private.create_gateway_bill, private.apply_gateway_callback (names, parameters, return tables, SQLSTATEs P0400/P0404/P0409/P0422, messages that never reveal another org's data).
Another db-engineer is writing migration 0001 (the schema) in parallel against the same SPEC schema contract; write your migration now from the contract, then ${waitFor(MARK_T1)} — only then run bash ../scripts/db-reset.sh (re-read 0001 first and adapt to its actual names).
Rules (cite D-ids in comments):
- D7: every function locks the lease row FOR UPDATE first (approve/reject/void: select lease_id from payments, then lock lease, then re-select the payment FOR UPDATE and re-check status). apply_gateway_callback locks the bill FOR UPDATE first, then the lease. Never lock in another order.
- R22 cap: Σ invoices.amount_sen − Σ payment_allocations.amount_sen − Σ payments.amount_sen where status = 'pending_verification', all for the lease, computed AFTER the lock. 0 < amount <= cap, else P0422 'Payment exceeds the remaining balance'.
- R23 approve re-check: amount <= Σ invoices − Σ allocations (pending ignored, D13) else P0422 and status stays pending.
- R26 allocation (allocate_payment): invoices of the lease with unpaid > 0, ordered by due_date, (kind = 'rent') [deposit first], period_index nulls first, id; fill each up to unpaid; insert payment_allocations (org_id, lease_id, payment_id, invoice_id, amount_sen); leftover -> payments.unapplied_sen.
- R24 void: delete only this payment's allocations, status voided, reason; other payments unchanged (D14).
- record_payment: status approved when the actor is a manager of the lease's org, pending_verification when staff, else P0404; bank_transfer requires p_slip_path that exists in storage.objects (bucket_id 'payment-slips') whose first folder = lease org_id::text, else P0400 'Slip file not found'; cash with a slip -> P0400; method not cash/bank_transfer -> P0400. Optional idempotency (D9): if p_idempotency_key is not null look up (org_id, idempotency_key) FIRST after the lock: same lease/amount/method/received_at/slip_path -> return it with replayed true (even if it is now approved/rejected/voided); different -> P0409 'Idempotency key reused with a different payload'. Insert with the unique constraint; on unique_violation on slip_path -> P0409 'Slip already used'.
- create_gateway_bill: actor must be the lease's tenant (tenants.user_id = p_actor_id and tenants.id = leases.tenant_id) else P0404; due = Σ greatest(amount − allocated, 0) over invoices with due_date <= (p_as_of at time zone 'Asia/Kuala_Lumpur')::date (D5); 0 -> P0422 'Nothing is due'.
- apply_gateway_callback per the SPEC state machine; paid with p_paid_amount_sen <> bill.amount_sen -> P0422 'Paid amount does not match the bill'; a bill creates at most one payment ever (unique gateway_bill_id backs it up).
- Audit rows (org_id, actor_id, action, entity_id, details jsonb) for payment.recorded, payment.approved, payment.rejected, payment.voided, gateway_bill.created, gateway_bill.paid, gateway_bill.failed; actor null for the gateway.
- Every function: language plpgsql, security invoker, set search_path = '', fully qualified names; revoke execute on function ... from public, anon, authenticated (only the owner/postgres calls them via Prisma). Return bigint amounts as bigint (the TS side converts with toSen).
Done means: db reset passes; npx prisma db pull and npx prisma generate succeed; a psql smoke script supabase/tests/money_smoke.sql run with psql -v ON_ERROR_STOP=1 -f against the local DB inside a transaction that ROLLS BACK (create org/unit/tenant/lease/invoices + a manager membership for an existing or inserted auth user) shows: manager cash payment allocated in order, staff pending then approve, cap P0422, void releases allocations, approve twice -> second P0409, bill create + callback paid twice -> one payment. Show the output lines. Also confirm via curl with the publishable key that POST /rest/v1/rpc/record_payment is not callable (private schema is not exposed).`,
}

const T6 = { id: 'T6', lane: 'test-authz', agentType: 'test-authz', review: false,
  files: 'tests/rls/**, tests/db/**, tests/storage/**',
  prompt: `Task T6 (BOARD.md row T6) — R42, R43, R44, R47, R48. Use the helpers in tests/helpers/** (read tests/helpers/README.md; createFixtureOrg gives you a fresh org with manager/staff/tenant tokens; never edit helpers — list any helper you need in contract_gaps).
Write:
- tests/rls/catalog.test.ts (pg as postgres): all 10 public tables have relrowsecurity; anon has zero privileges on public tables/sequences/functions (information_schema.role_table_grants / has_table_privilege / has_function_privilege); authenticated has only SELECT on the matrix tables plus UPDATE(phone) on tenants (column privileges); no INSERT/DELETE/UPDATE policies except the tenants own-row UPDATE; every UPDATE policy has WITH CHECK (pg_policies.with_check not null); no SECURITY DEFINER function in public; every SECURITY DEFINER function has search_path set (proconfig); no public views without security_invoker; no function in public executable by anon/authenticated; private.* money functions not executable by anon/authenticated; bucket payment-slips is not public, file_size_limit 5242880, allowed_mime_types exactly jpeg/png/pdf.
- tests/rls/data-api.test.ts (supabase-js through PostgREST, publishable key + user tokens): anon gets nothing on every table (error or empty) and cannot insert; tenant reads only own tenant row/leases/invoices/payments/allocations/bills/units/org and never another tenant's in the same org; tenant cannot read memberships or audit_log; tenant can update own phone and cannot update full_name/email/user_id/org_id or another tenant's phone; staff reads own org rows, not audit_log, not other org; manager reads own org incl. audit_log, nothing of another org; NOBODY (anon, tenant, staff, manager) can insert/update/delete any table (payments, invoices, allocations, leases, units, memberships, organizations, gateway_bills, audit_log) — assert the row is unchanged afterwards via pg; rpc: POST /rest/v1/rpc/<each private money function name> and any public function fails.
- tests/db/constraints.test.ts (pg as postgres = the Prisma role): amount_sen <= 0 rejected (23514); end_date < start_date; currency not MYR; invoice kind/period checks; duplicate (lease_id, period_index) 23505; composite FK — a lease whose unit belongs to another org (23503); overlapping leases on one unit, both inclusive (23P01), adjacent (end+1) allowed; payments DELETE raises; payments UPDATE of amount_sen raises; bad transition (rejected->approved) raises; audit_log UPDATE/DELETE/TRUNCATE raise even as postgres.
- tests/storage/slips.test.ts: staff and manager can upload a small PNG to <own_org_id>/<lease_id>/<uuid>.png; tenant, anon and another org's staff cannot upload there; another org cannot read/list/download it; tenant cannot read; anon cannot; oversize (> 5 MiB) and wrong MIME (text/plain) rejected; upload outside own org folder rejected.
The schema migration is being written by db-engineer in parallel: ${waitFor(MARK_T1)} The test helpers are written by test-engineer in parallel: ${waitFor('tests/helpers/fixtures.ts and tests/helpers/README.md exist')}
Done means: bash ../scripts/with-db.sh npx vitest run tests/rls tests/db tests/storage runs; report pass/fail counts. A failing test caused by a real hole is a FINDING, not something to weaken: list each in contract_gaps with table, role, operation, expected, actual.`,
}

const T5a = { id: 'T5a', lane: 'backend-engineer', agentType: 'backend-engineer', review: false,
  files: 'src/server/services/leases.ts, src/server/services/reports.ts, src/server/services/serialize.ts, src/app/api/leases/route.ts, src/app/api/leases/[leaseId]/route.ts, src/app/api/reports/collections/route.ts',
  prompt: `Task T5a (BOARD.md row T5, leases + reports half) — R29, R39, R45, R46, D15, D25. Using T2's modules (src/server/auth.ts, access.ts, http.ts, src/lib/*), implement:
- src/server/services/leases.ts: createLease(ctx, input) — loadCaller; requireMember(['manager']) (staff/tenant -> 403); zod .strict() body { unitId uuid, tenantId uuid, startDate, endDate, monthlyRentSen int, depositSen int } (400); unit and tenant must belong to the caller's org else 404 'Unit not found' / 'Tenant not found' (D15); schedule = generateSchedule(...) from src/lib/billing.ts (throws -> 400 with its message); ONE prisma.$transaction: insert lease (org_id = caller org, created_by), createMany invoices exactly from the schedule, insert audit_log lease.created (details: unitId, tenantId, dates, rent, deposit, invoiceCount); 23P01 -> 409 'Lease overlaps another lease on this unit'. Returns { id }.
  getLease(ctx, leaseId, asOf = new Date()) — requireLeaseAccess(['manager','staff','tenant']); returns the brief's GET /api/leases/:leaseId shape exactly: lease { id, unitId, tenantId, startDate, endDate, monthlyRentSen, depositSen }, invoices in allocation order (due_date, deposit before rent, period_index) with paidSen = Σ allocations and status = invoiceStatus({dueDate, amountSen, paidSen}, asOf), payments (id, amountSen, unappliedSen, method, status, receivedAt = formatInstantMyt) ordered by received_at, created_at. All numbers via toSen, dates via dateToIso.
  listLeases(ctx) — staff/manager: org's leases with unit name, tenant name; tenant: own leases.
- src/server/services/reports.ts: collectionsReport(ctx, from, to) — staff/manager (tenant 403); from/to must be YYYY-MM (isYearMonth), from <= to, at most 120 months, else 400 'Invalid range'; ONE $queryRaw with generate_series over months from to_date(from) to to_date(to) left join approved payments of the caller org grouped by to_char(received_at at time zone 'Asia/Kuala_Lumpur', 'YYYY-MM') (D25), sum cast ::bigint then toSen; typed rows. Returns [{ month, collectedSen }] in order including zero months. overdueCount(ctx, asOf) — staff/manager: count of the org's invoices whose invoiceStatus is overdue.
- src/server/services/serialize.ts: small helpers mapping Prisma rows to API shapes (shared with payments).
- Routes (thin, wrapped with route(); authenticate with requireUserId(req) first -> 401): POST /api/leases -> 201 { id }; GET /api/leases (list, for the UI); GET /api/leases/[leaseId] -> 200 shape; GET /api/reports/collections?from&to -> 200 array. const { leaseId } = await params.
${waitFor('src/server/access.ts, src/server/http.ts and src/server/auth.ts exist (backend T2) and ' + MARK_T1)}
Done means: tsc and eslint clean (show output), and curl probes against http://127.0.0.1:3000: unauthenticated GET /api/leases/<random uuid> -> 401 JSON; GET /api/reports/collections without auth -> 401. (Seeded users arrive in T5c; authenticated probes happen there.)`,
}

const T5b = { id: 'T5b', lane: 'backend-engineer', agentType: 'backend-engineer', review: false,
  files: 'src/server/services/payments.ts, src/app/api/leases/[leaseId]/payments/route.ts, src/app/api/payments/[paymentId]/approve/route.ts, src/app/api/payments/[paymentId]/reject/route.ts, src/app/api/payments/[paymentId]/void/route.ts, src/app/api/payments/[paymentId]/slip/route.ts',
  prompt: `Task T5b (BOARD.md row T5, payments half) — R19-R25, R28, R44, D6, D9, D22. Using T2's modules and the private functions from migration 20261026000002_money.sql (read it for the exact signatures), implement src/server/services/payments.ts:
- recordPayment(ctx, leaseId, input, opts?: { idempotencyKey?: string }) — loadCaller; requireLeaseAccess(['manager','staff']) (tenant on own lease -> 403, others -> 404); zod .strict() { amountSen: positive safe int, method: 'cash'|'bank_transfer', receivedAt: string, slipPath?: string } (400); receivedAt via parseInstantWithOffset (no offset -> 400 'receivedAt must be an ISO 8601 instant with an offset', D6); bank_transfer needs slipPath, cash must not have one (400); slipPath must start with '<lease org_id>/' and contain no '..' (400). Optional Idempotency-Key header must be a uuid when present (400). Call private.record_payment via prisma.$queryRaw (typed row) wrapped in withRetry. On ANY failure after a slipPath was supplied: delete that object with the admin storage client IF no payment row references that slip_path (R20 'file must not be left behind'), then rethrow. Returns { id, status } with 201 (replay -> 200 with the original body).
- approvePayment(ctx, paymentId) -> requirePaymentAccess(['manager']) (staff on own org -> 403) -> private.approve_payment -> { status }. rejectPayment(ctx, paymentId, input) / voidPayment(ctx, paymentId, input) -> zod .strict() { reason: string trimmed min 5 } (400 'Reason must be at least 5 characters') -> private.reject_payment / private.void_payment -> { status }.
- getSlipUrl(ctx, paymentId) -> requirePaymentAccess(['manager','staff']) -> 404 if no slip_path -> admin storage createSignedUrl(slip_path read FROM THE DB ROW, 60 seconds) -> { url }.
- Routes (thin, route() wrapper, requireUserId first): POST /api/leases/[leaseId]/payments (201 { id, status }), POST /api/payments/[paymentId]/approve|reject|void (200 { status }), GET /api/payments/[paymentId]/slip (200 { url }).
Errors from the SQL functions come back as P0400/P0404/P0409/P0422 — rely on src/lib/errors.ts toErrorResponse; if its SQLSTATE extraction does not work with the Prisma driver adapter error shape you observe, fix src/lib/errors.ts (you own it) and say so.
${waitFor(MARK_T4)} ${waitFor('src/server/access.ts exists')}
Done means: tsc and eslint clean (show output); curl probe unauthenticated POST /api/payments/<uuid>/approve -> 401 JSON.`,
}

const T5c = { id: 'T5c', lane: 'backend-engineer', agentType: 'backend-engineer', review: false,
  files: 'scripts/seed.ts, scripts/assets/slip-sample.pdf (create a tiny valid PDF with Write), any fixes in src/server/** and src/lib/** you need',
  prompt: `Task T5c (BOARD.md row T5, seed) — R5, R7, R8, R9, D20, D24, D30. Write scripts/seed.ts (run by npm run seed = tsx scripts/seed.ts; load .env.local then .env with dotenv BEFORE importing app modules — use dynamic import() after config, since src/lib/prisma.ts reads DATABASE_URL at import; note src/lib/supabase/admin.ts imports 'server-only' which throws outside Next: create the admin supabase-js client directly in the seed instead of importing admin.ts, and if services import admin.ts, refactor so the storage-admin client is created lazily in a module without 'server-only' or pass it in — keep the secret key out of any client bundle).
Exactly the brief's data (../BRIEF.md section 2): organizations Northwind Properties, Beta Realty; users via supabase admin auth.admin.createUser({ email, password: SEED_PASSWORD ?? 'RentDemo#2026', email_confirm: true }): manager@northwind.test (manager), staff@northwind.test (staff), aisyah@northwind.test / ben@northwind.test / probe@northwind.test (tenants 'Aisyah Rahman', 'Ben Lim', 'Probe Tenant'), manager@beta.test (manager), chen@beta.test (tenant 'Chen Wei'); memberships + tenants rows (email = login) with Prisma; units A-12-3, B-05-1, C-01-7, D-03-2 (Northwind), KL-1 (Beta). Then THROUGH THE SERVICES (ctx = the manager's userId): createLease for the 4 leases (A-12-3 Aisyah 2026-01-31..2026-07-15 150000 dep 300000; B-05-1 Ben 2026-01-01..2026-04-15 100029 dep 0; C-01-7 Probe 2026-02-28..2027-02-27 200000 dep 400000; Beta KL-1 Chen 2026-03-15..2027-03-14 220000 dep 440000 by the Beta manager). Payments on Aisyah's lease: recordPayment as the Northwind manager { amountSen: 300000, method: 'cash', receivedAt: '2026-01-31T10:00:00+08:00' }; upload scripts/assets/slip-sample.pdf to payment-slips at <northwind_org_id>/<aisyah_lease_id>/<uuid>.pdf (admin client, contentType application/pdf), recordPayment as staff { 200000, 'bank_transfer', '2026-03-01T00:30:00+08:00', slipPath } -> pending_verification, then approvePayment as the manager. If organizations already has rows, exit 1 with 'Database is not fresh: run npx supabase db reset first'. Print a summary (no secrets).
Steps: (1) write the seed; (2) bash ../scripts/db-reset.sh (D30: you are allowed to reset ONLY for this seed check); (3) npm run seed; (4) verify with curl: sign in manager@northwind.test via POST http://127.0.0.1:54321/auth/v1/token?grant_type=password (apikey header = publishable key from .env.local, JSON body) and with the access token: GET /api/leases/<aisyah lease id> shows deposit + periods 0..5 with 77419 last, paidSen deposit 300000, period0 150000, period1 50000; GET /api/reports/collections?from=2026-01&to=2026-03 -> [{"month":"2026-01","collectedSen":300000},{"month":"2026-02","collectedSen":0},{"month":"2026-03","collectedSen":200000}]; aisyah token GET her lease 200, Ben's lease 404, POST payments on own lease 403; staff POST approve -> 403; Beta manager GET Aisyah's lease -> 404; manager approve of an approved payment -> 409. (5) Leave the DB seeded. Fix any bug you find in src/server/** or src/lib/** and list it.
Done means: steps 2-4 output shown, tsc + eslint clean.`,
}

const UI = { id: 'T11a', lane: 'ui-builder', agentType: 'ui-builder', review: false,
  files: 'src/app/layout.tsx, src/app/page.tsx, src/app/login/**, src/app/(app)/layout.tsx, src/components/app-shell/**, src/components/ui/** (shadcn add only), src/app/globals.css',
  prompt: `Task T11a (BOARD.md row T11, shell only) — R49, R52. Build the app shell with shadcn/ui (components already in src/components/ui; style base-nova, the cn helper comes from the 'cn' package via @/lib/utils) and Tailwind:
- src/app/layout.tsx: <Toaster /> from src/components/ui/sonner, page title 'Rent Collection', no hydration warnings (no Date rendering in layout).
- src/app/login/page.tsx: email + password form, supabase browser client from src/lib/supabase/browser.ts (createClient export — read the file; if it does not exist yet, ${waitFor('src/lib/supabase/browser.ts exists')}), signInWithPassword, toast on error, loading state on the button, then router.push('/') and router.refresh().
- src/app/page.tsx: server component; reads the user with the cookie server client (src/lib/supabase/server.ts) auth.getUser(); not logged in -> redirect('/login'); otherwise render links (placeholder) — staff/manager -> '/dashboard', tenant -> '/tenant'. Role lookup: do NOT read user_metadata; import loadCaller from src/server/access.ts (${waitFor('src/server/access.ts exists')}).
- src/components/app-shell/: header with app name, the user's email, and a sign-out button (client component; supabase.auth.signOut then router.push('/login')).
- Do NOT create /dashboard, /leases, /tenant pages (later tasks). No data fetching beyond the role.
Done means: npx tsc --noEmit and npx eslint . --max-warnings=0 clean, and curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/login returns 200.`,
}

// ---------- orchestration ----------
let agentsUsed = 0
const MAX_AGENTS = 14
const run = (prompt, opts) => { agentsUsed++; return agent(prompt, opts) }

const implement = (t) => run(`${COMMON}\n\nFiles you may edit: ${t.files}\n\n${t.prompt}`,
  { agentType: t.agentType, label: `${t.id}:${t.lane}`, phase: 'Implement', schema: IMPL_SCHEMA })

const verify = async (t, impl) => {
  if (!impl) return { task: t.id, impl: null, review: null, skeptic: null }
  const files = (impl.files_changed || []).join(', ')
  const reviewP = t.review ? run(`${COMMON}\n\nReview task ${t.id} (${t.lane}). Read-only. The files it changed/created (uncommitted; use git diff HEAD -- <file> for tracked files and read untracked ones in full): ${files}.\nThe brief for that task was:\n${t.prompt}\n\nReview against ../BRIEF.md, ../SPEC.md (Contracts, Error contract, Domain rules, Integration contracts) and the CLAUDE.md hard rules AS OVERRIDDEN above. Report only real problems with a concrete failure scenario. End verdict PASS or FAIL (FAIL only for blocker/major findings).`,
    { agentType: 'reviewer', label: `${t.id}:review`, phase: 'Verify', schema: REVIEW_SCHEMA }) : Promise.resolve(null)
  const skepticP = t.skeptic ? run(`${COMMON}\n\nYou are an independent skeptic. Try to REFUTE that task ${t.id} satisfies the brief's money and concurrency rules. Files: ${files}. Read them fully (read-only; you may run read-only psql queries and you may run transactions that ROLLBACK against the local DB through bash ../scripts/with-db.sh). Attack: lock order and deadlocks between record/approve/void/callback; cap computed before the lock; pending counted wrongly; approve re-check; allocation order (due_date, deposit before rent, period_index) and fill-up; unapplied_sen; void touching other payments; idempotency replay order; a bill creating two payments under concurrent callbacks; paid bill going back; status transitions; SQLSTATEs; messages leaking other-org data; search_path; grants to anon/authenticated. Default to refuted=true only with a concrete scenario.`,
    { agentType: 'reviewer', label: `${t.id}:skeptic`, phase: 'Verify', schema: SKEPTIC_SCHEMA }) : Promise.resolve(null)
  const [review, skeptic] = await Promise.all([reviewP, skepticP])
  return { task: t.id, impl, review, skeptic }
}

const item = (t, deps = []) => Promise.all(deps).then(() => implement(t)).then(impl => verify(t, impl))

log('Phase A: T1 (schema), T2 (lib), T3 (tests harness), T4 (money fns, waits on T1 marker), UI shell start now; T6 after T1+T3; T5a after T1+T2; T5b after T4+T5a; T5c after T5b')
const p1 = item(T1)
const p2 = item(T2)
const p3 = item(T3)
const p4 = item(T4)
const pUI = item(UI)
const p6 = item(T6, [p1, p3])
const p5a = item(T5a, [p1, p2])
const p5b = item(T5b, [p4, p5a])
const p5c = p5b.then(() => implement(T5c)).then(async impl => {
  // One combined review of the whole services+routes+seed slice (T5a+T5b+T5c) to stay within 14 agents.
  const r5a = await p5a, r5b = await p5b
  const files = [r5a, r5b].flatMap(r => (r && r.impl && r.impl.files_changed) || []).concat((impl && impl.files_changed) || [])
  return verify({ ...T5c, id: 'T5', review: true, skeptic: false, prompt: T5a.prompt + '\n\n' + T5b.prompt + '\n\n' + T5c.prompt }, impl ? { ...impl, files_changed: files } : null)
})

const results = await Promise.all([p1, p2, p3, p4, p6, p5a, p5b, p5c, pUI])
log(`agents used: ${agentsUsed}/${MAX_AGENTS}. Fixer rounds are NOT run inside this workflow (agent cap); the lead runs fixers on FAIL findings after the gate.`)
return results.map(r => r && ({
  task: r.task,
  status: r.impl && r.impl.status,
  files: r.impl && r.impl.files_changed,
  checks: r.impl && r.impl.checks_run,
  assumptions: r.impl && r.impl.assumptions,
  gaps: r.impl && r.impl.contract_gaps,
  packages: r.impl && r.impl.packages_needed,
  notes: r.impl && r.impl.notes,
  review: r.review,
  skeptic: r.skeptic,
}))
