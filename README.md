# Rent Collection — EzyFusion technical assessment

Part of a rent collection module for Malaysian property managers: leases, invoices, cash / bank-transfer / online payments, and access control for manager / staff / tenant.
Stack: Next.js 16 (App Router) + TypeScript, local Supabase (Postgres, Auth, Storage, RLS), Prisma 7, shadcn/ui + Tailwind.

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
With the stack running, the DB reset + seeded, and the dev server on :3000 (`npm run dev`; the test setup starts one on :3100 if nothing answers):
```bash
npm test          # vitest: unit (billing), contract, RLS/Data API, storage, authz, concurrency, webhook
npm run test:tz   # the whole suite under TZ=UTC, Asia/Kuala_Lumpur and America/New_York
```

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
_(filled in at the end of the build)_

## What I would do next
_(filled in at the end of the build)_
