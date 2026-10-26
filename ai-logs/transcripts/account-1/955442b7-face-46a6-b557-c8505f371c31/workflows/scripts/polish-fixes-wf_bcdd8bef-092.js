export const meta = {
  name: 'polish-fixes',
  description: 'Polish review minors: new-lease form UX + dead code (ui-builder), leaseFormOptions authz test (test-authz)',
  phases: [{ title: 'Fix' }],
}
const COMMON = `Timed build lane (feature freeze 03:48Z). Working dir ./app. ../SPEC.md, ../DECISIONS.md. One simple command per Bash call; never npm i; never commit; NEVER db reset; DB/test commands via bash ../scripts/with-db.sh <cmd>. Dev server at :3000 (never start/kill). Edit ONLY your listed files.`
const S = { type: 'object', properties: { status: { type: 'string' }, files_changed: { type: 'array', items: { type: 'string' } }, checks_run: { type: 'array', items: { type: 'string' } }, assumptions: { type: 'array', items: { type: 'string' } } }, required: ['status', 'files_changed', 'checks_run', 'assumptions'] }
const ui = agent(`${COMMON}
Files: src/components/staff/new-lease-form.tsx, src/components/staff/staff-nav.tsx (delete it), src/app/(app)/dashboard/page.tsx, src/app/(app)/leases/page.tsx, src/app/(app)/leases/[leaseId]/page.tsx (only to remove StaffNav).
1. new-lease-form.tsx ~117-123: keep submitting=true after toast.success + router.push (reset only on error paths) so a second click cannot POST again.
2. new-lease-form.tsx ~62-67: before calling generateSchedule, show friendly inline messages: rent missing or not > 0 -> 'Enter a monthly rent greater than RM 0.00'; dates missing -> 'Choose a start and end date'; endDate < startDate (string compare of YYYY-MM-DD) -> 'The end date must be on or after the start date'; keep 'Check the dates and amounts' as the fallback for anything generateSchedule still throws. Never show generateSchedule's raw message.
3. Delete src/components/staff/staff-nav.tsx (dead code, returns null) and remove its imports/usages from the three pages.
Done means: npx tsc --noEmit and npx eslint . --max-warnings=0 clean.`,
  { agentType: 'ui-builder', label: 'polishfix:ui', phase: 'Fix', schema: S })
const t = agent(`${COMMON}
Files: tests/authz/lease-form-options.test.ts (new). Test src/server/services/leases.ts leaseFormOptions(ctx) directly (ctx = { userId } of real users; use tests/helpers createFixtureOrg twice for orgs A and B, or ctxFor for seeded users): staff and tenant -> throws ApiError with status 403 (import ApiError from src/lib/errors); manager of A gets exactly A's unit ids and tenant ids (compare as sets with pg), and none of B's; a user with no membership -> 403. Describe name starts with 'R36 R39'. Done means: bash ../scripts/with-db.sh npx vitest run tests/authz/lease-form-options.test.ts passes.`,
  { agentType: 'test-authz', label: 'polishfix:test-authz', phase: 'Fix', schema: S })
return await Promise.all([ui, t])
