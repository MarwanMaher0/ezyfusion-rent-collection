import { requireUserId } from '@/server/auth'
import { json, route } from '@/server/http'
import { getLease } from '@/server/services/leases'

// GET /api/leases/:leaseId (staff, manager, the lease's tenant): 200 { lease, invoices, payments }.
export const GET = route(async (req: Request, { params }: { params: Promise<{ leaseId: string }> }) => {
  const ctx = { userId: await requireUserId(req) }
  const { leaseId } = await params
  return json(await getLease(ctx, leaseId, new Date()))
})
