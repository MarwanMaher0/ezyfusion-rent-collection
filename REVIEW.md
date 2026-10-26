# Part B — Code review of the late-fees / webhook / collections PR

Line numbers refer to the numbered listing in the brief (1–111). Severity: **Critical** (security hole or money created/lost), **High** (wrong money or wrong numbers in normal use), **Medium** (wrong under specific conditions or a broken rule of the brief), **Low** (robustness / wrong status code).
Ordered from most to least severe.

## 1. Critical — `getCollections` is an unauthenticated, cross-organization data leak (lines 98–110)
`'use server'` turns every exported function in the file into a public POST endpoint. `getCollections(orgId, from, to)` never authenticates the caller and takes `orgId` from the client. Prisma connects as the database owner, so RLS does not apply.
**Scenario:** a tenant of Northwind, or an anonymous visitor who copies the action id from the page bundle, calls the action with Beta Realty's `orgId` and reads Beta's monthly collections.
**Fix:** authenticate with `supabase.auth.getUser()`, load the caller's membership from `memberships`, require role manager or staff, and use the membership's `org_id`. Never take `orgId` as a parameter.

## 2. Critical — role taken from `user_metadata` (line 13)
`user_metadata` is writable by the user: `supabase.auth.updateUser({ data: { role: 'manager' } })` works with a tenant's own session.
**Scenario:** any tenant sets `role: 'manager'` on themselves and can then add late fees to any lease.
**Fix:** read the role from `memberships` (user_id → org_id, role). Return 401 when `user` is null, and 403 when the caller is not a manager.

## 3. Critical — no organization check on the lease (lines 18–22)
`prisma.lease.findUnique({ where: { id: leaseId } })` runs as the owner and is not scoped to the caller's organization.
**Scenario:** the Beta Realty manager (or anyone who passes item 2) POSTs Northwind lease ids and charges late fees to Northwind's tenants. The response also reveals whether a lease id exists in another organization (200 vs 404).
**Fix:** `findFirst({ where: { id: leaseId, orgId: membership.orgId } })`, returning 404 when it is not found. Also validate `leaseId` as a uuid; a malformed id currently ends as a Prisma P2023 error and a 500.

## 4. Critical — concurrent webhook deliveries create two payments for one bill (lines 75–93)
The `bill.status === 'paid'` check (line 77) runs outside the transaction and without a row lock. The update on line 80 has no `status` condition.
**Scenario:** the gateway retries the same `paid=true` callback 5 ms apart. Both requests read `pending`, both enter the transaction, both set `paid`, and both create and allocate an approved payment, so the tenant is credited twice. The brief requires "A bill creates at most one payment, ever."
**Fix:** inside the transaction, lock the bill (`SELECT … FOR UPDATE`) or make the transition conditional: `UPDATE gateway_bills SET status = 'paid' WHERE id = $1 AND status <> 'paid' RETURNING id`. If no row is returned, answer 200 with no effect. Back it with `UNIQUE (payments.gateway_bill_id)`.

## 5. High — the paid amount is not checked against the bill (lines 75–87)
The payment amount is whatever `paid_amount` says. The brief requires 422 with no effect when `paid=true` and `paid_amount` differs from the bill's amount.
**Scenario:** a bill for RM 2,100.50 is settled with `paid_amount=1`, which marks the bill paid and records RM 0.01. Or a gateway bug sends a larger amount and the lease is credited money that was never billed.
**Fix:** `if (BigInt(fields.paid_amount) !== bill.amountSen) return 422`, before any write, and use `bill.amountSen` for the payment.

## 6. High — the log line leaks the whole callback and a valid signature (line 70)
`console.error('Invalid signature', { fields, expected })` writes the full payload and the correct HMAC for those exact fields. The brief says "Never log … whole callback payloads".
**Scenario:** an attacker who can read the logs (log aggregator, shared dashboard) sends a forged callback such as `id=<their bill>&paid=true&paid_amount=…`, gets a 401, reads `expected` from the log, and replays the same fields with that signature: the forged payment is accepted.
**Fix:** log only the bill id and the outcome ("invalid signature"), never `expected` or the fields.

## 7. High — late fees are not idempotent (lines 27–46)
Nothing records that a fee was already charged for an invoice.
**Scenario:** the manager clicks the button twice, or a cron job calls the route daily. Every call adds another 2 % fee for every overdue rent invoice, so the same invoice is charged again and again. Two concurrent calls double it immediately.
**Fix:** store the source invoice on the fee (`late_fee_for_invoice_id`) with a UNIQUE constraint, and insert with `ON CONFLICT DO NOTHING` inside one transaction that locks the lease.

## 8. High — collections are grouped in UTC, not Malaysia time (lines 104, 107)
`date_trunc('month', received_at)` and `${from}::date` use the database session time zone (UTC), so month boundaries are 08:00 Malaysia time.
**Scenario:** the seeded bank transfer received 2026-03-01 00:30 MYT is 2026-02-28 16:30 UTC, so it is reported in February. The brief's expected `[300000, 0, 200000]` becomes `[300000, 200000, 0]`. Payments made on the first of `from` before 08:00 MYT are dropped, and payments made on the first of the month after `to` before 08:00 MYT are included.
**Fix:** `date_trunc('month', received_at AT TIME ZONE 'Asia/Kuala_Lumpur')`, and compare `received_at >= (${from}::date)::timestamp AT TIME ZONE 'Asia/Kuala_Lumpur'` (and the same for the upper bound).

## 9. Medium — months with no payments are missing (lines 108–110)
`GROUP BY` only returns months that have rows. The brief requires every month in the range, including months with nothing collected (the `{ month: '2026-02', collectedSen: 0 }` entry).
**Fix:** `generate_series(from, to, interval '1 month')` LEFT JOINed to the grouped payments, with `COALESCE(SUM(...), 0)`.

## 10. Medium — `paid=false` is ignored, and it is answered before the bill lookup (line 73)
Any callback that is not `paid=true` returns 200 immediately: the bill never becomes `failed` (the brief requires pending → failed), and an unknown bill id returns 200 instead of 404.
**Fix:** look up the bill first (404 if unknown). Then, for `paid=false`, update `pending → failed` with a status condition, so that a `paid` bill never goes back.

## 11. Medium — `received_at` is the server's clock, not `paid_at` (line 88)
The brief requires `received_at = paid_at`.
**Scenario:** a payment made at 23:50 MYT on 31 March and delivered (or retried) after midnight is counted in April's collections. A retry hours later shifts it further.
**Fix:** parse `paid_at` (`YYYY-MM-DD HH:MM:SS +0800`) into an instant and store it, rejecting a malformed value with 400.

## 12. Medium — fee invoices get duplicate references, and partial failures are possible (lines 33–46, 50–53)
Prisma queries are lazy: the `create` calls only run in `Promise.all` on line 46, after every `nextReference` call has already read the same "last" invoice. All fees in one request therefore get the same `INV-n+1`, and two concurrent requests collide as well. If `reference` is unique, `Promise.all` rejects after some creates have succeeded, because there is no transaction: some fees are created and the response is a 500.
**Fix:** generate references from a database sequence (or a per-org counter row updated with `UPDATE … RETURNING`), and create all fees in one `prisma.$transaction`.

## 13. Medium — an invoice that is 99.5 % paid is treated as paid (line 31)
`Number(paid) / Number(invoice.amountSen) >= 0.995` is a floating-point threshold on money.
**Scenario:** rent of RM 1,500.00 with RM 1,493.00 paid (99.53 %) still has RM 7.00 unpaid more than 7 days after its due date, but gets no fee. The comment on line 9 says "still unpaid".
**Fix:** compare integers: `if (paid >= invoice.amountSen) continue`.

## 14. Low — the signature comparison is not constant-time (line 69)
`expected !== fields.x_signature` returns faster when the first characters differ, which in principle allows guessing a signature byte by byte.
**Fix:** `timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sig, 'hex'))`, after checking that `sig` is 64 hex characters.

## 15. Low — a fee can round to 0 sen (line 32)
For an unpaid remainder below 25 sen, `Math.round(unpaid * 2 / 100)` is 0, so the route creates a 0-sen "late fee" invoice (a meaningless row that counts in `created`, and is rejected outright if `amount_sen > 0` is enforced, which fails the request).
**Fix:** skip fees that round to 0.

## 16. Low — malformed input becomes a 500 (lines 75, 87, 102–107)
`BigInt(fields.paid_amount)` throws on a non-numeric value, a non-uuid bill id makes Prisma throw P2023, and a malformed `from`/`to` makes the SQL cast fail. Each ends as a 500 instead of 400 or 404.
**Fix:** validate with a schema first: `^\d+$` for amounts, a uuid check that answers 404 for unknown bills, and `YYYY-MM` for months.

## Looks suspicious but is correct
- **Line 24:** `new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)` is the Malaysia calendar date. Malaysia is UTC+8 with no daylight saving, so a fixed offset is exact whatever the server's time zone.
- **Lines 25 and 29:** `Date.parse('YYYY-MM-DD')` parses a date-only string as UTC midnight, the same representation Prisma uses for a `date` column. So `dueDate >= cutoff` compares calendar days exactly: due 2026-03-01 is skipped on 2026-03-08 (7 days) and charged from 2026-03-09 ("more than 7 days").
- **Line 39:** `new Date(todayMyt)` is UTC midnight of the Malaysia date, which Prisma stores as exactly that `date`.
- **Line 30:** summing with the `0n` initial value is correct, because `amountSen` is a `bigint` column (Prisma `BigInt`).
- **Line 32:** `Math.round` rounds .5 up for positive numbers, and the base is the outstanding amount, not the invoice total, so no fee is charged on paid money.
- **Line 62:** `Object.fromEntries(await req.formData())` keeps the last value of a repeated key, but the signature is computed over the same object, so it cannot be bypassed this way. Extra fields the gateway may add are included in the signature, as the brief requires.
