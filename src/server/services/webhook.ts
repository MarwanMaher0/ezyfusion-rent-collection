import { createHmac, timingSafeEqual } from 'node:crypto'
import { parseInstantWithOffset } from '@/lib/dates'
import { ApiError, badRequest, notFound, toErrorResponse, unauthorized, unprocessable, withRetry } from '@/lib/errors'
import { prisma } from '@/lib/prisma'
import { isUuid } from '@/server/access'

export type GatewayOutcome = 'paid' | 'duplicate' | 'failed' | 'ignored'
export type WebhookResult = { status: number; body: unknown }

type CallbackRow = { outcome: string; payment_id: string | null }

const SIGNATURE_RE = /^[0-9a-f]{64}$/
const DIGITS_RE = /^\d+$/
const PAID_AT_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/

class GatewayKeyMissing extends Error {
  constructor() {
    super('gateway key not configured')
    this.name = 'GatewayKeyMissing'
  }
}

function asOutcome(v: string): GatewayOutcome {
  if (v === 'paid' || v === 'duplicate' || v === 'failed' || v === 'ignored') return v
  throw new Error('Unexpected gateway callback outcome')
}

// R32: every field the gateway sent, decoded. A repeated key makes the signed source ambiguous (which
// value did the gateway sign?), so it is treated as an invalid signature (D52).
function parseFields(rawBody: string): Map<string, string> {
  const fields = new Map<string, string>()
  for (const [k, v] of new URLSearchParams(rawBody)) {
    if (fields.has(k)) throw unauthorized('Invalid signature')
    fields.set(k, v)
  }
  return fields
}

// R33: all fields except x_signature (unknown future fields included), sorted by key by UTF-16 code unit
// (plain sort, not localeCompare), key immediately followed by value, joined with '|'.
export function signatureSource(fields: Map<string, string>): string {
  return [...fields.keys()]
    .filter((k) => k !== 'x_signature')
    .sort()
    .map((k) => `${k}${fields.get(k) ?? ''}`)
    .join('|')
}

export function computeSignature(source: string, key: string): string {
  return createHmac('sha256', key).update(source, 'utf8').digest('hex')
}

function verifySignature(fields: Map<string, string>): void {
  const given = fields.get('x_signature')
  if (given === undefined || !SIGNATURE_RE.test(given)) throw unauthorized('Invalid signature')
  const key = process.env.GATEWAY_X_SIGNATURE_KEY
  if (!key) throw new GatewayKeyMissing()
  const expected = Buffer.from(computeSignature(signatureSource(fields), key), 'hex')
  const actual = Buffer.from(given, 'hex')
  // Both are 32 bytes (the regex pins 64 hex chars); the length check keeps timingSafeEqual from throwing.
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw unauthorized('Invalid signature')
}

// "2026-04-01 00:30:12 +0800" -> the instant it names; rewritten to ISO 8601 so the one instant parser in
// dates.ts validates the calendar date, the clock and the offset (D6). Returns null when malformed.
function parsePaidAt(value: string | undefined): Date | null {
  if (value === undefined) return null
  const m = PAID_AT_RE.exec(value)
  if (!m) return null
  try {
    return parseInstantWithOffset(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7]}${m[8]}:${m[9]}`)
  } catch {
    return null
  }
}

function parsePaidAmount(value: string | undefined): number | null {
  if (value === undefined || !DIGITS_RE.test(value)) return null
  const n = Number(value)
  return Number.isSafeInteger(n) ? n : null
}

async function applyCallback(fields: Map<string, string>, seen: { billId: string | null }): Promise<{ outcome: GatewayOutcome }> {
  verifySignature(fields)

  // Bill ids are uuids (D10), so a non-uuid id such as 'bill_8f3a2c' is simply unknown.
  const billId = fields.get('id')
  if (billId === undefined || !isUuid(billId)) throw notFound('Unknown bill')
  seen.billId = billId
  // Brief table order 401 -> 404 -> 422: an unknown bill wins over malformed fields. Bills are never
  // deleted (D32 guard trigger), so this read-only pre-check cannot race; the SQL function re-checks.
  const exists = await prisma.gateway_bills.findUnique({ where: { id: billId }, select: { id: true } })
  if (!exists) throw notFound('Unknown bill')

  const paidRaw = fields.get('paid')
  if (paidRaw !== 'true' && paidRaw !== 'false') throw badRequest('paid must be true or false')
  const paid = paidRaw === 'true'

  const paidAmount = parsePaidAmount(fields.get('paid_amount'))
  const paidAt = parsePaidAt(fields.get('paid_at'))
  // D53: a signed paid=true whose paid_amount is not a sen integer is "not the bill's amount" (brief: 422).
  if (paid && paidAmount === null) throw unprocessable('Paid amount does not match the bill')
  // D53: a malformed paid_at goes to SQL as null, so the amount check and the duplicate answer for an
  // already-paid bill still come first; settling a pending bill without paid_at is P0400 there.

  // D7/D10/D11: one call, one transaction: bill FOR UPDATE -> 404 / 422 amount mismatch -> state machine
  // (pending|failed + paid -> paid + one approved online payment, allocated; paid + paid -> duplicate;
  // pending + not paid -> failed; else ignored). UNIQUE (payments.gateway_bill_id) backs the lock (R35).
  const rows = await withRetry(() =>
    prisma.$queryRaw<CallbackRow[]>`
      select r.outcome, r.payment_id::text as payment_id
      from private.apply_gateway_callback(
        ${billId}::uuid,
        ${paid}::boolean,
        ${paidAmount}::bigint,
        ${paidAt === null ? null : paidAt.toISOString()}::timestamptz,
        ${fields.get('transaction_id') ?? null}::text,
        ${fields.get('transaction_status') ?? null}::text
      ) r`,
  )
  if (rows.length !== 1) throw new Error('Expected exactly one row from apply_gateway_callback')
  return { outcome: asOutcome(rows[0].outcome) }
}

// Diagnostic only (logged on rejection): a 401 from a client that did not send a form body is easy to spot.
function isFormEncoded(contentType: string | null): boolean {
  return contentType !== null && contentType.split(';')[0].trim().toLowerCase() === 'application/x-www-form-urlencoded'
}

// POST /api/webhooks/gateway (R32-R35). The content type is not trusted or required: the HMAC over the
// decoded fields is what authenticates the body (D52). R35 logging: only the bill id and the outcome or
// the error status -- never the key, the signature, the raw body or the parsed fields.
export async function handleGatewayCallback(rawBody: string, contentType: string | null): Promise<WebhookResult> {
  // Filled only once the signature is verified and the id is a uuid, so unauthenticated input is never logged.
  const seen: { billId: string | null } = { billId: null }
  try {
    const { outcome } = await applyCallback(parseFields(rawBody), seen)
    console.info('gateway callback', { billId: seen.billId, outcome })
    return { status: 200, body: { ok: true, outcome } }
  } catch (e) {
    if (e instanceof GatewayKeyMissing) {
      console.error('gateway key not configured')
      return { status: 500, body: { error: 'Internal error' } }
    }
    // Same status/body mapping as every route (P0404 -> 404, P0422 -> 422, P0400 -> 400, else generic 500).
    const res = toErrorResponse(e)
    const body: unknown = await res.json()
    const errorClass = e instanceof ApiError ? 'ApiError' : e instanceof Error ? e.name : typeof e
    console.warn('gateway callback rejected', { billId: seen.billId, status: res.status, errorClass, formEncoded: isFormEncoded(contentType) })
    return { status: res.status, body }
  }
}
