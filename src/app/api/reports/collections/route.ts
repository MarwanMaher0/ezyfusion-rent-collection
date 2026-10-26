import { requireUserId } from '@/server/auth'
import { json, route } from '@/server/http'
import { collectionsReport } from '@/server/services/reports'

// GET /api/reports/collections?from=YYYY-MM&to=YYYY-MM (staff, manager): 200 [{ month, collectedSen }].
export const GET = route(async (req: Request) => {
  const ctx = { userId: await requireUserId(req) }
  const params = new URL(req.url).searchParams
  return json(await collectionsReport(ctx, params.get('from') ?? '', params.get('to') ?? ''))
})
