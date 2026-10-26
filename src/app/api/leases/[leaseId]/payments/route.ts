import { badRequest } from '@/lib/errors'
import { requireUserId } from '@/server/auth'
import { json, route } from '@/server/http'
import { authorizeRecordPayment, cleanupRejectedSlip, recordPayment } from '@/server/services/payments'

// POST /api/leases/:leaseId/payments (staff, manager): 201 { id, status }; replay of the same
// Idempotency-Key + payload -> 200 with the original body (D9); 400 invalid input; 404 lease not visible;
// 403 the lease's tenant; 409 key reused with another payload / slip already used; 422 over the cap (R22).
export const POST = route(async (req: Request, { params }: { params: Promise<{ leaseId: string }> }) => {
  // No cleanup before this line: an unauthenticated caller has no org folder to scope a delete by.
  const ctx = { userId: await requireUserId(req) }
  // R20: the raw text is read first so any later failure (404/403 included, D42) can still find the slip.
  let text: string | null
  try {
    text = await req.text()
  } catch {
    text = null
  }
  try {
    const { leaseId } = await params
    await authorizeRecordPayment(ctx, leaseId)
    if (text === null) throw badRequest('Could not read the request body')
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      throw badRequest('Malformed JSON body')
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw badRequest('Request body must be a JSON object')
    }
    // D75: a blank Idempotency-Key header counts as no key.
    const header = req.headers.get('idempotency-key')?.trim()
    const result = await recordPayment(ctx, leaseId, body, header ? { idempotencyKey: header } : undefined)
    return json({ id: result.id, status: result.status }, result.replayed ? 200 : 201)
  } catch (e) {
    await cleanupRejectedSlip(ctx, text)
    throw e
  }
})
