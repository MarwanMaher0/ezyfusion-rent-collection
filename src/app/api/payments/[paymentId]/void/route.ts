import { requireUserId } from '@/server/auth'
import { json, readJson, route } from '@/server/http'
import { authorizePaymentDecision, voidPayment } from '@/server/services/payments'

// POST /api/payments/:paymentId/void (manager) { reason }: 200 { status }; 404 not visible; 403 staff;
// 400 reason shorter than 5 characters; 409 not approved (R24, D14).
export const POST = route(async (req: Request, { params }: { params: Promise<{ paymentId: string }> }) => {
  const ctx = { userId: await requireUserId(req) }
  const { paymentId } = await params
  await authorizePaymentDecision(ctx, paymentId)
  const body = await readJson(req)
  return json(await voidPayment(ctx, paymentId, body))
})
