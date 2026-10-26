export const meta = {
  name: 'lease-page-suspense',
  description: 'D72: Suspense skeleton on /leases/[leaseId] after the access check (real 404 kept)',
  phases: [{ title: 'Fix' }],
}
const S = { type: 'object', properties: { status: { type: 'string' }, files_changed: { type: 'array', items: { type: 'string' } }, checks_run: { type: 'array', items: { type: 'string' } }, assumptions: { type: 'array', items: { type: 'string' } } }, required: ['status', 'files_changed', 'checks_run', 'assumptions'] }
return await agent(`Timed build lane (deadline 04:15Z). Working dir ./app. One simple command per Bash call; never npm i; never commit; never db reset. Files you may edit: src/app/(app)/leases/[leaseId]/page.tsx, src/components/staff/lease-detail*.tsx (new, if you split the body out), src/components/staff/skeletons.tsx (only to add/export a lease-page skeleton). Do NOT add a loading.tsx (D61/D72: a route-level loading.tsx flushes a 200 before the access check).
Task (D72): the page must FIRST, before returning any JSX, authenticate and run the access check — loadCaller(userId) + requireLeaseAccess(caller, leaseId, ['manager','staff']) from src/server/access.ts, mapping ApiError 404/403 to notFound() exactly as it does today (tenants keep their existing redirect). Only after that, return a tree whose data-heavy part (getLease + listLeases title lookup + the invoices/payments tables + forms) is an async server component rendered inside <Suspense fallback={<the lease skeleton from src/components/staff/skeletons.tsx>}>. Keep every existing behaviour, props (defaultReceivedAt, orgId, manager-only actions) and text.
Done means: npx tsc --noEmit and npx eslint . --max-warnings=0 clean; and run node /tmp/claude-1000/pagecheck2.mjs if it exists — otherwise verify with curl that GET /leases/00000000-0000-4000-8000-000000000000 with no cookie is a 307 to /login. Report exactly what you changed.`,
  { agentType: 'ui-builder', label: 'suspense:ui', phase: 'Fix', schema: S })
