# Rent Collection — EzyFusion technical assessment

License: all rights reserved, see [LICENSE](LICENSE) (viewing, running and evaluating for the EZYFusion assessment only).

Part of a rent collection module for Malaysian property managers: leases, invoices, cash / bank-transfer / online payments, and access control for manager / staff / tenant.
Stack: Next.js 16 (App Router) + TypeScript, local Supabase (Postgres, Auth, Storage, RLS), Prisma 7, shadcn/ui + Tailwind.

## Summary
- **Works:**
  - Every route in the brief: leases, payments (record, approve, reject, void), gateway bills, the signed webhook, the collections report.
  - `src/lib/billing.ts`, exactly as the brief specifies.
  - RLS and grants that match the brief's Data API matrix; the private `payment-slips` bucket.
  - Seeding through the app's own services.
  - Staff/manager UI (dashboard, leases, lease page, record payment with slip upload, approve/reject/void) and the tenant portal (Pay now, phone edit, read-only `/payments/return`).
  - Bonus: a manager create-lease form with a live schedule preview, unit tests for `billing.ts` and for allocation, and a server-side `?q=` search on the leases list.
  - About 1180 tests, which pass under three timezones.
- **Skipped / limits:** see [Known issues](#known-issues--skipped).
- **AI logs (`ai-logs/`):**
  - `session-lead.md`: the readable `/export` of the main Claude Code session (the lead engineer).
  - `transcripts/`: the raw JSONL transcripts of that session and of every subagent and workflow agent (database, backend, test, review, security lanes).
  - `helper-session.md`: a redacted export of the second Claude session I used alongside (planning, reading the brief from the portal, reviewing at the hard stops).
  - The decisions I made, and the corrections I gave the AI, are in `DECISIONS.md` (Part C question 6) and in my hard-stop answers (D7, D10).

## Prerequisites
- Node.js >= 20 (tested on 20.20.1), npm 10
- Docker running, Supabase CLI via `npx supabase` (pinned 2.122.0 in devDependencies)
- Free ports: 54321–54324 (Supabase), 3000 (Next)

## Run it (exactly the graders' commands)
```bash
npx supabase start          # starts the stack from supabase/config.toml
npx supabase db reset       # rebuilds the DB from supabase/migrations/ (seed.sql is disabled on purpose)
npm install                 # also runs prisma generate (works without an env file)
cp .env.example .env.local  # replace values with `npx supabase status -o env` if they differ
npm run seed                # creates the brief's orgs, users, leases and payments through the app services
npm run build && npm start  # http://localhost:3000
```
`npm run seed` must run on a freshly reset database (it refuses otherwise).

### Environment (.env.local)
| variable | where it comes from |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `API_URL` from `npx supabase status -o env` |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | `PUBLISHABLE_KEY` (browser-safe; RLS applies) |
| `SUPABASE_SECRET_KEY` | `SECRET_KEY` (server only: seed + signed slip URLs; never sent to the browser) |
| `DATABASE_URL` / `DIRECT_URL` | `DB_URL` (Prisma connects as the `postgres` owner) |
| `GATEWAY_X_SIGNATURE_KEY` | shared HMAC key with the gateway (`test_x_signature_key` locally) |
| `SEED_PASSWORD` | password of every seeded account |
| `TEST_BASE_URL` | where the test suite calls the app (`http://127.0.0.1:3000`) |

### Seeded accounts (password `RentDemo#2026`)
| account | role | org |
|---|---|---|
| manager@northwind.test | manager | Northwind Properties |
| staff@northwind.test | staff | Northwind Properties |
| aisyah@northwind.test, ben@northwind.test, probe@northwind.test | tenant | Northwind Properties |
| manager@beta.test | manager | Beta Realty |
| chen@beta.test | tenant | Beta Realty |

## Tests
With the stack running and the DB reset (the test setup runs `npm run seed` itself if the seeded accounts are missing), and the dev server on :3000 (`npm run dev`; the test setup starts one on :3100 if nothing answers):
```bash
npm test          # ~1180 vitest tests against the real local stack (no mocks)
npm run test:tz   # the whole suite under TZ=UTC, Asia/Kuala_Lumpur and America/New_York
```
| folder | what it proves |
|---|---|
| `tests/unit` | `billing.ts` (brief's worked example, anchors/clamping, leap years, proration half-up, validation, the 16:00Z overdue boundary, ringgit parser), dates, money, error mapping, allocation |
| `tests/contract` | every route's status codes and exact JSON shapes; the seed facts (e.g. collections 2026-01..03 = `[300000, 0, 200000]`) |
| `tests/rls`, `tests/db`, `tests/storage` | RLS on every table, grants, no callable functions, the Data API matrix per role, DB constraints and append-only triggers, the `payment-slips` bucket policies and slip cleanup |
| `tests/authz` | 401 / 403 / 404 per route per seeded role, cross-org ids in bodies, cookie + Bearer, `user_metadata` escalation |
| `tests/concurrency`, `tests/webhook` | cap races, double approve, overlapping leases at the same moment, idempotency, every row of the webhook table, 10 simultaneous duplicate callbacks, MYT midnight boundary of the amount due |

Tests create their own fixture organizations and never delete them (payments and `audit_log` are append-only), so run `npx supabase db reset` before `npm run seed` if you want a database with only the brief's data.

## Firing the sample webhook
Create a bill as a tenant (Pay now in the tenant portal, or `POST /api/leases/:leaseId/gateway-bills`), then:
```bash
GATEWAY_X_SIGNATURE_KEY=test_x_signature_key node gateway-sim.mjs <bill_id> <amount_sen> true
```

## Architecture (short)
- **SQL migrations are the source of truth** (`supabase/migrations/`): tables, constraints, composite org FKs, the lease-overlap EXCLUDE constraint, RLS, grants, triggers, private functions, the `payment-slips` bucket and its policies. `prisma/schema.prisma` is pulled from the DB (`prisma db pull`), never migrated by Prisma.
- **Billing rules** live in `src/lib/billing.ts` (pure, imports nothing): schedule, proration (half up), status, ringgit parsing. The app uses it for lease creation and every status it shows.
- **Two layers of access control**: route handlers authenticate (`Authorization: Bearer` or the session cookie, via `auth.getUser()`), load the role from `memberships` / `tenants.user_id`, and answer 401 / 404 (not visible) / 403 (wrong role). Independently, RLS + column grants enforce the brief's Data API matrix for anyone calling PostgREST directly; clients can never write money tables.
- **Money writes** are plpgsql functions in the unexposed `private` schema (`record_payment`, `approve_payment`, `reject_payment`, `void_payment`, `create_gateway_bill`, `apply_gateway_callback`). Each locks the lease row `FOR UPDATE` first, so caps, allocation and approvals are serialized per lease.
- **Webhook**: raw form body → HMAC-SHA256 check with `timingSafeEqual` → `private.apply_gateway_callback`, which locks the bill row; a paid bill never changes again and `payments.gateway_bill_id` is UNIQUE, so one bill creates at most one payment.
- Time: instants are `timestamptz`, calendar facts are `date`, and "today" is always the Malaysia date (UTC+8, no DST).

More: `DECISIONS.md` (Part C answers + decision log), `REVIEW.md` (Part B), `docs/WALKTHROUGH.md`, `docs/SPEC.md`, `docs/PLAN.md`.

## Troubleshooting
- Ports busy / another Supabase project running: `npx supabase stop --all`, then `npx supabase start`.
- `db reset` fails with `DbSetupError` right after `start`: run it again.
- `npm run seed` says the database is not fresh: run `npx supabase db reset` first.

## Known issues / skipped
- **Bonus items skipped:** realtime updates on the tenant portal (the return page has a "Refresh status" button instead) and pagination of the leases list (there is a server-side `?q=` search only).
- **Slip cleanup edge cases (R20):** a failed recording deletes the uploaded slip when the request reaches the server and names it. Two narrow cases can still leave an unreferenced file in the organization's own folder: the network drops between the upload and the POST, or the POST body is not valid JSON so the path cannot be read. A second, concurrent request reusing the same slip path can also delete a slip that a not-yet-committed recording uses (D46). A periodic sweeper (delete objects older than N minutes that no `payments.slip_path` references) would close all three.
- **UI checks:** no browser automation was used. The UI was reviewed from the code and with HTTP requests as every role. Hydration-safety rules: Malaysia time is formatted by hand, with no `Intl`, and "now"-dependent values are computed after mount or passed from the server.
- **Credit after a void:** when a void reopens invoices, unapplied online money on other payments is not re-applied automatically (D14, Part C question 5).
- **Owner-level tampering:** the append-only triggers on `audit_log` and payments stop UPDATE, DELETE and TRUNCATE for every role, including the owner and `service_role`, but the database owner could still run `ALTER TABLE … DISABLE TRIGGER` (D33).

## What I would do next
- A slip sweeper job, and an explicit, audited "apply credit" action for unapplied online money.
- Realtime (Supabase channel on `payments` for the tenant's leases) and pagination on the leases list.
- Playwright tests for the UI flows in two browser timezones, plus hydration-warning checks.
- Late fees, if the business wants them, as one locked plpgsql function with a UNIQUE (invoice) constraint (see REVIEW.md for what goes wrong otherwise).
