export const meta = {
  name: 'panel-b-minors',
  description: 'Hard stop (b) panel minors: failing tests first (test-authz), then migration 0003 (db-engineer): drop storage SELECT policy, revoke service_role writes, fix D7 comments',
  phases: [{ title: 'Test first' }, { title: 'Fix' }],
}
const COMMON = `Timed build lane. Working dir ./app. Source of truth ../BRIEF.md; ../SPEC.md; ../DECISIONS.md (D50, D51). The brief overrides CLAUDE.md where SPEC.md says so. One simple command per Bash call; never npm i; never commit; NEVER run supabase db reset (other lanes are testing on the seeded DB right now); DB commands via bash ../scripts/with-db.sh <cmd>. Other lanes are concurrently writing tests/concurrency, tests/webhook, tests/contract, tests/authz and src/server/services/gateway.ts/webhook.ts — do not touch those.`
const S = { type: 'object', properties: { status: { type: 'string' }, files_changed: { type: 'array', items: { type: 'string' } }, checks_run: { type: 'array', items: { type: 'string' } }, assumptions: { type: 'array', items: { type: 'string' } } }, required: ['status', 'files_changed', 'checks_run', 'assumptions'] }
phase('Test first')
const t = await agent(`${COMMON}
Task: panel-b minors, failing tests FIRST (test-authz). Files you may edit: tests/rls/catalog.test.ts, tests/storage/slips.test.ts.
1. D50: assert there is NO SELECT (or ALL) policy on storage.objects for bucket payment-slips — only the INSERT policy for authenticated; in slips.test.ts change the positive-control read (around line 184) so staff/manager read a slip through a signed URL created with the SECRET key (admin client) — not with their own token — and ADD assertions that staff/manager of the same org can NOT download, list or createSignedUrl with their own token; uploads by staff/manager to their own org folder must still succeed (upsert false).
2. D51: assert service_role has no INSERT/UPDATE/DELETE/TRUNCATE privilege on any public table (has_table_privilege), and still has SELECT.
Run bash ../scripts/with-db.sh npx vitest run tests/rls/catalog.test.ts tests/storage — the new assertions MUST FAIL now (the migration is fixed in the next step); report which fail.`,
  { agentType: 'test-authz', label: 'minors:test-authz', phase: 'Test first', schema: S })
phase('Fix')
const d = await agent(`${COMMON}
Task: panel-b minors fix (db-engineer). Files you may edit: supabase/migrations/20261026000003_hardening.sql (new), supabase/migrations/20261026000002_money.sql (COMMENTS ONLY), prisma/schema.prisma (db pull only).
1. New migration 20261026000003_hardening.sql: drop policy payment_slips_select on storage.objects (D50); revoke insert, update, delete, truncate on all tables in schema public from service_role; alter default privileges for role postgres in schema public revoke insert, update, delete, truncate on tables from service_role (D51). Comment each with its D-id.
2. In 20261026000002_money.sql fix the copied comment '-- D7: the cap is computed after the lease lock; READ COMMITTED ...' in lock_payment_for_manager, create_gateway_bill and apply_gateway_callback so each describes that function (e.g. apply_gateway_callback: '-- D7: READ COMMITTED so the re-read after the bill lock wait sees the committed status'). Comments only — no code change.
3. Apply WITHOUT reset: npx supabase migration up (applies the pending 0003 to the running local DB, keeping the seeded data). Then npx prisma db pull and npx prisma generate (expect no schema diff). Then bash ../scripts/with-db.sh npx vitest run tests/rls tests/storage tests/db — all must pass now, including the tests test-authz just added (${'${'}t-files${'}'} = tests/rls/catalog.test.ts, tests/storage/slips.test.ts). Report counts.`,
  { agentType: 'db-engineer', label: 'minors:db-engineer', phase: 'Fix', schema: S })
return { tests: t, db: d }
