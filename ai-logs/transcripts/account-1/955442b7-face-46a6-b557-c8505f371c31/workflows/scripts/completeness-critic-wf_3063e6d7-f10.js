export const meta = {
  name: 'completeness-critic',
  description: 'Read-only: walk the brief section by section against the repo and list anything missing, untested or contradicting the contract',
  phases: [{ title: 'Critic' }],
}
const S = { type: 'object', properties: {
  gaps: { type: 'array', items: { type: 'object', properties: { brief_ref: { type: 'string' }, requirement: { type: 'string' }, status: { type: 'string', enum: ['missing', 'wrong', 'untested', 'doc_only'] }, evidence: { type: 'string' }, fix_effort: { type: 'string', enum: ['<5min', '5-15min', '>15min'] } }, required: ['brief_ref', 'requirement', 'status', 'evidence', 'fix_effort'] } },
  submission_checklist: { type: 'array', items: { type: 'string' }, description: 'each item of the brief Submission section with present/absent' } },
  required: ['gaps', 'submission_checklist'] }
return await agent(`Read-only completeness critic. Working dir ./app (a Next.js + Supabase repo, all committed). Read ../BRIEF.md fully, then check the repo against EVERY requirement in sections 1-9, Part B, Part C and Submission, section by section: names/paths/shapes are a contract (tables, columns, routes, status codes, response bodies, env vars, npm scripts, file paths like src/lib/billing.ts, REVIEW.md, DECISIONS.md, ai-logs/ (will be filled at the end — note only), README contents: how to run, known issues, what next). Look at code AND tests (tests/**). You may run read-only commands and curl against http://127.0.0.1:3000 (seeded; password RentDemo#2026; publishable key in .env.local), but never edit, never reset, never create data except on the probe@northwind.test lease. Report ONLY real gaps with evidence (file:line or request/response). Do not report things the repo documents as deliberate decisions in DECISIONS.md unless they contradict the brief. One simple command per Bash call.`,
  { agentType: 'reviewer', label: 'critic:brief-vs-repo', phase: 'Critic', schema: S })
