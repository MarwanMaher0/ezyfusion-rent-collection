import { requireUserId } from '@/server/auth'
import { json, route } from '@/server/http'
import { getSlipUrl } from '@/server/services/payments'

// GET /api/payments/:paymentId/slip (staff, manager): 200 { url } signed for 60 s from the DB row's
// slip_path (R44/D22); 404 not visible or no slip; 403 the lease's tenant.
export const GET = route(async (req: Request, { params }: { params: Promise<{ paymentId: string }> }) => {
  const ctx = { userId: await requireUserId(req) }
  const { paymentId } = await params
  return json(await getSlipUrl(ctx, paymentId))
})
