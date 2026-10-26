import { requireUserId } from '@/server/auth'
import { json, route } from '@/server/http'
import { createGatewayBill } from '@/server/services/gateway'

// POST /api/leases/:leaseId/gateway-bills (the lease's tenant): 201 { billId, amountSen }; 401 no login;
// 404 lease not visible; 403 staff/manager of the lease's org; 422 nothing due (R30). No body is read.
export const POST = route(async (req: Request, { params }: { params: Promise<{ leaseId: string }> }) => {
  const ctx = { userId: await requireUserId(req) }
  const { leaseId } = await params
  return json(await createGatewayBill(ctx, leaseId, new Date()), 201)
})
