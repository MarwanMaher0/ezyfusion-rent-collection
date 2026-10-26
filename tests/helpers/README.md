# Test helpers (owned by test-engineer; signatures are stable, ask the lead before changing one)

Run anything that touches the DB as `bash ../scripts/with-db.sh npx vitest run <path>` from `./app`.
Env comes from `.env.local` (then `.env`) via `vitest.config.mts`. `tests/setup/global.ts` points
`TEST_BASE_URL` at a live Next server (3000, else it starts `next dev -p 3100` and stops it after).
Test files run one at a time (`fileParallelism: false`); tests inside a file are sequential unless you use `Promise.all`.

| module | export | what it does |
|---|---|---|
| `env.ts` | `env.supabaseUrl / publishableKey / secretKey / databaseUrl / gatewayKey / seedPassword / baseUrl` | typed, lazy env getters (throw if missing) |
| `clients.ts` | `anonClient()` | supabase-js with the publishable key, no user |
| | `userClient(accessToken)` | publishable key + `Authorization: Bearer <token>` (PostgREST, RPC, Storage as that user) |
| | `adminClient()` | secret key (setup only: auth admin, storage cleanup) |
| `db.ts` | `pool()`, `sql<T>(text, params)` | pg pool on DATABASE_URL as `postgres` (bypasses RLS). int8 -> number (throws if unsafe), date -> `"YYYY-MM-DD"` string. Call `closePool()` in `afterAll` |
| | `newConnection(): Promise<pg.Client>` | a separate connected session for race tests; `await c.end()` yourself |
| `seeded.ts` | `SEEDED` | key -> email of the 7 brief accounts: `northwindManager, northwindStaff, aisyah, ben, probe, betaManager, chen` |
| | `signIn(email, password = SEED_PASSWORD, { fresh? }) -> { userId, email, accessToken }` | real password grant; cached in memory + `node_modules/.cache` while the token has >10 min left and its auth.sessions row still exists. `fresh: true` for a test that signs out |
| | `seeded(key)`, `ctxFor(key) -> { userId }` | sign in a seeded account / ctx for calling services directly |
| `http.ts` | `api(token?)` -> `{ get(path), post(path, body?), request(method, path, body?) }` | route handlers over HTTP with `Authorization: Bearer`, `redirect: 'manual'`; returns `{ status, body, headers }` (body = parsed JSON, else text). A string body is sent verbatim. `opts.headers` adds headers (e.g. `Idempotency-Key`) |
| | `postForm(path, fields | pairs)` | x-www-form-urlencoded POST, no auth (webhook) |
| `gateway.ts` | `gatewaySignature(fields, key?)`, `gatewayPaidAt(date)`, `signedCallback(billId, amountSen, paid, extra?, key?)` | brief §5 signature written independently of the app |
| `fixtures.ts` | `createFixtureOrg({ name?, units = 2, lease?, leaseTenant = 'A' }) -> FixtureOrg` | fresh org: manager + staff memberships, units, tenants A/B linked to fresh auth users (`*@fixture.test`, SEED_PASSWORD, signed in). `lease` inserts a lease on `unitIds[0]` + exactly `generateSchedule(lease)` invoices. Returns `{ orgId, orgName, unitIds, tenantAId, tenantBId, users: {manager, staff, tenantA, tenantB}, tokens: {...}, lease?: { id, ..., invoices: [{ id, ...ScheduledInvoice }] } }` |
| | `insertLease(orgId, unitId, tenantId, lease, createdBy?)`, `insertUnit(orgId, name?)`, `insertTenant(orgId, userId, fullName, email)`, `createFixtureUser(label)` | building blocks (direct pg, no audit rows) |
| `time.ts` | `asOf(isoWithOffset)`, `mytAt(date, "HH:MM[:SS]")`, `mytMidnight(date)`, `mytEndOfDay(date)` | deterministic instants; `asOf` rejects naive strings |
| `contract.ts` | `errorBody`, `idBody`, `recordPaymentBody`, `statusBody`, `leaseDetail` (+ `leaseDto`/`invoiceDto`/`paymentDto`), `collectionsBody` | strict zod schemas of SPEC's HTTP bodies, written from SPEC (never imported from the app) |
| | `uploadSlip(token, orgId, leaseId) -> path` | uploads a real PDF to `payment-slips/<org>/<lease>/<uuid>.pdf` as that user (UI path); throws if Storage refuses |

`tests/setup/global.ts` also runs `npm run seed` once when `manager@northwind.test` is missing from auth.users
(fast gate: reset, then tests), and fails setup if the seed fails.

Fixtures are never deleted (D29: payments and audit_log are append-only); use random names.
Never insert payments/allocations directly to set up a scenario you then assert on: go through the API or the
`private.*` functions so the rows are the ones the app would produce.
