export const meta = {
  name: 'panel-c-minors',
  description: 'Hard stop (c) minors: failing tests first (test-authz, test-concurrency), then backend fixer (slip cleanup on pre-auth failure) and UI robustness fixes',
  phases: [{ title: 'Test first' }, { title: 'Fix' }],
}
const COMMON = `Timed build lane. Working dir ./app. Source of truth ../BRIEF.md; ../SPEC.md; ../DECISIONS.md (D1-D63, all decided). The brief overrides CLAUDE.md where SPEC.md says so. One simple command per Bash call; never npm i; never commit; NEVER run supabase db reset; DB/test commands via bash ../scripts/with-db.sh <cmd>. Dev server runs at :3000 (hot reload; never start/kill it). Edit ONLY your listed files.`
const S = { type: 'object', properties: { status: { type: 'string' }, files_changed: { type: 'array', items: { type: 'string' } }, checks_run: { type: 'array', items: { type: 'string' } }, assumptions: { type: 'array', items: { type: 'string' } } }, required: ['status', 'files_changed', 'checks_run', 'assumptions'] }

phase('Test first')
const authzTests = agent(`${COMMON}
Files you may edit: tests/db/constraints.test.ts, tests/storage/** (new file tests/storage/slip-cleanup.test.ts is fine).
1. tests/db/constraints.test.ts ~329-333: the service_role DELETE on payments must assert exactly '42501' (D51 grant fact); keep the owner case asserting the trigger P0409.
2. NEW failing tests (R20 "If recording fails after the upload, the file must not be left behind"): as a fixture org's staff (tests/helpers createFixtureOrg + uploadSlip from tests/helpers/contract.ts or the storage client with the staff token), upload a slip to <org>/<lease>/<uuid>.png, then POST /api/leases/<random nonexistent uuid>/payments with { amountSen, method:'bank_transfer', receivedAt, slipPath } -> 404, and assert the object is GONE from storage.objects (pg). Same for: the lease of ANOTHER fixture org -> 404 and the slip (in the caller's own org folder) is gone; a valid lease but receivedAt without offset -> 400 and gone; malformed JSON body after upload -> 400 and gone if the path can be recovered — skip that last one if not recoverable, say so. Also assert a slip in ANOTHER org's folder is never deleted by such a failing request.
Run bash ../scripts/with-db.sh npx vitest run tests/db tests/storage — the 404 cleanup tests are expected to FAIL now (the route pre-authorizes outside the cleanup try); report exactly which fail.`,
  { agentType: 'test-authz', label: 'minorsC:test-authz', phase: 'Test first', schema: S })
const concTests = agent(`${COMMON}
Files you may edit: tests/webhook/**, tests/concurrency/**.
1. tests/webhook/gateway.test.ts ~167-176: duplicate keys -> assert exactly 401 + { error } body; rename the test to '... -> 401 (D52)'.
2. NEW DB-level boundary test (R30, D5): on a fixture lease (or inside BEGIN ... ROLLBACK with pg as postgres) with an invoice due on day D and nothing allocated, call private.create_gateway_bill(<tenant user id>, <lease id>, p_as_of) at (D-1)T15:59:59Z and at (D-1)T16:00:00Z (= D 00:00 Malaysia): the amount at the second instant is larger by exactly that invoice's amount (or the first gives P0422 'Nothing is due' when it is the first invoice). Use a transaction that rolls back so no bill rows persist, or accept the bills on the fixture lease.
Run bash ../scripts/with-db.sh npx vitest run tests/webhook tests/concurrency twice; report counts.`,
  { agentType: 'test-concurrency', label: 'minorsC:test-concurrency', phase: 'Test first', schema: S })
const ui = agent(`${COMMON}
Files you may edit: src/components/staff/**, src/components/tenant/**, src/components/app-shell/**, src/app/(app)/leases/[leaseId]/page.tsx, src/app/(app)/payments/return/page.tsx, src/app/login/**.
UI minors from the hard-stop (c) panel:
1. record-payment-form.tsx: remove the eslint-disable + useEffect default. Compute the default received-at on the server in src/app/(app)/leases/[leaseId]/page.tsx as formatInstantMyt(new Date()).slice(0, 16) (import from @/lib/dates) and pass it as a defaultReceivedAt prop used in useState; after a successful submit reset with the same helper. Server and client render the same string -> no hydration mismatch.
2. src/components/staff/api.ts: callApi must never leave a form stuck: a 2xx with an empty/non-JSON body -> { ok: false, error: 'Unexpected response from the server' }; every onSubmit/approve/reject/void handler resets its busy state in finally and toasts on any thrown error.
3. Never show raw PostgREST/Storage error text in toasts (phone-form.tsx ~39, record-payment-form.tsx ~120): map to fixed messages ('Your phone number could not be saved. Use digits, spaces or dashes, optionally starting with +.', 'Slip upload failed. Use a JPEG, PNG or PDF of at most 5 MB.'). API { error } messages from OUR routes may still be shown (they are written by us).
4. /payments/return: when there is no session, redirect to /login?next=<encoded /payments/return?bill_id=...>. The login form (src/components/app-shell/login-form.tsx or wherever it lives) accepts next ONLY if it starts with '/' and not '//' or '/\\' and contains no ':' before the first '/' (no scheme) — otherwise go to '/'. No open redirect.
Done means: npx tsc --noEmit and npx eslint . --max-warnings=0 clean (show output); curl -s -o /dev/null -w '%{http_code}' for /login, /leases, /tenant, /payments/return?bill_id=x still 200/307.`,
  { agentType: 'ui-builder', label: 'minorsC:ui-builder', phase: 'Fix', schema: S })

const t = await authzTests
phase('Fix')
const be = await agent(`${COMMON}
Files you may edit: src/app/api/leases/[leaseId]/payments/route.ts, src/server/services/payments.ts.
Fix (R20, panel c): the route pre-authorizes (requireUserId + authorizeRecordPayment, needed so 404/403 come before a malformed-JSON 400, D42) OUTSIDE recordPayment's slip-cleanup try, so a bank-transfer slip uploaded before a 401/403/404 (unknown lease, other org's lease, expired token) is left in Storage. Make the route read the raw body text first, then on ANY error after that point (authorization, JSON parse, validation, record) best-effort extract slipPath from the body (JSON.parse in try/catch, string only) and call the service's cleanup with the caller's own org: delete only when the caller is authenticated and is staff/manager of an org, the path starts with '<that org id>/', has no '..' or backslash, and no payments row references it (existing removeOrphanSlip guard). Never delete in another org's folder; never delete for an unauthenticated caller (no org to scope by). Keep the D42 order of status codes unchanged. Fix the misleading comment at payments.ts ~94.
The failing tests from test-authz are: ${JSON.stringify((t && t.checks_run) || [])}. Run bash ../scripts/with-db.sh npx vitest run tests/storage tests/contract tests/authz — all must pass (show counts), plus tsc + eslint clean.`,
  { agentType: 'fixer', label: 'minorsC:fixer', phase: 'Fix', schema: S })
const [c, u] = await Promise.all([concTests, ui])
return { authzTests: t, concTests: c, backend: be, ui: u }
