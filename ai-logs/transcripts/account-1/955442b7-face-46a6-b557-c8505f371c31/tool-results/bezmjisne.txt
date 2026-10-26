# SPEC — options proposed by Claude, decisions made by Marwan (decision + reason per line)

Brief: BRIEF.md (verbatim copy of the portal text). Where this file and the brief disagree, the brief wins.
Timer: portal start 2026-10-26T00:48:36Z; hard end 04:48:36Z.

## What "done" means for this test
- From a fresh clone, these commands work as written: `npx supabase start && npx supabase db reset && npm install && cp .env.example .env.local && npm run seed && npm run build && npm start` (R6).
- Hidden tests pass for: billing functions under 3 TZs, the HTTP API as every seeded account (incl. cross-org + concurrent), the Data API + Storage with the publishable key + user JWTs, and the webhook (valid / forged / duplicate / concurrent / out-of-order).
- REVIEW.md (Part B), DECISIONS.md (Part C answers), README.md, ai-logs/ are in the repo.
- Priority order if short: billing (§3) → access control (§6) → payments (§4) → webhook (§5) → UI (§9).

## Requirements checklist (R-numbers; quotes are the brief's words; ⚠ = ambiguous, see Domain rules)
| R | requirement (brief words) | area |
|---|---|---|
| R1 | Roles: manager "Everything in their organization: create leases, record payments (approved immediately), approve, reject and void payments, read the audit log"; staff "Read their organization's leases, invoices and payments; record payments (these wait for a manager's approval)"; tenant "Read their own profile, leases, invoices and payments; update their own phone number; pay online" | authz |
| R2 | "A staff member or manager belongs to exactly one organization. Nobody ever sees another organization's data." | authz |
| R3 | Business timezone Asia/Kuala_Lumpur (UTC+8, no DST); "Every date and time the app shows or accepts is Malaysia time, whatever the timezone of the server or of the viewer's device." Currency MYR, 1 RM = 100 sen | dates/money |
| R4 | Local Supabase; commit supabase/config.toml, supabase/migrations/, .env.example "that lists every variable your app needs, with local values and a comment saying where each one comes from" | setup |
| R5 | `npm run seed` "creates exactly the data below on a freshly reset database, through your normal code paths (your lease creation and payment logic)"; all seeded accounts share one password | seed |
| R6 | Grader commands: `npx supabase start`, `npx supabase db reset`, `npm install`, `cp .env.example .env.local`, `npm run seed`, `npm run build && npm start` | setup |
| R7 | Seed orgs/accounts: Northwind (manager@, staff@, aisyah@ "Aisyah Rahman", ben@ "Ben Lim", probe@ "Probe Tenant"), Beta Realty (manager@beta.test, chen@beta.test "Chen Wei") | seed |
| R8 | Seed units/leases: A-12-3 Aisyah 2026-01-31..2026-07-15 RM1,500.00 dep RM3,000.00; B-05-1 Ben 2026-01-01..2026-04-15 RM1,000.29 no deposit; C-01-7 Probe 2026-02-28..2027-02-27 RM2,000.00 dep RM4,000.00; D-03-2 no lease; Beta KL-1 Chen 2026-03-15..2027-03-14 RM2,200.00 dep RM4,400.00 | seed |
| R9 | Seed payments on Aisyah: cash RM3,000.00 received 2026-01-31 10:00 MYT by manager; bank transfer RM2,000.00 received 2026-03-01 00:30 MYT by staff with slip, then approved by manager | seed |
| R10 | `src/lib/billing.ts` pure: "no I/O, no imports from Next.js, React, Supabase or Prisma, and no dependence on the timezone of the machine"; "Your app must use it, and we test it directly"; exact exported types/signatures (Contracts) | billing |
| R11 | generateSchedule validation: throw if a date "is not a real calendar date written as YYYY-MM-DD", endDate < startDate, monthlyRentSen not a positive integer, depositSen not a non-negative integer | billing |
| R12 | Deposit: if depositSen > 0 first invoice kind 'deposit', due startDate, period fields null | billing |
| R13 | Anchors: anchor k = startDate + k calendar months from the start date (never previous anchor), clamped to month's last day | billing |
| R14 | Periods: period k = anchor k .. day before anchor k+1, due on anchor k; a period for every anchor ≤ endDate | billing |
| R15 | Last period cut at endDate; if shorter than full: monthlyRentSen × days used / days in full period, rounded half up to the sen; others cost monthlyRentSen. Worked example: Aisyah period 5 = 77419 | billing |
| R16 | Order: deposit first, then rent by period index | billing |
| R17 | invoiceStatus in order: paid if paidSen ≥ amountSen; overdue if today's Malaysia date > dueDate (due 2026-03-01 → overdue at 2026-03-01T16:00:00Z, "not a moment earlier"); partially_paid if paidSen > 0; else unpaid | billing |
| R18 | parseRinggitToSen: digits, optional comma thousands (groups of exactly three), optional 1–2 decimal digits, whitespace around ignored; "1,500.50"→150050, "1.15"→115, "7"→700; throws on "", "-5", "1.234", "1e3", "RM 10", "1,23" | billing |
| R19 | Record payment (staff/manager): amount, method cash/bank_transfer, received date-time in MYT | payments |
| R20 | Bank transfer needs a slip: JPEG/PNG/PDF ≤ 5 MB in Storage; "If recording fails after the upload, the file must not be left behind." | payments/storage |
| R21 | Manager-recorded → approved immediately; staff-recorded → pending_verification | payments |
| R22 | Cap: new payment ≤ lease remaining balance (all invoices − all allocations) − sum of the lease's pending_verification payments; advance payment allowed within cap | payments |
| R23 | Approve (manager) a pending payment: re-check ≤ remaining balance at that moment, else refuse and leave pending | payments |
| R24 | Reject (manager) pending with reason ≥ 5 chars; Void (manager) approved with reason ≥ 5 chars; void removes that payment's allocations only | payments |
| R25 | "Payments are never deleted." Every approval, rejection, void and lease creation writes audit_log (who, what, when, details) | audit |
| R26 | Allocation on approval: lease invoices with something unpaid, order due date, deposit before rent, period index; fill each fully, including not-yet-due; leftover → payments.unapplied_sen (only online can have it) | payments |
| R27 | Invoice paid amount = sum of allocations; statuses computed with invoiceStatus, never stored | payments |
| R28 | Concurrency: two concurrent recordings must not exceed cap together; a payment approved twice at once is allocated once | concurrency |
| R29 | Collections report: total approved payments per calendar month of received_at in MYT, over a month range, including empty months; seed: Northwind 2026-01..03 = [300000, 0, 200000] | reports/dates |
| R30 | Pay now (tenant): API creates a gateway bill for the amount due now = unpaid amounts of the lease's invoices due on or before today's MYT date; nothing due → refuse; bill ids impossible to guess | webhook |
| R31 | Show bill id + amount; only the webhook settles a bill; /payments/return?bill_id=…&paid=true only shows the DB status and changes nothing | webhook/UI |
| R32 | Webhook POST /api/webhooks/gateway, x-www-form-urlencoded fields id, paid, paid_amount, paid_at, transaction_id, transaction_status, x_signature; "may add more fields in future" | webhook |
| R33 | Signature: all fields except x_signature, sorted by key (char code), key+value, joined "\|", HMAC-SHA256 with GATEWAY_X_SIGNATURE_KEY, lowercase hex; test vector in brief | webhook |
| R34 | Webhook table: bad/missing sig 401; unknown bill 404; paid=true & paid_amount ≠ bill amount 422; paid=true & bill pending/failed → 200, bill paid + one approved online payment received_at = paid_at, allocated; paid=true & already paid 200 none; paid=false & pending 200 → failed; paid=false & failed 200 none; paid=false & paid 200 none ("a paid bill never goes back") | webhook |
| R35 | Retries incl. same moment; "A bill creates at most one payment, ever."; "Never log the secret key or whole callback payloads." | webhook/concurrency |
| R36 | Server code authenticates + checks org and role itself on every endpoint; hidden button is not a check | authz |
| R37 | Roles from memberships table, and from tenants.user_id for tenants; never user_metadata; server uses auth.getUser()/getClaims(), not getSession() | authz |
| R38 | Other org / other tenant's record → 404; visible record but role not allowed → 403; no valid login → 401 | authz |
| R39 | IDs in request bodies untrusted: manager cannot create a lease on another org's unit or tenant | authz |
| R40 | Accept `Authorization: Bearer <access token>` as well as the session cookie | authz |
| R41 | Service role (secret) key never reaches the browser | security |
| R42 | Data API matrix (Contracts); every other insert/update/delete through Data API fails for everyone — every table, view and function (/rest/v1/rpc/...) we create; tenant portal reads own data + updates phone from the browser with supabase-js | RLS |
| R43 | audit_log append-only for every role, including service role and database owner | RLS |
| R44 | Storage: private bucket `payment-slips`, paths `<org_id>/...`; only staff/manager of that org upload; read via short-lived signed URLs; tenants/other orgs/anon cannot read, list or upload; payment slip_path must point to an existing file in its own org's folder | storage |
| R45 | HTTP API: JSON bodies, amounts integer sen, dates YYYY-MM-DD, instants ISO 8601 with offset, errors `{ "error": "message" }`; endpoint table in Contracts | API |
| R46 | Creating a lease stores the lease + exactly generateSchedule's invoices, all or nothing; same-unit leases never overlap (both dates inclusive), even concurrently → 409 | API/DB |
| R47 | Every DB object in supabase/migrations (tables, constraints, RLS, grants, functions, triggers, bucket + policies); Prisma for server data access, prisma/schema.prisma matches the DB | DB |
| R48 | Money integer sen (bigint), never float; calendar dates `date`, instants `timestamptz`; required tables/columns (Contracts) | DB |
| R49 | UI: shadcn/ui + Tailwind, toasts for every action, loading states, empty/invalid messages; TS strict without any | UI |
| R50 | Staff/manager UI: dashboard (overdue invoice count + collections last 6 months); leases list; lease page (invoices: period, due, amount, paid, status; payments with slip link); record payment (ringgit parsed with parseRinggitToSen, MYT date-time, slip upload); manager approve/reject/void with confirmation + reason | UI |
| R51 | Tenant UI: lease, invoices with statuses, payments, amount due now; Pay now shows new bill; /payments/return; edit phone | UI |
| R52 | All dates/times shown in MYT whatever the browser TZ, without hydration warnings | UI/dates |
| R53 | Part B: REVIEW.md — each problem: line(s), concrete scenario, severity, fix, most → least severe; only real problems | docs |
| R54 | Part C: DECISIONS.md — 6 answers ≤ 150 words each with file:line references | docs |
| R55 | Submission: public GitHub repo with source, config.toml, migrations, schema.prisma, seed script, .env.example, REVIEW.md, DECISIONS.md, ai-logs/, README.md (run, known issues, next steps); no real .env; env values; test account + password; summary | submission |
| R56 | Bonus (optional): create-lease form with live schedule preview; realtime tenant portal; unit tests for billing + allocation; server-side search + pagination synced with URL | bonus |

## Contracts (verbatim from the brief)
- Interface the graders call: **the brief names it** — REST route handlers (§7), `src/lib/billing.ts` imported directly (§3), PostgREST + Storage with the publishable key + user JWTs (§6), the webhook (§5). Server actions are ours (UI only) and call the same services.
- `src/lib/billing.ts` (R10):
  ```ts
  export type InvoiceKind = 'deposit' | 'rent'
  export interface ScheduledInvoice { kind: InvoiceKind; periodIndex: number | null; periodStart: string | null; periodEnd: string | null; dueDate: string; amountSen: number }
  export function generateSchedule(lease: { startDate: string; endDate: string; monthlyRentSen: number; depositSen: number }): ScheduledInvoice[]
  export type InvoiceStatus = 'paid' | 'partially_paid' | 'unpaid' | 'overdue'
  export function invoiceStatus(invoice: { dueDate: string; amountSen: number; paidSen: number }, now: Date): InvoiceStatus
  export function parseRinggitToSen(input: string): number
  ```
- Routes (R45):
  | method + path | who | success | other |
  |---|---|---|---|
  | POST /api/leases | manager | 201 `{ id }` | 400 invalid input, 409 overlaps another lease on the unit |
  | GET /api/leases/:leaseId | staff, manager, the lease's tenant | 200 shape below | |
  | POST /api/leases/:leaseId/payments | staff, manager | 201 `{ id, status }` | 400 invalid input, 422 over the cap |
  | POST /api/payments/:paymentId/approve | manager | 200 `{ status }` | 409 not pending, 422 over the remaining balance |
  | POST /api/payments/:paymentId/reject | manager | 200 `{ status }` | 400 missing reason, 409 not pending |
  | POST /api/payments/:paymentId/void | manager | 200 `{ status }` | 400 missing reason, 409 not approved |
  | POST /api/leases/:leaseId/gateway-bills | the lease's tenant | 201 `{ billId, amountSen }` | 422 nothing due |
  | GET /api/reports/collections?from=YYYY-MM&to=YYYY-MM | staff, manager | 200 `[{ month: 'YYYY-MM', collectedSen }]` one per month in order | 400 invalid range |
  | POST /api/webhooks/gateway | the gateway | see R34 | |
  Every endpoint also returns 401 / 403 / 404 per R38.
- Request bodies:
  - POST /api/leases `{ unitId: string; tenantId: string; startDate: string; endDate: string; monthlyRentSen: number; depositSen: number }`
  - POST /api/leases/:leaseId/payments `{ amountSen: number; method: 'cash' | 'bank_transfer'; receivedAt: string; slipPath?: string }`
  - POST …/reject and …/void `{ reason: string }`
- GET /api/leases/:leaseId response (invoices in allocation order):
  ```ts
  { lease: { id; unitId; tenantId; startDate; endDate; monthlyRentSen; depositSen },
    invoices: { id; kind: 'deposit'|'rent'; periodIndex: number|null; periodStart: string|null; periodEnd: string|null; dueDate; amountSen; paidSen; status: InvoiceStatus }[],
    payments: { id; amountSen; unappliedSen; method: 'cash'|'bank_transfer'|'online'; status: 'pending_verification'|'approved'|'rejected'|'voided'; receivedAt: string }[] }
  ```
- Payment statuses: `pending_verification | approved | rejected | voided`. Methods: `cash | bank_transfer | online`. Bill statuses: `pending | paid | failed`. Membership roles: `manager | staff`.
- Webhook form fields: `id, paid, paid_amount, paid_at ("2026-04-01 00:30:12 +0800"), transaction_id, transaction_status (completed|failed|pending), x_signature`; test vector key `test_x_signature_key` → `06994fab2d674e7829144eaa2204631716d3c099b503d38945e92b6296531641`.
- Return page: `/payments/return?bill_id=...&paid=true` (read-only).
- Tables / required columns (R48): organizations(id, name) · memberships(user_id, org_id, role) · units(id, org_id, name) · tenants(id, org_id, user_id, full_name, email, phone) · leases(id, org_id, unit_id, tenant_id, start_date, end_date, monthly_rent_sen, deposit_sen) · invoices(id, org_id, lease_id, kind, period_index, period_start, period_end, due_date, amount_sen) · payments(id, org_id, lease_id, amount_sen, unapplied_sen, method, status, received_at, slip_path, gateway_bill_id) · payment_allocations(id, org_id, payment_id, invoice_id, amount_sen) · gateway_bills(id, org_id, lease_id, amount_sen, status) · audit_log(id, org_id, actor_id, action, entity_id, details, created_at)
- Data API matrix (R42):
  | table | anon | tenant | staff | manager |
  |---|---|---|---|---|
  | organizations | none | read own org | read own org | read own org |
  | memberships | none | none | read own org | read own org |
  | units | none | read units of own leases | read own org | read own org |
  | tenants | none | read own row, update only phone | read own org | read own org |
  | leases, invoices, payments, payment_allocations, gateway_bills | none | read rows of own leases | read own org | read own org |
  | audit_log | none | none | none | read own org |
- Storage: bucket `payment-slips` (private), path `<org_id>/...`.
- Env vars (submission list): `NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY, DATABASE_URL, DIRECT_URL, GATEWAY_X_SIGNATURE_KEY` (+ ours: `TEST_BASE_URL`, `SEED_PASSWORD`). Env file the graders use: `.env.local` (copied from .env.example).
- npm scripts: `seed` (required), `build`, `start`, `dev`; ours: `test`, `test:tz`, `typecheck`, `postinstall: prisma generate`.
- Seed logins: manager@northwind.test, staff@northwind.test, aisyah@northwind.test, ben@northwind.test, probe@northwind.test, manager@beta.test, chen@beta.test — one shared password (Q4).
- Submission: public GitHub repo; REVIEW.md, DECISIONS.md (Part C answers), README.md, ai-logs/ (exported transcripts), .env.example; no real .env.

## Error contract (brief overrides the kit default)
- Body on error: `{ "error": "message" }` (R45) — a plain string. Rejected: kit's `{error:{code,message}}` (the brief fixes the shape).
- Check order in every handler: 401 (no/invalid token) → load the target record; not visible to the caller (other org, other tenant, nonexistent, malformed uuid) → 404 → role not allowed on a visible record (or no-record endpoint like POST /api/leases, reports) → 403 → body validation 400 → business rules 409 / 422.
- 400: malformed JSON, unknown keys (zod `.strict()`), bad types, invalid dates, invalid range. 409: overlap (23P01), not pending / not approved, idempotency key reused with a different payload. 422: over cap / over remaining balance / nothing due / webhook amount mismatch. 500: generic `{ "error": "Internal error" }`, no SQL, no stack.
- private.* plpgsql raises fixed SQLSTATEs: `P0409` conflict, `P0422` business rule, `P0404` not found, `P0400` validation; `src/lib/errors.ts` maps them + 23P01/23505 → 409, 22P02/P2023 → 400, P2025 → 404, 40001/40P01 → one retry then 409.

## Domain rules (PROPOSED unless marked "brief")
- Money: bigint sen in SQL (brief R48), `number` in TS; Prisma BigInt converted to number in ONE helper (`toSen`) that throws if not a safe integer; never floats. Single currency MYR: `currency char(3) not null default 'MYR' check (currency = 'MYR')` on leases/invoices/payments/gateway_bills (kit rule). Rejected: no currency column (kit asks for a CHECK when one currency).
- Rounding: half up, only for proration (non-negative), integer arithmetic `floor((2·rent·used + full) / (2·full))`, in ONE function `roundHalfUpDiv` inside `src/lib/billing.ts` (billing.ts must be self-contained: brief tests it directly, so it imports nothing). `src/lib/money.ts` re-exports it + `parseRinggitToSen` and adds `formatSen`. Rejected: rounding in money.ts imported by billing.ts (a grader copying/importing billing.ts alone must work; also one less module to explain).
- Dates (brief R3/R17): calendar dates are `YYYY-MM-DD` strings; month math on {y,m,d} via `Date.UTC`, never local getters. "Today in Malaysia" = `toMytDate(now)` = `new Date(now.getTime() + 8h).toISOString().slice(0,10)` (Malaysia has no DST; fixed +08:00). SQL twin: `(p_as_of at time zone 'Asia/Kuala_Lumpur')::date`. Rejected: Intl.DateTimeFormat (works too, but more surface; fixed offset is exact for MYT).
- Instants in the API: input `receivedAt` must be ISO 8601 WITH an offset or `Z` (else 400 — ambiguous); output instants formatted in MYT with offset, e.g. `2026-01-31T10:00:00+08:00`. Rejected: accepting naive strings as MYT (silent assumptions; the brief says instants carry an offset).
- Billing period = anchor-to-anchor (brief R13/R14); proration only on the last period (brief R15); start==end → one 1-day period prorated over the full period length.
- Late fee: none in Part A (only in the Part B review code) → not built.
- Payments: partial allowed; manual over cap → 422 (brief R22); online payments are never refused once captured — leftover → unapplied_sen (brief R26). Allocation order brief R26.
- Cap formula (R22): `cap = Σ invoices.amount_sen − Σ allocations.amount_sen (of non-voided payments) − Σ payments.amount_sen where status = pending_verification`; request must be `0 < amountSen ≤ cap`. Approve re-check (R23): `amount ≤ Σ invoices − Σ allocations` (pending ones excluded, per the brief's wording).
- Void (R24): deletes that payment's allocation rows, sets status voided, keeps the payment row; unapplied_sen of OTHER payments is not re-applied (brief: "Other payments' allocations do not change") — see Q3.
- Payments are never deleted (R25): a `private` trigger blocks DELETE and allows UPDATE only for the transitions pending_verification→approved/rejected, approved→voided (plus unapplied_sen/allocation bookkeeping inside the private functions); amount, method, received_at, lease, org are immutable. Rejected: kit's "refunds/voids are new rows" (the brief changes status on the same row).
- Overdue grace = 0 days (brief R17: overdue the day after dueDate). The 7-day grace exists only in the Part B review code.
- Invoice status: never stored (brief R27). Server computes with `invoiceStatus(…, asOf)` from billing.ts; dashboard overdue count also via invoiceStatus. No SQL status twin needed.
- Concurrency (R28/R35/R46): every money write locks the **lease row** `FOR UPDATE` first (cap and allocation are lease-wide), then the payment / bill row; webhook locks the bill row first then the lease (always bill → lease order; other paths never lock bills). Lease overlap: `EXCLUDE USING gist (unit_id WITH =, daterange(start_date, end_date, '[]') WITH &&)` (btree_gist). One payment per bill: partial `UNIQUE (gateway_bill_id)` on payments + bill status check under the lock. Rejected: SERIALIZABLE + retries (more 409s under load, harder to explain); advisory locks (invisible in schema).
- Money writes live in plpgsql functions in schema `private` called by server code via Prisma `$queryRaw` (owner role): `private.record_payment`, `private.approve_payment`, `private.reject_payment`, `private.void_payment`, `private.allocate_payment` (internal), `private.create_gateway_bill`, `private.apply_gateway_callback`. Lease creation = Prisma interactive transaction (lease + createMany(invoices from generateSchedule) + audit row). Each private function: revoke from public; no grant to anon/authenticated.
- Idempotency for manual payments: brief's body has no key → optional `Idempotency-Key` header (uuid); when present, UNIQUE (org_id, idempotency_key): same payload → original `{id,status}` 200, different payload → 409. Never required (see Q1). Webhook idempotency = bill state machine under `FOR UPDATE` + unique gateway_bill_id (no 5-minute replay window: brief has no timestamp field and the gateway retries).
- Webhook parsing: raw body `await req.text()` → `URLSearchParams`; duplicate keys → 400; signature over all fields except x_signature (extra fields included, R32); `timingSafeEqual` on equal-length hex buffers; 401 before anything else. Bill id that is not a uuid → 404. paid_at must match `YYYY-MM-DD HH:MM:SS ±HHMM` → converted to timestamptz; paid_amount must be `^\d+$`. Logged: bill id + outcome only. Bill outcome follows the `paid` flag only (R34); transaction_status is stored but does not drive the state machine. Bill amount compared against the bill's stored amount_sen, not a recalculated due amount. Amount due for a bill ignores pending manual payments (brief R30 wording).
- Bill ids: `gen_random_uuid()` (122 random bits). Amount due now computed in SQL under the lease lock with p_as_of; several pending bills allowed (a second paid one lands as unapplied).
- Tenant ↔ user mapping: `tenants.user_id` → auth.users, `UNIQUE (org_id, user_id)`; tenant RLS via `private.is_lease_tenant(lease_id)`; staff/manager via `private.is_org_member(org_id, roles[])` reading `memberships` with `UNIQUE (user_id)` (exactly one org, R2).
- Prisma DB role: `postgres` (owner, bypasses RLS) + `requireRole`/`requireLeaseAccess` in every service, every query scoped by the checked org_id (brief Part B says prisma connects as owner). Rejected: JWT-claims-per-transaction to make RLS apply to Prisma (slower, harder to explain).
- Composite FKs: children reference `(org_id, parent_id) → parent(org_id, id)` so a lease can never point at another org's unit/tenant (R39 also in DB). FKs into invoices/payments `ON DELETE RESTRICT`.
- audit_log: append-only by triggers (`BEFORE UPDATE OR DELETE` row trigger + `BEFORE TRUNCATE` statement trigger raising) — applies to service_role and owner (R43). Actions: `lease.created, payment.recorded, payment.approved, payment.rejected, payment.voided, gateway_bill.created, gateway_bill.paid, gateway_bill.failed`.
- Seed (R5): `npm run seed` = `tsx scripts/seed.ts`: creates auth users with the Admin API (secret key), orgs/units/tenants/memberships with Prisma, then leases via the createLease service, payments via recordPayment/approvePayment services, slip uploaded to Storage. `supabase/seed.sql` stays empty. Dates in seed are the brief's fixed dates.
- Storage (R44): bucket `payment-slips` created in a migration, `public=false`, `file_size_limit = 5242880` (5 MiB; brief says "at most 5 MB"), `allowed_mime_types = {image/jpeg,image/png,application/pdf}`. Path `<org_id>/<lease_id>/<uuid>.<ext>`. Policies on storage.objects: INSERT + SELECT for staff/manager of the org in `(storage.foldername(name))[1]`; no UPDATE/DELETE/tenant/anon policy. Browser uploads with the user's token, then POSTs slipPath; server checks the object exists in `storage.objects` under the caller's org (also re-checked in record_payment); on any recording failure the server deletes that object (secret key) if no payment references it. UNIQUE(slip_path). Slip with method cash → 400. Signed URLs (60 s) generated server-side from the DB row.

## Roles and access (RLS matrix — brief R42, plus how)
Tenancy: every business row has org_id; role from memberships(user_id, org_id, role) / tenants.user_id, never user_metadata. Money writes never go through PostgREST.
| table | manager (own org) | staff (own org) | tenant |
|---|---|---|---|
| organizations | select | select | select (org of own tenant row) |
| memberships | select | select | none |
| units | select | select | select units of own leases |
| tenants | select | select | select own row; UPDATE(phone) column grant + policy with WITH CHECK |
| leases, invoices, payments, payment_allocations, gateway_bills | select | select | select rows of own leases |
| audit_log | select | none | none |
| storage payment-slips | insert/select own org prefix | insert/select own org prefix | none |
Grants: anon nothing anywhere; authenticated SELECT on the listed tables + UPDATE(phone) on tenants only; no functions in public; private helpers granted only to authenticated. Every UPDATE policy has WITH CHECK.

## Out of scope (cut if time runs short)
- Bonus items (R56) except billing unit tests; realtime; leases list pagination. Late fees (not in Part A).

## Integration contracts (lead → lanes; names are fixed so lanes can work in parallel)
### Schema (T1, migration `supabase/migrations/20261026000001_schema.sql`)
All ids `uuid primary key default gen_random_uuid()`; every table has `created_at timestamptz not null default now()`; every parent has `unique (org_id, id)`.
- `organizations(id, name text not null)`
- `memberships(id, user_id uuid not null unique → auth.users on delete cascade, org_id → organizations, role text not null check in ('manager','staff'))`
- `units(id, org_id, name text not null, unique (org_id, name))`
- `tenants(id, org_id, user_id uuid null → auth.users on delete set null, full_name text not null, email text not null, phone text null check (phone ~ '^\+?[0-9][0-9 -]{5,19}$'), unique (org_id, user_id))`
- `leases(id, org_id, unit_id, tenant_id, start_date date, end_date date, monthly_rent_sen bigint > 0, deposit_sen bigint >= 0, currency char(3) default 'MYR' check = 'MYR', created_by uuid null; (org_id, unit_id) → units(org_id, id); (org_id, tenant_id) → tenants(org_id, id); check end_date >= start_date; EXCLUDE USING gist (unit_id WITH =, daterange(start_date, end_date, '[]') WITH &&) named `leases_no_overlap`; unique (org_id, id) and unique (id, org_id)`
- `invoices(id, org_id, lease_id, kind text check in ('deposit','rent'), period_index int null, period_start date null, period_end date null, due_date date not null, amount_sen bigint > 0, currency char(3) MYR; (org_id, lease_id) → leases ON DELETE RESTRICT; check deposit ⇒ period fields null, rent ⇒ all three not null and period_index >= 0 and period_end >= period_start; unique (lease_id, period_index); unique (lease_id) where kind = 'deposit'; unique (lease_id, id)`
- `gateway_bills(id, org_id, lease_id, amount_sen bigint > 0, status text not null default 'pending' check in ('pending','paid','failed'), currency MYR, created_by uuid null, transaction_id text null, transaction_status text null, paid_at timestamptz null, updated_at timestamptz; (org_id, lease_id) → leases RESTRICT; unique (org_id, id)`
- `payments(id, org_id, lease_id, amount_sen bigint > 0, unapplied_sen bigint not null default 0 check 0 <= unapplied_sen <= amount_sen, method text check in ('cash','bank_transfer','online'), status text check in ('pending_verification','approved','rejected','voided'), received_at timestamptz not null, slip_path text null unique, gateway_bill_id uuid null unique, idempotency_key uuid null, currency MYR, recorded_by uuid null, decided_by uuid null, decided_at timestamptz null, reason text null; (org_id, lease_id) → leases RESTRICT; (org_id, gateway_bill_id) → gateway_bills(org_id, id) RESTRICT; unique (org_id, idempotency_key); check bank_transfer ⇔ slip_path not null; check online ⇔ gateway_bill_id not null; unique (lease_id, id)`
- `payment_allocations(id, org_id, lease_id, payment_id, invoice_id, amount_sen bigint > 0; (lease_id, payment_id) → payments(lease_id, id) RESTRICT; (lease_id, invoice_id) → invoices(lease_id, id) RESTRICT; (org_id, lease_id) → leases; unique (payment_id, invoice_id)` — lease_id makes "payment and invoice on the same lease" a DB fact.
- `audit_log(id bigint generated always as identity primary key, org_id → organizations, actor_id uuid null, action text not null, entity_id uuid null, details jsonb not null default '{}', created_at timestamptz not null default now())` — append-only triggers (D19).
- Extension `btree_gist` in schema `extensions`. Schema `private`. Index every FK column and every policy column.
- Triggers (in `private`): audit_log blocks UPDATE/DELETE/TRUNCATE; payments blocks DELETE and allows UPDATE only of status/decided_by/decided_at/reason/unapplied_sen with transitions pending_verification→approved|rejected, approved→voided (D12); invoices/leases amount + date columns immutable after insert (no update path needed).
- RLS helpers (SECURITY DEFINER, `set search_path = ''`, granted to authenticated only): `private.is_org_member(p_org uuid, p_roles text[]) returns boolean`, `private.is_lease_tenant(p_lease uuid) returns boolean`, `private.is_tenant_org(p_org uuid) returns boolean`, `private.can_upload_slip(p_object_name text) returns boolean` (first folder = an org where caller is manager/staff).
- Grants: revoke all from anon/authenticated on public tables, then `grant select` on the matrix tables to authenticated, `grant update (phone) on public.tenants to authenticated`. Nothing else. Default privileges revoked for anon AND authenticated on tables/sequences/functions in public and private.
- Storage (same migration): `insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values ('payment-slips','payment-slips', false, 5242880, '{image/jpeg,image/png,application/pdf}')`; policies on storage.objects: INSERT + SELECT to authenticated where `bucket_id = 'payment-slips' and private.can_upload_slip(name)`; nothing else.

### Money functions (T4, migration `supabase/migrations/20261026000002_money.sql`)
Errors: `raise exception using errcode = 'P0400'|'P0404'|'P0409'|'P0422', message = '<human message>'` — the message becomes the API `{ "error": message }`, so it must not leak another org's data. All are `security invoker` (called by the owner via Prisma), `set search_path = ''`, `revoke execute ... from public, anon, authenticated`.
- `private.allocate_payment(p_payment_id uuid) returns void` — caller holds the lease lock; fills unpaid invoices ordered by `due_date, (kind = 'rent'), period_index nulls first`; leftover → payments.unapplied_sen.
- `private.record_payment(p_actor_id uuid, p_lease_id uuid, p_amount_sen bigint, p_method text, p_received_at timestamptz, p_slip_path text, p_idempotency_key uuid) returns table(id uuid, status text, replayed boolean)` — (1) lock lease FOR UPDATE (P0404 missing or actor not manager/staff of its org); (2) if key not null: existing (org, key) with same lease/amount/method/received_at/slip_path → return it with replayed = true, else P0409; (3) validate: method cash|bank_transfer (P0400), bank_transfer needs slip_path that exists in storage.objects (bucket payment-slips) with first folder = lease org (P0400), cash must have no slip (P0400), amount > 0 (P0400); cap = Σinvoices − Σallocations − Σpending (P0422 "Payment exceeds the remaining balance"); (4) insert with status approved if actor is manager else pending_verification; (5) if approved → allocate_payment; audit `payment.recorded` (+ `payment.approved` when manager).
- `private.approve_payment(p_actor_id uuid, p_payment_id uuid) returns table(status text)` — payment's lease FOR UPDATE, then payment FOR UPDATE; P0404 missing/other org; P0409 not pending; P0422 amount > Σinvoices − Σallocations (leave pending); set approved + decided_by/at; allocate; audit `payment.approved`.
- `private.reject_payment(p_actor_id uuid, p_payment_id uuid, p_reason text) returns table(status text)` — P0400 if length(trim(reason)) < 5; lock; P0409 not pending; set rejected + reason; audit `payment.rejected`.
- `private.void_payment(p_actor_id uuid, p_payment_id uuid, p_reason text) returns table(status text)` — P0400 reason; lock; P0409 not approved; delete its allocations; set voided + reason; audit `payment.voided` with released amount. Other payments untouched (D14).
- `private.create_gateway_bill(p_actor_id uuid, p_lease_id uuid, p_as_of timestamptz default now()) returns table(id uuid, amount_sen bigint)` — lock lease; P0404 unless actor is the lease's tenant (tenants.user_id); amount = Σ over invoices with due_date <= (p_as_of at time zone 'Asia/Kuala_Lumpur')::date of (amount − allocated); 0 → P0422 "Nothing is due"; insert pending bill; audit `gateway_bill.created`.
- `private.apply_gateway_callback(p_bill_id uuid, p_paid boolean, p_paid_amount_sen bigint, p_paid_at timestamptz, p_transaction_id text, p_transaction_status text) returns table(outcome text, payment_id uuid)` — lock bill FOR UPDATE (P0404 missing); paid and amount ≠ bill.amount_sen → P0422; paid: already paid → ('duplicate', existing payment id); else lock lease, bill → paid (+ transaction fields, paid_at), insert approved online payment (received_at = p_paid_at, gateway_bill_id), allocate, audit `gateway_bill.paid` → ('paid', id); not paid: pending → failed, audit `gateway_bill.failed` → ('failed', null); else ('ignored', null). Lock order bill → lease (D7).

### Server modules (T2, backend-engineer) — signatures other lanes import
- `src/lib/billing.ts` — the brief's exact exports (Contracts) + `export function toMytDate(now: Date): string`, `export function addMonthsClamped(startDate: string, k: number): string`, `export function roundHalfUpDiv(numerator: number, denominator: number): number`. Imports nothing.
- `src/lib/money.ts` — re-exports parseRinggitToSen + roundHalfUpDiv; `formatSen(sen: number): string` ("RM 1,500.00"); `toSen(v: bigint | number): number` (throws if not a safe integer).
- `src/lib/dates.ts` — `formatInstantMyt(d: Date): string` ISO with +08:00 (`2026-01-31T10:00:00+08:00`); `parseInstantWithOffset(s: string): Date` (throws without offset/Z); `mytLocalToIso(dateTimeLocal: string): string` (for the UI's datetime-local, "2026-01-31T10:00" → "2026-01-31T10:00:00+08:00"); `dateToIso(d: Date): string` (Prisma @db.Date → "YYYY-MM-DD"); `formatMytDisplay(d: Date): string` ("31 Jan 2026, 10:00"); `isYearMonth(s)`.
- `src/lib/errors.ts` — `class ApiError extends Error { status: number }`, helpers `badRequest/unauthorized/forbidden/notFound/conflict/unprocessable(msg)`, `toErrorResponse(e: unknown): Response` mapping ApiError, ZodError → 400, Postgres SQLSTATE P0400/P0404/P0409/P0422/23P01/23505/22P02/23503/23514/40001/40P01 (raw via Prisma's `meta.code` / driver adapter error) and Prisma P2002/P2025/P2023 per the Error contract; unknown → 500 `{ "error": "Internal error" }` + server log without payloads.
- `src/lib/prisma.ts` (REFERENCE.md), `src/lib/supabase/server.ts` (cookie client, publishable key), `src/lib/supabase/browser.ts` (`createBrowserClient`, publishable key), `src/lib/supabase/admin.ts` (secret key, `import 'server-only'`).
- `src/server/auth.ts` — `getUserId(req?: Request): Promise<string | null>` (Authorization: Bearer → `auth.getUser(token)`; else cookie client `auth.getUser()`); `requireUserId(req?)` throws 401.
- `src/server/access.ts` — `type Caller = { userId: string; member: { orgId: string; role: 'manager' | 'staff' } | null; tenantIds: string[] }`; `loadCaller(userId)`; `requireMember(caller, roles)` → 403 when not a member with a listed role; `requireLeaseAccess(caller, leaseId, roles: ('manager'|'staff'|'tenant')[])` → returns the lease row; 404 if not visible (other org, other tenant, nonexistent, malformed uuid), 403 if visible but role not listed; `requirePaymentAccess(caller, paymentId, roles)` same for payments.
- `src/server/http.ts` — `route(handler)` wrapper: catches → toErrorResponse; `readJson(req)` (400 on malformed JSON / non-object).
- Services (T5): `src/server/services/leases.ts` `createLease(ctx, input)`, `getLease(ctx, leaseId)`, `listLeases(ctx)`; `src/server/services/payments.ts` `recordPayment(ctx, leaseId, input, opts?: { idempotencyKey?: string })`, `approvePayment(ctx, paymentId)`, `rejectPayment(ctx, paymentId, input)`, `voidPayment(ctx, paymentId, input)`, `getSlipUrl(ctx, paymentId)`; `src/server/services/reports.ts` `collectionsReport(ctx, from, to)`, `overdueCount(ctx, asOf)`; ctx = `{ userId: string }`.
- UI mutations call the REST routes with fetch (same code path the graders test); server components call services directly (D28).
