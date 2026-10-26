export const meta = {
  name: 'phase-a-fixes',
  description: 'Fix round for phase A review findings: migrations (db-engineer) + payments service cleanup (fixer)',
  phases: [{ title: 'Fix' }],
}
const COMMON = `You are a lane in a timed build. Working directory ./app. Kit files: ../BRIEF.md (source of truth), ../SPEC.md, ../DECISIONS.md. The brief wins over CLAUDE.md where SPEC.md says so (error body {error: string}, no required idempotency key, no webhook_events, bigint sen, status never stored, seed = npm run seed). One simple command per Bash call; never npm i; never commit; DB commands via bash ../scripts/with-db.sh <cmd>. Dev server already runs on :3000 (do not touch it).`
const SCHEMA = { type: 'object', properties: {
  status: { type: 'string', enum: ['done', 'partial', 'blocked'] }, files_changed: { type: 'array', items: { type: 'string' } },
  checks_run: { type: 'array', items: { type: 'string' } }, assumptions: { type: 'array', items: { type: 'string' } }, notes: { type: 'string' } },
  required: ['status', 'files_changed', 'checks_run', 'assumptions'] }

const db = agent(`${COMMON}
Task T1/T4 fix round (db-engineer). Migrations 0001 and 0002 are NOT committed yet, so edit them IN PLACE (supabase/migrations/20261026000001_schema.sql and 20261026000002_money.sql). Files you may edit: those two migrations, prisma/schema.prisma (db pull only), supabase/tests/money_smoke.sql.
Apply exactly these reviewer findings:
1. 0001: per-schema "alter default privileges ... revoke execute on functions from public" does not remove the global PUBLIC execute default. Add the global form: alter default privileges for role postgres revoke execute on functions from public; (keep the explicit per-function revokes).
2. 0001: the payments reason CHECK passes when reason is NULL. Use coalesce(char_length(btrim(reason)), 0) >= 5 for rejected/voided. (tests/db/constraints.test.ts has a failing test for this; it must pass.)
3. 0001: gateway_bills_guard: make it ENABLE ALWAYS like the others, add a BEFORE TRUNCATE guard, and when old.status = 'paid' reject any change to paid_at, transaction_id, transaction_status (a paid bill never goes back, R34).
4. 0001: invoices amount check: rent invoices may be 0 sen (generateSchedule can round a tiny last period to 0, and the brief says lease creation stores EXACTLY the schedule). Use check (amount_sen > 0 or (kind = 'rent' and amount_sen = 0)) — deposit stays > 0. Make sure allocate_payment never inserts a 0-sen allocation (allocation rows keep amount_sen > 0).
5. 0002: apply_gateway_callback must ALSO insert an audit row 'payment.approved' (actor_id null, entity_id = the new payment id, details {source:'gateway', bill_id}) in addition to gateway_bill.paid (R25 "every approval").
6. 0002: reusing a slip_path already attached to another payment must be P0400 'Slip already used' (route table lists 400 for invalid input), not P0409.
7. 0002: add at the top of each lease-locking function a guard: if current_setting('transaction_isolation') <> 'read committed' then raise exception using errcode = 'P0409', message = 'Unsupported isolation level'; with a comment "-- D7: the cap is computed after the lease lock; READ COMMITTED gives each statement a fresh snapshot after the wait".
Then: bash ../scripts/db-reset.sh; npx prisma db pull --force; npx prisma generate; npx tsc --noEmit; bash ../scripts/with-db.sh npx vitest run tests/db tests/rls tests/storage (report pass/fail counts, all must pass); then npm run seed (the DB is freshly reset; the seed password in .env.local is now quoted, RentDemo#2026) and show its summary; then psql -v ON_ERROR_STOP=1 -f supabase/tests/money_smoke.sql against the DB (it rolls back) and show the tail.`,
  { agentType: 'db-engineer', label: 'T1/T4-fix:db-engineer', phase: 'Fix', schema: SCHEMA })

const be = agent(`${COMMON}
Task T5 fix round (fixer). Files you may edit: src/server/services/payments.ts, src/server/services/serialize.ts only.
Findings to fix:
1. src/server/services/payments.ts ~92-100: requireRecorder runs outside the try/catch that removes an uploaded slip, so a 404/403 on the lease leaves the uploaded file behind (R20 "If recording fails after the upload, the file must not be left behind"). Restructure: load the caller first; wrap authorization + validation + the record call in the cleanup try; on failure remove the slip ONLY when slipPath is a string starting with '<caller.member.orgId>/' (the caller's own org folder — never delete in another org's folder), contains no '..', and no payment row references it (existing guard). Rethrow the original error.
2. payments.ts 36-39: asStatus duplicates asPaymentStatus in serialize.ts 61-64 — export asPaymentStatus from serialize.ts and use it.
Do not change behaviour otherwise. Done means: npx tsc --noEmit and npx eslint . --max-warnings=0 clean (show output).`,
  { agentType: 'fixer', label: 'T5-fix:fixer', phase: 'Fix', schema: SCHEMA })

return await Promise.all([db, be])
