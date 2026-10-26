# WALKTHROUGH — where everything lives and why

For the 30-minute code walkthrough. Each section gives the entry point (file:line), the decision id (DECISIONS.md), the alternative I rejected, and the questions I expect, with my answers.

## 1. Billing functions (money + dates) — `src/lib/billing.ts`
- **Entry points:** `generateSchedule` (:114), `invoiceStatus` (:178), `parseRinggitToSen` (:188), `roundHalfUpDiv` (:94), `addMonthsClamped` (:85), `toMytDate` (:172).
- **Decisions:**
  - D4: the file imports nothing, so graders can test it directly.
  - D5: "today" is the UTC instant + 8 h. Malaysia has no daylight saving, so one fixed offset is exact.
  - D40: a 0-sen rent invoice is allowed when the last period rounds to 0.
- **Rejected:** floating-point math and `Date` parsing of `YYYY-MM-DD` in the local zone. Calendar math runs on integer y/m/d day numbers, and rounding is integer half-up: `floor((2n + d) / 2d)`.
- **Likely questions:**
  - *What if the lease starts on the 31st?* Each anchor is computed from the start date, never from the previous anchor, and clamped to the month's last day: Jan 31 → Feb 28/29 → Mar 31.
  - *Where can a float sneak in?* Nowhere. Amounts are safe integers, the parser does string-to-integer math (no `parseFloat`), and proration is a single integer division rounded half up.
  - *Why is due 2026-03-01 not overdue at 15:59:59Z?* That instant is 23:59:59 on 1 March in Malaysia. `toMytDate` gives `2026-03-01`, which is not after the due date.
- **Tests:** `tests/unit/billing.test.ts` (worked example, clamping, leap years, validation, the 16:00Z boundary, parser tables), run under 3 timezones.

## 2. Database, RLS, Storage — `supabase/migrations/`
- **Entry points:**
  - Schema, constraints and composite foreign keys: `20261026000001_schema.sql`. The lease-overlap `EXCLUDE` is at :84.
  - RLS helpers: :330–358. Policies start at :381.
  - Append-only triggers: :221, :236, :295.
  - Hardening (no slip `SELECT`, no `service_role` writes): `20261026000003_hardening.sql`.
- **Decisions:**
  - D17: staff and managers are in `memberships` with `UNIQUE (user_id)`; tenants are matched through `tenants.user_id`.
  - D19 / D33: `audit_log` and payments are append-only through triggers set to `ENABLE ALWAYS`.
  - D31 / D32: integrity rules enforced in the database.
  - D50: slips are read only through the server's 60-second signed URL.
  - D51: `service_role` has no writes on public tables.
- **Rejected:** checks in TypeScript only, and storage read policies.
- **Likely questions:**
  - *Can a manager create a lease on another org's unit?* The service returns 404 (D15). Independently, the composite foreign key `(org_id, unit_id) → units(org_id, id)` makes such a row impossible.
  - *Can a tenant change their full name through the Data API?* No. Only `UPDATE(phone)` is granted, and the policy checks `user_id = auth.uid()` in both USING and WITH CHECK.
  - *How is `audit_log` append-only for the owner?* `BEFORE UPDATE/DELETE` and `BEFORE TRUNCATE` triggers raise P0409, and they fire even under `session_replication_role = replica`.
- **Tests:** `tests/rls/catalog.test.ts`, `tests/rls/data-api.test.ts`, `tests/db/constraints.test.ts`, `tests/storage/*.test.ts`.

## 3. Server-side authorization — `src/server/auth.ts`, `src/server/access.ts`
- **Entry points:**
  - `getUserId` (auth.ts:20): an `Authorization: Bearer` header if present, otherwise the cookie; identity always comes from `auth.getUser()`.
  - `loadCaller` (access.ts:27).
  - `requireLeaseAccess` / `requirePaymentAccess` (:60, :66): 404 when the record isn't visible, 403 when the role is wrong.
- **Decisions:**
  - D2 / D42: the check order is 401 → 404 → 403 → 400 → 409/422.
  - D18: Prisma connects as the owner, so every query is scoped by the organization that was checked.
  - D58: an invalid Bearer token gives 401 with no fallback to the cookie.
- **Rejected:** applying RLS to Prisma through per-request JWT claims.
- **Likely questions:**
  - *A tenant sets `user_metadata.role = 'manager'`?* Nothing changes. Roles are read only from `memberships` and `tenants.user_id` (tests/authz/escalation.test.ts).
  - *Why 404 and not 403 for another org's lease?* So the API never reveals that the record exists (R38).
- **Tests:** `tests/authz/*.test.ts`.

## 4. Payments, cap, allocation, concurrency — `supabase/migrations/20261026000002_money.sql`
- **Entry points:**
  - `record_payment` (:79): lease lock at :107–113, cap at :186–188.
  - `lock_payment_for_manager` (:252): lease, then payment.
  - `approve_payment` (:296), `reject_payment` (:342), `void_payment` (:378).
  - `allocate_payment` (:11): order at :55.
  - Services: `src/server/services/payments.ts`.
- **Decisions:**
  - D7: lease row `FOR UPDATE` first.
  - D13: the cap and the approve re-check follow the brief's wording.
  - D14 / D37: a void touches only its own allocations.
  - D36 / D57 / D62: the optional `Idempotency-Key`.
  - D41: the functions refuse to run unless the isolation level is READ COMMITTED.
- **Rejected:** SERIALIZABLE with retries, advisory locks, and a required idempotency key.
- **Hard stop (b), my answer (D7):** both requests call `private.record_payment`, which first takes the lease row `FOR UPDATE`. The second blocks until the first commits, and only then computes the cap, which now subtracts the first RM 800 as pending: 200 is left, so the RM 700 gets 422.
- **Likely questions:**
  - *Approve twice at once?* Both lock the lease, then the payment. The second sees `approved` → 409, so the payment is allocated once.
  - *Why not lock the invoices?* The cap and the allocation cover the whole lease, so locking the lease serializes exactly the work that has to happen one at a time.
  - *Slip left behind?* Every failure after the upload deletes that slip, scoped to the caller's own org folder and only when no payment references it. One narrow race remains (D46, known limitation).
- **Tests:** `tests/concurrency/payments.test.ts` (each race run 5 times), `tests/contract/payments-*.test.ts`, `tests/storage/slip-cleanup.test.ts`.

## 5. Online payments + webhook — `src/server/services/webhook.ts`, `money.sql:493`
- **Entry points:**
  - `handleGatewayCallback` (webhook.ts:133).
  - `verifySignature` (:53): sorted by key, `key+value` joined by `|`, HMAC-SHA256, `timingSafeEqual`.
  - `apply_gateway_callback` (money.sql:493): bill `FOR UPDATE` at :516–522, the `duplicate` check at :537–539.
  - `create_gateway_bill` (:421), using the Malaysia date at :462.
- **Decisions:**
  - D10: dedupe uses the bill state machine plus `UNIQUE (payments.gateway_bill_id)`.
  - D11 / D53: the check order is 401 → 404 → 422 → state machine.
  - D52: a repeated key gives 401.
  - D54: logs carry only the bill id and the outcome.
  - D55: the return page is read-only.
- **Rejected:** a `webhook_events` table keyed by `transaction_id` (the simulator creates a new transaction id on every run), and a 5-minute replay window (the callback carries no signed timestamp, and the gateway retries).
- **Hard stop (c), my answer (D10):** both deliveries lock the bill row. The second waits, re-reads it, sees `paid` and returns `duplicate` (200, no effect). `payments.gateway_bill_id` is UNIQUE, so even without that check the database refuses a second payment. That is two independent guarantees.
- **Likely questions:**
  - *paid=false after paid?* It gives 200 `ignored`. The guard trigger also forbids `paid → anything`.
  - *What if the invoices were already paid by cash?* The online payment is still recorded; it is never rejected, and the whole amount lands in `unapplied_sen`.
  - *Can bill ids be guessed?* No. They are `gen_random_uuid()`, 122 random bits.
- **Tests:** `tests/webhook/gateway.test.ts` (every row of the brief's table, 10 concurrent duplicates, extra fields, out of order), `tests/webhook/gateway-bill-boundary.test.ts`.

## 6. Collections report + timezones
- **Entry point:** `collectionsReport` (src/server/services/reports.ts:19). The SQL uses `generate_series` over months, left-joined to approved payments grouped by `received_at at time zone 'Asia/Kuala_Lumpur'`.
- **Decisions:** D25 (empty months appear; your requirement), D49 / D56 (range limits).
- **Likely question:** *Why is the 2026-03-01 00:30 MYT transfer counted in March?* Because the month is taken in Malaysia time: in UTC it is 2026-02-28 16:30, which would put it in February.
- **Tests:** `tests/contract/reports-collections.test.ts`, `tests/contract/seed.test.ts`.

## 7. UI
- **Staff and managers:** `src/app/(app)/dashboard`, `src/app/(app)/leases`, `src/components/staff/*`.
- **Tenants:** `src/app/(app)/tenant` and `src/components/tenant/*`, which read through supabase-js under RLS (D60). `/payments/return` is read-only.
- **Malaysia time:** amounts are parsed with `parseRinggitToSen`, the Received-at input is converted with `mytLocalToIso`, and times are displayed with `formatMytDisplay` (built by hand, no Intl, so server and client match).

## R-number → implementation → test
| R | implementation | test |
|---|---|---|
| R10–R18 | src/lib/billing.ts | tests/unit/billing.test.ts |
| R3, R52 | src/lib/dates.ts, billing.ts toMytDate | tests/unit/dates.test.ts, TZ matrix |
| R5, R7–R9 | scripts/seed.ts | tests/contract/seed.test.ts |
| R19–R28 | money.sql record/approve/reject/void/allocate, services/payments.ts | tests/contract/payments-*.test.ts, tests/concurrency/payments.test.ts |
| R29 | services/reports.ts | tests/contract/reports-collections.test.ts |
| R30–R35 | money.sql create_gateway_bill/apply_gateway_callback, services/gateway.ts, webhook.ts | tests/webhook/*.test.ts |
| R36–R41 | src/server/auth.ts, access.ts, routes | tests/authz/*.test.ts |
| R42–R44, R47, R48 | migrations 0001 + 0003 | tests/rls/*.test.ts, tests/db, tests/storage |
| R45, R46 | src/app/api/**, services/leases.ts, leases_no_overlap | tests/contract/*.test.ts, tests/concurrency |
| R49–R52 | src/app/(app)/**, src/components/** | panel review (no browser automation) |
| R53, R54 | REVIEW.md, DECISIONS.md | independent false-positive check (Phase B, T13) |

## What was cut, and why
- Realtime tenant updates (bonus): left out for time. The tenant uses "Refresh status" on the return page instead.
- Pagination of the leases list (bonus): only a server-side `?q=` search was added.
- Browser-level UI checks (hydration, toasts): no browser automation was allowed in this build, so the UI was reviewed by reading the code and with curl as each role.
