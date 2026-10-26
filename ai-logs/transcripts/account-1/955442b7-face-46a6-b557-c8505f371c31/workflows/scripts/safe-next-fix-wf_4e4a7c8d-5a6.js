export const meta = {
  name: 'safe-next-fix',
  description: 'Open-redirect guard: unit test for safeNextPath first, then simplify the guard (fixer)',
  phases: [{ title: 'Fix' }],
}
const S = { type: 'object', properties: { status: { type: 'string' }, files_changed: { type: 'array', items: { type: 'string' } }, checks_run: { type: 'array', items: { type: 'string' } }, assumptions: { type: 'array', items: { type: 'string' } } }, required: ['status', 'files_changed', 'checks_run', 'assumptions'] }
return await agent(`Timed build lane. Working dir ./app. One simple command per Bash call; never npm i; never commit; never db reset. Files you may edit: src/components/app-shell/login-form.tsx (or move the pure helper to src/components/app-shell/safe-next-path.ts and import it), tests/unit/safe-next-path.test.ts (new).
1. FIRST write tests/unit/safe-next-path.test.ts (describe 'R36 safeNextPath open-redirect guard'): inputs '//evil.com', '/\\\\evil.com', '/\\t/evil.com', '/\\n/evil.com', 'https://evil.com', 'javascript:alert(1)', '', undefined, null, ['/a','/b'], '/%2F%2Fevil.com' (must stay a same-origin path or fall back) -> '/'; '/payments/return?bill_id=abc' and '/leases' kept as is. Run it.
2. Then make safeNextPath a pure exported function (no React) and replace the dead colon check with a real same-origin check: decode nothing, reject control chars, require next to start with '/' but not '//' or '/\\\\', and require new URL(next, 'http://local.invalid').origin === 'http://local.invalid'. Keep login-form behaviour otherwise unchanged.
Done means: npx vitest run tests/unit/safe-next-path.test.ts passes, npx tsc --noEmit and npx eslint . --max-warnings=0 clean.`, { agentType: 'fixer', label: 'safe-next:fixer', phase: 'Fix', schema: S })
