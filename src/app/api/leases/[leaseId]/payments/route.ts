import { requireUserId } from '@/server/auth'
import { json, readJson, route } from '@/server/http'
import { authorizeRecordPayment, recordPayment } from '@/server/services/payments'

// POST /api/leases/:leaseId/payments (staff, manager): 201 { id, status }; replay of the same
// Idempotency-Key + payload -> 200 with the original body (D9); 400 invalid input; 404 lease not visible;
// 403 the lease's tenant; 409 key reused with another payload / slip already used; 422 over the cap (R22).
export const POST = route(async (req: Request, { params }: { params: Promise<{ leaseId: string }> }) => {
  const ctx = { userId: await requireUserId(req) }
  const { leaseId } = await params
  await authorizeRecordPayment(ctx, leaseId)
  const body = await readJson(req)
  const header = req.headers.get('idempotency-key')
  const result = await recordPayment(ctx, leaseId, body, header === null ? undefined : { idempotencyKey: header.trim() })
  return json({ id: result.id, status: result.status }, result.replayed ? 200 : 201)
})
