import { requireUserId } from '@/server/auth'
import { json, route } from '@/server/http'
import { getGatewayBill } from '@/server/services/gateway'

// GET /api/gateway-bills/:billId (the bill's lease tenant, staff, manager): 200 { billId, leaseId,
// amountSen, status }; 401 no login; 404 malformed, unknown or not visible. Read-only (R31).
export const GET = route(async (req: Request, { params }: { params: Promise<{ billId: string }> }) => {
  const ctx = { userId: await requireUserId(req) }
  const { billId } = await params
  return json(await getGatewayBill(ctx, billId))
})
