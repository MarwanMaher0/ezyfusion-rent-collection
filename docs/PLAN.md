# PLAN — rent collection (EzyFusion), 4 h from 2026-10-26T00:48:36Z (hard end 04:48:36Z)

Priority (brief): billing §3 → access control §6 → payments §4 → webhook §5 → UI §9. Riskiest graded areas first.
Clock: e = elapsed since 00:48:36Z. Feature freeze at e 3:00 (03:48Z). Logs/submission from e 3:35.

| task | lane | R | budget | depends on | phase |
|---|---|---|---|---|---|
| T0 scaffold: create-next-app, supabase init/start, deps (prisma 7.10.1 + adapter-pg, supabase-js, ssr, zod, vitest@4, tsx, shadcn + sonner), .npmrc, prisma init + agent-folder cleanup, .gitignore, .env.example/.env.local, scripts (seed/test/test:tz/postinstall/typecheck), cacheComponents:false, first db reset, dev server :3000, commit | lead | R4, R6 | 15 min | — | T0 |
| T1 migration 0001: tables + constraints + composite FKs + EXCLUDE overlap + indexes + RLS policies + grants/revokes + private helpers + audit_log append-only triggers + payment-slips bucket + storage policies; prisma db pull | db-engineer | R2, R37, R42–R44, R46–R48 | 35 min | T0 | A |
| T2 src/lib: billing.ts (pure, exact contract), money.ts, dates.ts, errors.ts, http.ts (json/error helpers), auth.ts (Bearer + cookie → getUser → caller from memberships/tenants), supabase server/admin clients, prisma.ts, proxy.ts | backend-engineer | R3, R10–R18, R36–R41, R45 | 35 min | T0 | A |
| T3 vitest config + tests/setup + tests/helpers (sign in each seeded user, api(), anon/user PostgREST clients, pg/prisma helpers, fixture factory for probe tenant) + tests/unit/billing.test.ts (worked example, clamp, leap, start==end, validation, half-up, overdue boundary, parse table) | test-engineer | R10–R18 | 35 min | T0 | A |
| T4 migration 0002: private.record_payment, approve_payment, reject_payment, void_payment, allocate_payment, create_gateway_bill, apply_gateway_callback (lease FOR UPDATE, cap, allocation order, unapplied, audit, fixed SQLSTATEs) | db-engineer | R19–R30, R34, R35 | 35 min | T1 | A |
| T5 services + routes: leases (create/get), payments (record/approve/reject/void, slip check + cleanup), reports (collections), seed script `npm run seed` through services | backend-engineer | R5, R7–R9, R19–R29, R39, R45, R46 | 40 min | T2, T4 | A |
| T6 catalog test + RLS matrix tests (anon + every seeded user, every table, writes fail, rpc) + audit append-only + storage policy tests | test-authz | R42–R44 | 35 min | T1, T3 | A |
| — hard stop (b): schema + RLS + seed; full gate | lead | | | | |
| T7 gateway-bills route + webhook route (raw body, HMAC timingSafeEqual, state machine via private.apply_gateway_callback) + gateway-sim.mjs | backend-engineer | R30–R35 | 30 min | T4, T5 | B |
| T8 concurrency + webhook tests: concurrent record over cap, approve ×2, overlap race, webhook valid/forged/dup/concurrent/out-of-order/amount mismatch/unknown bill/extra fields | test-concurrency | R28, R34, R35, R46 | 35 min | T5, T7 | B |
| T9 contract tests: every route, status codes, bodies, seed facts (Aisyah schedule, collections 2026-01..03) | test-engineer | R7–R9, R29, R45 | 35 min | T5 | B |
| T10 server authz tests: 401/403/404 per route per seeded role, cross-org body ids, malformed uuids | test-authz | R36–R40 | 30 min | T5 | B |
| T11 staff/manager UI: login, dashboard, leases list, lease page, record payment (parseRinggitToSen, MYT input, slip upload), approve/reject/void dialogs, toasts | ui-builder | R49, R50, R52 | 40 min | T5 | B |
| T12 tenant UI: portal (supabase-js reads), due now, Pay now, /payments/return, phone edit | ui-builder | R31, R51, R52 | 30 min | T7 | B |
| T13 Part B REVIEW.md draft (read-only reviewer returns text; lead writes the file) | reviewer → lead | R53 | 20 min | — | B |
| — hard stop (c): payments + idempotency + webhook; full gate | lead | | | | |
| T14 fixers on gate/reviewer/security findings (failing test first) | fixer | — | 20 min | gates | C |
| T15 docs: README, DECISIONS.md Part C answers, WALKTHROUGH, .env.example, ai-logs export, fresh-clone check, push | lead | R53–R55 | 30 min | all | C |

Cut order if late: T12 polish → realtime/bonus → T11 polish (keep lease page + record payment) → slip upload UI (keep server check) → contract-test breadth. Never cut: billing.ts, RLS + catalog test, record_payment lock + cap, webhook state machine + signature, error map, seed, README run steps, fresh-clone check, REVIEW.md, DECISIONS.md.
