import { requireUserId } from '@/server/auth'
import { json, readJson, route } from '@/server/http'
import { createLease, listLeases, requireLeaseCreator } from '@/server/services/leases'

// POST /api/leases (manager): 201 { id }; 400 invalid input; 404 unit/tenant not in the caller's org (D15);
// 409 overlaps another lease on the unit (D16).
export const POST = route(async (req: Request) => {
  const ctx = { userId: await requireUserId(req) }
  await requireLeaseCreator(ctx)
  const body = await readJson(req)
  return json(await createLease(ctx, body), 201)
})

// GET /api/leases: the caller's visible leases (org for staff/manager, own for a tenant), for the UI.
export const GET = route(async (req: Request) => {
  const ctx = { userId: await requireUserId(req) }
  return json(await listLeases(ctx))
})
