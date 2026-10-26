import { z } from 'zod'
import { parseInstantWithOffset } from '@/lib/dates'
import { badRequest, notFound, withRetry } from '@/lib/errors'
import { prisma } from '@/lib/prisma'
import { createAdminClient } from '@/lib/supabase/admin-client'
import { isUuid, loadCaller, requireLeaseAccess, requirePaymentAccess, type Caller } from '@/server/access'
import { asPaymentStatus, type PaymentStatus, type ServiceCtx } from './serialize'

const SLIP_BUCKET = 'payment-slips'
const SLIP_URL_TTL_SECONDS = 60
const REASON_MESSAGE = 'Reason must be at least 5 characters'
const RECEIVED_AT_MESSAGE = 'receivedAt must be an ISO 8601 instant with an offset'

const recordPaymentSchema = z
  .object({
    // zod 4: .int() already rejects values outside the safe integer range (D3).
    amountSen: z.number().int().positive(),
    method: z.enum(['cash', 'bank_transfer']),
    receivedAt: z.string(),
    slipPath: z.string().min(1).max(512).optional(),
  })
  .strict()

const reasonSchema = z
  .object({
    reason: z.string().trim().min(5, REASON_MESSAGE),
  })
  .strict()

export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>
export type RecordPaymentResult = { id: string; status: PaymentStatus; replayed: boolean }

type RecordPaymentRow = { id: string; status: string; replayed: boolean }
type StatusRow = { status: string }

// Each private.* money function returns exactly one row; anything else means the schema drifted (500).
function single<T>(rows: T[]): T {
  if (rows.length !== 1) throw new Error('Expected exactly one row from a money function')
  return rows[0]
}

// R44/D22: a slip may only live in the lease's own org folder; '..' or a leading '/' never reaches Storage.
function isOwnOrgSlipPath(path: string, orgId: string): boolean {
  return path.startsWith(`${orgId}/`) && !path.includes('..') && !path.includes('\\') && path.length > orgId.length + 1
}

// R20: "If recording fails after the upload, the file must not be left behind." Only an object in the
// lease's org folder that no payment references is removed, so a failed request can never delete another
// org's file or a slip that already backs a payment (e.g. a 409 replay with a different payload).
async function removeOrphanSlip(path: string, orgId: string): Promise<void> {
  if (!isOwnOrgSlipPath(path, orgId)) return
  try {
    const referenced = await prisma.payments.findFirst({ where: { org_id: orgId, slip_path: path }, select: { id: true } })
    if (referenced) return
    const { error } = await createAdminClient().storage.from(SLIP_BUCKET).remove([path])
    if (error) console.error('[payments] slip cleanup failed', { name: error.name })
  } catch (e) {
    // Cleanup must never mask the original error; log the class only (no paths or payloads).
    console.error('[payments] slip cleanup failed', { name: e instanceof Error ? e.name : typeof e })
  }
}

async function requireRecorder(caller: Caller, leaseId: string): Promise<{ orgId: string; leaseId: string }> {
  // R1/R38: staff/manager of the lease's org; the lease's tenant -> 403; anyone else -> 404.
  const lease = await requireLeaseAccess(caller, leaseId, ['manager', 'staff'])
  return { orgId: lease.org_id, leaseId: lease.id }
}

// Error contract order for POST /api/leases/:leaseId/payments: the route calls this before reading the
// body, so 404/403 win over a malformed-JSON 400. recordPayment repeats the check, so it is safe alone.
export async function authorizeRecordPayment(ctx: ServiceCtx, leaseId: string): Promise<void> {
  await requireRecorder(await loadCaller(ctx.userId), leaseId)
}

// Same pre-check for approve / reject / void (manager of the payment's org; staff of it -> 403).
export async function authorizePaymentDecision(ctx: ServiceCtx, paymentId: string): Promise<void> {
  await requirePaymentAccess(await loadCaller(ctx.userId), paymentId, ['manager'])
}

export async function recordPayment(
  ctx: ServiceCtx,
  leaseId: string,
  input: unknown,
  opts?: { idempotencyKey?: string },
): Promise<RecordPaymentResult> {
  const caller = await loadCaller(ctx.userId)
  // Read before validation so a slip uploaded for a request that fails any later check is still cleaned up.
  const rawSlip =
    typeof input === 'object' && input !== null && 'slipPath' in input && typeof input.slipPath === 'string'
      ? input.slipPath
      : null

  try {
    // Authorization sits inside the cleanup try: a 404/403 on the lease must not leave the uploaded slip behind.
    const { orgId, leaseId: checkedLeaseId } = await requireRecorder(caller, leaseId)

    const key = opts?.idempotencyKey
    // D9: the key is optional (the brief's body has none) but must be a uuid when sent.
    if (key !== undefined && !isUuid(key)) throw badRequest('Idempotency-Key must be a UUID')

    const body = recordPaymentSchema.parse(input)

    let receivedAt: Date
    try {
      // D6: a naive date-time is ambiguous; only Z or an explicit offset is accepted.
      receivedAt = parseInstantWithOffset(body.receivedAt)
    } catch {
      throw badRequest(RECEIVED_AT_MESSAGE)
    }

    const slipPath = body.slipPath ?? null
    if (body.method === 'bank_transfer' && slipPath === null) throw badRequest('A bank transfer needs a slip')
    if (body.method === 'cash' && slipPath !== null) throw badRequest('A cash payment cannot have a slip')
    // R44/D22: record_payment re-checks that the object exists in storage.objects under this org.
    if (slipPath !== null && !isOwnOrgSlipPath(slipPath, orgId)) throw badRequest('Slip file not found')

    // D7/D9: one plpgsql call does lock -> replay check -> validation -> cap -> insert -> allocate in a
    // single transaction; withRetry covers one serialization failure / deadlock, then 409.
    const row = single(
      await withRetry(() =>
        prisma.$queryRaw<RecordPaymentRow[]>`
          select r.id::text as id, r.status, r.replayed
          from private.record_payment(
            ${caller.userId}::uuid,
            ${checkedLeaseId}::uuid,
            ${body.amountSen}::bigint,
            ${body.method}::text,
            ${receivedAt.toISOString()}::timestamptz,
            ${slipPath}::text,
            ${key ?? null}::uuid
          ) r`,
      ),
    )
    return { id: row.id, status: asPaymentStatus(row.status), replayed: row.replayed }
  } catch (e) {
    // Delete only inside the caller's own org folder, never the (possibly unrelated) lease's org (R20/R44).
    if (rawSlip !== null && caller.member) await removeOrphanSlip(rawSlip, caller.member.orgId)
    throw e
  }
}

export async function approvePayment(ctx: ServiceCtx, paymentId: string): Promise<{ status: PaymentStatus }> {
  const caller = await loadCaller(ctx.userId)
  const payment = await requirePaymentAccess(caller, paymentId, ['manager'])
  // D7/R28: approve_payment locks lease then payment and re-reads status, so a double approve allocates once.
  const row = single(
    await withRetry(() =>
      prisma.$queryRaw<StatusRow[]>`
        select r.status from private.approve_payment(${caller.userId}::uuid, ${payment.id}::uuid) r`,
    ),
  )
  return { status: asPaymentStatus(row.status) }
}

function parseReason(input: unknown): string {
  const parsed = reasonSchema.safeParse(input)
  if (parsed.success) return parsed.data.reason
  // R24: a missing, non-string or short reason gets the one fixed message; unknown keys keep zod's.
  if (parsed.error.issues.some((i) => i.path[0] === 'reason')) throw badRequest(REASON_MESSAGE)
  throw parsed.error
}

export async function rejectPayment(ctx: ServiceCtx, paymentId: string, input: unknown): Promise<{ status: PaymentStatus }> {
  const caller = await loadCaller(ctx.userId)
  const payment = await requirePaymentAccess(caller, paymentId, ['manager'])
  const reason = parseReason(input)
  const row = single(
    await withRetry(() =>
      prisma.$queryRaw<StatusRow[]>`
        select r.status from private.reject_payment(${caller.userId}::uuid, ${payment.id}::uuid, ${reason}::text) r`,
    ),
  )
  return { status: asPaymentStatus(row.status) }
}

export async function voidPayment(ctx: ServiceCtx, paymentId: string, input: unknown): Promise<{ status: PaymentStatus }> {
  const caller = await loadCaller(ctx.userId)
  const payment = await requirePaymentAccess(caller, paymentId, ['manager'])
  const reason = parseReason(input)
  // D14: void_payment removes only this payment's allocations; other payments are untouched.
  const row = single(
    await withRetry(() =>
      prisma.$queryRaw<StatusRow[]>`
        select r.status from private.void_payment(${caller.userId}::uuid, ${payment.id}::uuid, ${reason}::text) r`,
    ),
  )
  return { status: asPaymentStatus(row.status) }
}

// R44/D22: the signed URL is made for the slip_path stored on a payment the caller may see, never for a
// client-supplied path, and lives 60 seconds.
export async function getSlipUrl(ctx: ServiceCtx, paymentId: string): Promise<{ url: string }> {
  const caller = await loadCaller(ctx.userId)
  const payment = await requirePaymentAccess(caller, paymentId, ['manager', 'staff'])
  if (!payment.slip_path) throw notFound('Slip not found')
  const { data, error } = await createAdminClient().storage.from(SLIP_BUCKET).createSignedUrl(payment.slip_path, SLIP_URL_TTL_SECONDS)
  if (error || !data) {
    if (error && /not found/i.test(error.message)) throw notFound('Slip not found')
    throw new Error('Could not sign the slip URL')
  }
  return { url: data.signedUrl }
}
