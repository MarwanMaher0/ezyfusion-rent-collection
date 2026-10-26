# DECISIONS — Part C answers (then the full decision log)

Line numbers refer to this repository at submission time.

## 1. The same paid=true callback twice, 5 ms apart
Both requests go through `handleGatewayCallback` (src/server/services/webhook.ts:133). Each verifies the HMAC (`verifySignature`, :53), checks that the bill exists, and calls `private.apply_gateway_callback` (:112) in one transaction.
The first locks the bill row `FOR UPDATE` (supabase/migrations/20261026000002_money.sql:522). The second blocks on that lock.
The first sees `pending`, sets the bill `paid` (:550), inserts the online payment with `received_at = paid_at` (:555), allocates it and commits.
The second then gets the lock, re-reads the bill, sees `status = 'paid'` (:537) and returns `duplicate`. That is 200 with no effect.
The guarantee is the row lock plus that status check. `payments.gateway_bill_id` is also UNIQUE (20261026000001_schema.sql:155) and the insert uses `on conflict do nothing` (:558–564), so even without the lock a second payment for one bill cannot exist.
Tested in tests/webhook/gateway.test.ts: 10 simultaneous deliveries create one payment.

## 2. RM 800 and RM 700 at the same moment, RM 1,000 remaining
Both calls reach `private.record_payment`, which first takes the lease row `FOR UPDATE` (money.sql:107–113, D7). One request, say RM 800, gets the lock. It computes the cap after the lock (:186–188): 1,000 − 0 allocated − 0 pending = 1,000, so RM 800 is accepted as `pending_verification` and commits.
The second request was blocked on the same lease row. READ COMMITTED gives its next statement a fresh snapshot, so its cap is 1,000 − 800 pending = 200, and RM 700 gets P0422, which is HTTP 422.
Because the cap is always computed after the lock, never before, both cannot be accepted, whichever request arrives first. The functions also refuse to run at any other isolation level (D41).
Tested in tests/concurrency/payments.test.ts over HTTP, 5 rounds.

## 3. Every place that works out "today" or converts date ↔ instant
Malaysia is UTC+8 with no daylight saving, so one fixed offset is exact whatever the server or browser zone.
- `toMytDate` (src/lib/billing.ts:172) gives today in Malaysia. It is used by `invoiceStatus` (:178) for overdue, by `overdueCount` (src/server/services/reports.ts:61), the dashboard month range (src/app/(app)/dashboard/page.tsx:71) and the tenant's amount due now (src/components/tenant/lease-section.tsx:115).
- SQL today for a gateway bill is `(p_as_of at time zone 'Asia/Kuala_Lumpur')::date` (money.sql:462).
- Collections group by `received_at at time zone 'Asia/Kuala_Lumpur'` (reports.ts:39).
- Inputs: `parseInstantWithOffset` (src/lib/dates.ts:40) requires an offset. `mytLocalToIso` (:59) reads the form's datetime-local as +08:00. The webhook's `paid_at` keeps its own offset (webhook.ts:66).
- Outputs: `formatInstantMyt` and `formatMytDisplay` (dates.ts:32, :77). `dateToIso` (:70) reads Prisma's UTC-midnight `date` values.

## 4. Queries not subject to RLS, and what authorizes them instead
- **Prisma connects as `postgres`.** Every route first authenticates with `auth.getUser()` (src/server/auth.ts). It then loads the role from `memberships`/`tenants.user_id` with `loadCaller` (src/server/access.ts:27). Then `requireMember`, `requireLeaseAccess` or `requirePaymentAccess` (:37, :60, :66) returns 404 when the record isn't visible and 403 when the role is wrong. Queries are scoped by the org that check returned.
- **The private plpgsql money functions run as the owner.** They also re-check the actor: manager or staff of the lease's org, the tenant for bills, a manager for decisions. They are not executable by anon or authenticated.
- **The SECURITY DEFINER RLS helpers** (schema.sql:331–358) only answer "is the caller a member or tenant?" from `auth.uid()`, and use `search_path = ''`.
- **The secret-key client** is used only by the seed, slip deletion and the 60-second signed URLs (payments.ts:55, :196). Both payment uses run after `requirePaymentAccess`, and the path is read from the database row.

## 5. A void reopens invoices while an online payment still has unapplied_sen
Nothing moves automatically. `void_payment` deletes only the voided payment's allocations (money.sql:399) and marks it `voided` (:406). The reopened invoices show as unpaid or overdue again. The other payment's `unapplied_sen` stays as it was.
I chose this because the brief says "Other payments' allocations do not change". Re-applying the credit would change another payment's allocations without anyone deciding to (D14, D37).
It also keeps a void predictable and auditable: the `payment.voided` audit row records exactly what was released, and nothing else changes. Staff can see both the reopened balance and the credit on the lease page. Applying credit to reopened invoices would be an explicit, audited manager action, which I would add next.

## 6. Two things the AI assistant got wrong, and how I noticed
1. **Empty months in the collections report.** The spec Claude drafted at hard stop (a) listed the report but never said that months with nothing collected must appear. Reviewing it against the brief's seed example `[300000, 0, 200000]`, I required `generate_series` over Malaysia months (D25, my approval message at hard stop a; implemented in src/server/services/reports.ts:26-49).
2. **Relying on Next.js not to inline the secret key.** The plan had services import the secret-key client from a file without a `server-only` marker (D44). A leaked secret key is an instant fail, so I required a build-time scan of `.next/static` for the key's value as a gate step (D47, my message at hard stop b).
3. Smaller: the seed password `RentDemo#2026` was written unquoted, and dotenv cut it at `#`. My review agent caught it (Phase A, T5 review).

---

## Decision log
Format: `D<n> · what · why · rejected alternative · decided-by`.

D1 · Interface the graders call = REST route handlers (§7) + src/lib/billing.ts + PostgREST/Storage + webhook · the brief names all four · server-actions-only API · brief  
D2 · Error body `{ "error": "message" }`; order 401 → 404 (not visible) → 403 (role) → 400 → 409/422 · brief §6/§7 fix shape and codes · kit `{error:{code,message}}` · brief (conflict with kit, reported)  
D3 · Money bigint sen in SQL, number in TS via one toSen() helper (throws if unsafe); MYR only with currency char(3) CHECK = 'MYR' · brief §8 says bigint; kit wants a currency CHECK · integer columns / no currency column · Marwan  
D4 · billing.ts self-contained (imports nothing), holds the single half-up rounding function; money.ts re-exports it · graders import billing.ts directly and it must be pure · rounding in money.ts imported by billing.ts · Marwan  
D5 · "Today in Malaysia" = UTC instant + 8 h, date part; SQL twin `(p_as_of at time zone 'Asia/Kuala_Lumpur')::date`; overdue grace 0 · MYT has no DST; brief R17 boundary is 16:00Z · Intl.DateTimeFormat per call; 7-day grace (only in Part B code) · Marwan  
D6 · receivedAt input must carry an offset or Z (else 400); instants output as `…+08:00` · brief: instants are ISO 8601 with an offset · naive strings read as MYT · Marwan  
D7 · Lock the lease row FOR UPDATE first in every money write (record/approve/reject/void/bill create/settle); webhook locks bill → lease · cap and allocation are lease-wide; one fixed order prevents deadlocks · SERIALIZABLE + retry, advisory locks · Marwan — hard stop (b) answer (Marwan, verbatim): "both requests call private.record_payment, which first takes the lease row FOR UPDATE (money.sql:107-113). The second request blocks on that lock until the first commits. Only then does it compute the cap (lines 186-188), and the cap now subtracts the first RM 800, which is pending_verification, so only RM 200 is left and the RM 700 gets 422. The cap is always computed after the lock, never before, so the two can't both pass."  
D8 · Money writes are plpgsql functions in `private`, called by server code (Prisma as postgres) after requireRole; no grants to anon/authenticated · one transaction per operation, not reachable through PostgREST · Prisma-only TS transactions · Marwan  
D9 · Manual payment idempotency: OPTIONAL `Idempotency-Key` header (uuid), UNIQUE (org_id, idempotency_key), replay → original, other payload → 409 · brief body has no key, so requiring one would 400 every grader call · kit rule "required uuid" · Marwan  
D10 · Webhook dedupe = bill state machine under bill FOR UPDATE + partial UNIQUE (payments.gateway_bill_id); no webhook_events table, no 5-minute replay window · brief: "a bill creates at most one payment, ever"; simulator makes a new transaction_id each run; no signed timestamp · dedupe on (provider,event_id)/transaction_id; replay window · Marwan — hard stop (c) answer (Marwan, verbatim): "both deliveries call private.apply_gateway_callback, which locks the bill row FOR UPDATE (money.sql:516-522). The second delivery waits on that lock. When it gets the lock it re-reads the bill, sees status = 'paid' (:537-539) and returns duplicate with 200 and no effect. Even if that check were ever bypassed, payments.gateway_bill_id is UNIQUE (schema.sql:155), so the database itself refuses a second payment for one bill. That is two independent guarantees."  
D11 · Webhook state follows the `paid` flag; amount compared with the bill's stored amount_sen; 422 on mismatch even though money is "captured" · brief table R34 · kit "never reject captured money" · brief  
D12 · Payments never deleted: trigger blocks DELETE and allows only pending→approved/rejected and approved→voided status updates; other columns immutable · brief changes status in place · kit "voids are new rows" · Marwan  
D13 · Cap = Σinvoices − Σallocations − Σpending; approve re-check = Σinvoices − Σallocations (pending ignored); bill amount due ignores pending · brief wording R22/R23/R30 · subtract other pending at approval · Marwan  
D14 · Void leaves other payments' unapplied_sen untouched (no auto re-allocation) · brief: "Other payments' allocations do not change" · re-apply credit to reopened invoices · Marwan  
D15 · Cross-org unitId/tenantId in POST /api/leases body → 404 · brief: records in another org get 404, never reveal existence · 400/422 · Marwan  
D16 · Lease overlap = EXCLUDE USING gist (unit_id =, daterange(start,end,'[]') &&) → 23P01 → 409 · race-proof in the DB · SELECT-then-INSERT check · Marwan  
D17 · Tenants map via tenants.user_id UNIQUE(org_id,user_id); staff/manager via memberships UNIQUE(user_id) · brief §6 + "exactly one organization" · UNIQUE(user_id, org_id) · Marwan  
D18 · Prisma connects as postgres (owner, bypasses RLS); every service does requireRole + scopes by checked org_id · brief Part B states this setup · per-request JWT claims to apply RLS to Prisma · Marwan  
D19 · audit_log append-only via BEFORE UPDATE/DELETE row trigger + BEFORE TRUNCATE trigger (applies to owner and service_role) · brief R43 · revoke-only (owner bypasses grants) · Marwan  
D20 · Seed = `npm run seed` → tsx scripts/seed.ts using Admin API + the real services; supabase/seed.sql empty · brief: "through your normal code paths" · seed.sql inserts · brief (conflict with kit, reported)  
D21 · Env file `.env.local` (brief); prisma7.config.ts + seed load `.env.local` then `.env` via dotenv `config({ path: ['.env.local', '.env'] })` · grader runs `cp .env.example .env.local` · `.env` · brief (conflict with kit)  
D22 · Slip storage: bucket payment-slips private, 5 MiB, jpeg/png/pdf; path `<org_id>/<lease_id>/<uuid>.<ext>`; staff/manager INSERT+SELECT own org folder; server verifies storage.objects row in caller org, deletes on failure; UNIQUE(slip_path); slip on cash → 400 · brief §4/§6 · server-side upload via our API · Marwan  
D23 · Submitted DECISIONS.md = Part C answers first, then this log; transcripts in app/ai-logs/ · brief §Part C + Submission · kit log only / session-logs/ · Marwan  
D24 · Seed password RentDemo#2026 shared by all accounts (SEED_PASSWORD in .env.example) · brief asks for one password · — · Marwan  
D25 · Collections report returns every month in [from, to] via generate_series over MYT months, left-joined to approved payments grouped by (received_at at time zone 'Asia/Kuala_Lumpur') month · brief example [300000, 0, 200000] includes the empty month · GROUP BY only (drops empty months) · Marwan  
D26 · The UI always sends receivedAt with an explicit +08:00 offset (datetime-local input interpreted as MYT, never the browser zone) · server rejects naive instants (D6) · new Date(input).toISOString() in the browser zone · Marwan  
D27 · cacheComponents: false in next.config.ts · create-next-app 16 sets true, which fails next build on pages that read cookies · keep true · kit rule (Marwan, pre-exam)  
D28 · UI mutations call the REST routes with fetch (cookie session); server components read through the same services; no separate server actions · one code path, which the hidden tests exercise · server actions duplicating each route · Marwan  
D29 · Test fixtures (orgs/users created by tests) are not deleted: audit_log and payments are append-only by design, so fixture orgs stay until the next db reset; tests use fresh random orgs so they never collide · brief R25/R43 forbid deleting them · per-test cleanup (impossible without breaking append-only) · Marwan  
D30 · backend-engineer may run ../scripts/db-reset.sh (exclusive lock) only to test npm run seed on a fresh DB, on the lead's order · the seed must be proven on a fresh DB and it lives in the backend lane · lead runs every seed check · Marwan  
D31 · invoices: one constraint UNIQUE NULLS NOT DISTINCT (lease_id, period_index) replaces unique(lease_id, period_index) + partial unique deposit · same guarantee (one deposit = null index, one rent per period) and Prisma 7 accepts it · two separate uniques (Prisma P1012) · Marwan  
D32 · Extra DB integrity: rent due_date = period_start; only online payments may have unapplied_sen; slip_path must start with org_id/; gateway_bills guard (no delete, amount/lease immutable, pending→paid|failed, failed→paid, settlement facts immutable once paid); lease/invoice money+date columns immutable · invariants live in the DB, not only TS · TS-only checks · Marwan  
D33 · Append-only triggers are ENABLE ALWAYS (fire even under session_replication_role=replica); the owner could still DISABLE TRIGGER, which no DB mechanism can stop · R43 · revoke-only · Marwan  
D34 · Staff/manager can also SELECT slips with their own token (storage SELECT policy); the app itself serves 60-second signed URLs built from payments.slip_path · brief allows staff/managers to read; signed URL creation needs it · INSERT-only policy · Marwan  
D35 · private.lock_payment_for_manager is shared by approve/reject/void: unlocked read of lease_id → lease FOR UPDATE → manager check → payment FOR UPDATE; non-managers get P0404 in SQL, the service answers 403 for same-org staff before calling SQL · one lock order (D7) · per-function copies · Marwan  
D36 · Idempotency comparison = lease, amount, method, received_at (instant equality), slip_path; replay returns the original even if it is now approved/rejected/voided · D9 · comparing the raw JSON · Marwan  
D37 · Voiding an online payment is allowed; its allocations are deleted, unapplied_sen stays on the voided row as history, and every credit/total sums only status = 'approved' · R24 applies to any approved payment · forbid voiding online payments · Marwan  
D38 · Webhook settlement writes gateway_bill.paid AND payment.approved (actor null) audit rows · brief: "every approval … writes a row" · gateway_bill.paid only · Marwan  
D39 · Reusing a slip already attached to another payment → 400 'Slip already used' · route table lists 400 for invalid input · 409 · Marwan  
D40 · Rent invoices may be 0 sen when a tiny last period rounds to 0 (deposit stays > 0) · the brief stores exactly generateSchedule's output · reject the lease (500/400) · Marwan  
D41 · Money functions refuse to run outside READ COMMITTED (P0409) · the cap is computed after the lease lock and relies on a fresh per-statement snapshot · document only · Marwan  
D42 · Route check order 401 → 404/403 → 400: record/reject/void/create-lease routes run an authorization pre-check before parsing the body · so a tenant or another org gets 404/403 even with malformed JSON · parse first · Marwan  
D43 · Error message wording: zod → 'Invalid input: <path>: <msg>'; 23505 → 409 'Conflict with an existing record'; SQL P04xx messages are passed through (written by us, never other-org data) · stable, non-leaking messages · raw DB messages · Marwan  
D44 · services load the secret-key storage client from src/lib/supabase/admin-client.ts (no 'server-only' marker, so tsx seed and vitest can import it); admin.ts re-exports it behind 'server-only'; no client component imports either, and the key is not NEXT_PUBLIC so it can never be inlined in a browser bundle · R41 + the seed must run under tsx · tsx --conditions=react-server · Marwan  
D45 · Tests run files serially (fileParallelism false) against fresh random fixture orgs; seeded sessions cached · deterministic races + GoTrue rate limit · parallel files · Marwan  
D46 · Narrow slip-cleanup race (a failing request may delete a slip that a concurrent, uncommitted request on the same path is using) left as a known limitation · needs two requests reusing one slip path at the same instant · cleanup under the lease lock · Marwan  
D47 · Full gate adds a secret-leak check: after npm run build, grep -r the SUPABASE_SECRET_KEY value in .next/static must find nothing · a leaked secret key is an instant fail; D44 relies on the missing NEXT_PUBLIC_ prefix · trust the prefix only · Marwan  
D48 · Seed freshness check refuses only when the brief's organizations (Northwind Properties / Beta Realty) already exist, so test fixture orgs do not block a re-seed · tests leave fixture orgs (D29) · refuse on any organization row · Marwan  
D49 · Collections range at most 1200 months (was 120), else 400 'Invalid range' · bounds generate_series without rejecting realistic ranges; panel flagged the unlogged 120 · no limit · Marwan  
D50 · Drop the storage SELECT policy on payment-slips: slips are read only through the server's 60-second signed URL built from payments.slip_path; staff/manager keep INSERT · panel: staff could mint a 10-year signed URL with their own token · keep SELECT (supersedes D34) · Marwan  
D51 · Revoke insert/update/delete/truncate on public tables from service_role (keep select) · brief: every other write through the Data API fails for everyone; the app never writes through service_role · keep Supabase defaults · Marwan  
D52 · Webhook: a repeated key → 401 'Invalid signature' (the signed source is ambiguous); Content-Type is not required (the HMAC over the decoded fields authenticates the body); x_signature must be 64 lowercase hex chars · brief: signature over every field; senders may omit the header · 400 for duplicates / require form content type · Marwan  
D53 · Webhook: after a valid signature, check order 401 → 404 unknown bill (read-only pre-check; bills are never deleted) → paid flag 400 → signed paid=true with a non-integer paid_amount = 422 (not the bill's amount) → malformed paid_at passed as null so amount mismatch / duplicate come first, pending bill without paid_at → 400 · brief's table has no 400 row for amounts · 400 for any malformed field · Marwan  
D54 · Webhook success body { ok: true, outcome: 'paid'|'duplicate'|'failed'|'ignored' }; logs only bill id + outcome/status · brief: never log the key or whole payloads · kit {"duplicate":true} · Marwan  
D55 · GET /api/gateway-bills/:billId (read-only, for /payments/return and the UI): lease tenant + org staff/manager, else 404 · the return page only shows DB state (R31) · page reading Prisma directly · Marwan  
D56 · Collections months: year 0000 rejected (400) · Postgres reads year 0 as 1 BC and mislabels the series · accept any ^\d{4} · Marwan  
D57 · Idempotency replay returns the payment's CURRENT status (e.g. voided), with 200 · the key identifies the payment, not a snapshot · return the original status · Marwan  
D58 · Bearer header wins over the cookie: an invalid Bearer gives 401 even with a valid cookie · one credential per request, no silent fallback · fall back to the cookie · Marwan  
D59 · A signed-in user with no membership and no tenant row: record routes → 404, POST /api/leases and collections → 403 · D2 order (nothing visible to hide on no-record endpoints) · 401 · Marwan  
D60 · Tenant portal: flat supabase-js queries joined on the client, rows validated with zod in the browser, 'now' computed only after mount (server HTML is a skeleton) · brief: portal reads directly with supabase-js; no hydration mismatch · server-rendered portal · Marwan  
D61 · No route-level loading.tsx on staff pages (it flushes 200 before the access check, turning 307/404 into 200); data loads inside Suspense after the access check · real 404/redirect statuses · loading.tsx skeletons · Marwan  
D62 · Record-payment form sends an Idempotency-Key (crypto.randomUUID per form submission) so a double click replays instead of creating a second payment · D9 optional header · no key from the UI · Marwan  
D63 · Dashboard collections = current MYT month and the 5 months before it; month labels built by hand ('May 2026'), no Intl · brief "last 6 months"; identical server/client output · Intl.DateTimeFormat · Marwan  
D64 · Bonus create-lease form at /leases/new (managers): options from leaseFormOptions(ctx) (manager-only, org-scoped), live preview = generateSchedule in the browser, submit via POST /api/leases · same code path and validation as the API; the preview is exactly what will be stored · server-rendered preview round-trip · Marwan  
D65 · Bonus allocation tests run inside BEGIN … ROLLBACK on fixture leases (payments are append-only) · no residue in the shared DB · committed fixture leases · Marwan  
D66 · No loading.tsx on /leases/new (same reason as D61: it would flush 200 before the manager check) · real redirects/403s · route-level skeleton · Marwan  
D67 · Root layout types its props explicitly ({ children: React.ReactNode }) instead of Next's generated global LayoutProps · the fresh-clone check runs tsc before next build, when .next/types does not exist yet · keep LayoutProps and type-check only after a build · pending  
D68 · Submission: public GitHub repo MarwanMaher0/ezyfusion-rent-collection created with gh and pushed at the end (after the final gate + ai-logs export) · brief: public repo with full history · push mid-build · Marwan  
