import { requireUserId } from '@/server/auth'
import { json, route } from '@/server/http'
import { approvePayment } from '@/server/services/payments'

// POST /api/payments/:paymentId/approve (manager): 200 { status }; 404 not visible; 403 staff;
// 409 not pending; 422 over the remaining balance (payment stays pending, R23). No body is read.
export const POST = route(async (req: Request, { params }: { params: Promise<{ paymentId: string }> }) => {
  const ctx = { userId: await requireUserId(req) }
  const { paymentId } = await params
  return json(await approvePayment(ctx, paymentId))
})
