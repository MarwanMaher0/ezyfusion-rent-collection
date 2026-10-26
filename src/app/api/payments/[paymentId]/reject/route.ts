import { requireUserId } from '@/server/auth'
import { json, readJson, route } from '@/server/http'
import { authorizePaymentDecision, rejectPayment } from '@/server/services/payments'

// POST /api/payments/:paymentId/reject (manager) { reason }: 200 { status }; 404 not visible; 403 staff;
// 400 reason shorter than 5 characters; 409 not pending (R24).
export const POST = route(async (req: Request, { params }: { params: Promise<{ paymentId: string }> }) => {
  const ctx = { userId: await requireUserId(req) }
  const { paymentId } = await params
  await authorizePaymentDecision(ctx, paymentId)
  const body = await readJson(req)
  return json(await rejectPayment(ctx, paymentId, body))
})
