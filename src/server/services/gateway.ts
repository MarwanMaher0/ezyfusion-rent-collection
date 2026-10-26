import { ApiError, forbidden, notFound, withRetry } from '@/lib/errors'
import { toSen } from '@/lib/money'
import { prisma } from '@/lib/prisma'
import { isUuid, loadCaller, requireLeaseAccess, rolesOnLease } from '@/server/access'
import type { ServiceCtx } from './serialize'

export type GatewayBillStatus = 'pending' | 'paid' | 'failed'

export type CreatedGatewayBill = { billId: string; amountSen: number }
export type GatewayBillDto = { billId: string; leaseId: string; amountSen: number; status: GatewayBillStatus }

type CreateBillRow = { id: string; amount_sen: bigint }

function asBillStatus(v: string): GatewayBillStatus {
  if (v === 'pending' || v === 'paid' || v === 'failed') return v
  throw new Error('Unexpected gateway bill status')
}

// POST /api/leases/:leaseId/gateway-bills (R30): only the lease's own tenant may pay online.
// Not visible (other org, other tenant, malformed/unknown id) -> 404; staff/manager of the org -> 403.
export async function createGatewayBill(ctx: ServiceCtx, leaseId: string, asOf: Date = new Date()): Promise<CreatedGatewayBill> {
  const caller = await loadCaller(ctx.userId)
  try {
    await requireLeaseAccess(caller, leaseId, ['tenant'])
  } catch (e) {
    if (e instanceof ApiError && e.status === 403) throw forbidden('Only the lease tenant can pay online')
    throw e
  }
  // D5/D7/D13: create_gateway_bill locks the lease, re-checks the actor is its tenant, and sums the unpaid
  // amounts of invoices due on or before (p_as_of at time zone 'Asia/Kuala_Lumpur')::date; 0 -> P0422 (422).
  const rows = await withRetry(() =>
    prisma.$queryRaw<CreateBillRow[]>`
      select b.id::text as id, b.amount_sen
      from private.create_gateway_bill(${caller.userId}::uuid, ${leaseId}::uuid, ${asOf.toISOString()}::timestamptz) b`,
  )
  if (rows.length !== 1) throw new Error('Expected exactly one row from create_gateway_bill')
  return { billId: rows[0].id, amountSen: toSen(rows[0].amount_sen) }
}

// GET /api/gateway-bills/:billId, used by /payments/return and the tenant UI. R31: strictly read-only;
// only the webhook settles a bill, so this never writes anything whatever the query string says.
export async function getGatewayBill(ctx: ServiceCtx, billId: string): Promise<GatewayBillDto> {
  if (!isUuid(billId)) throw notFound('Bill not found')
  const caller = await loadCaller(ctx.userId)
  const bill = await prisma.gateway_bills.findUnique({
    where: { id: billId },
    select: { id: true, org_id: true, lease_id: true, amount_sen: true, status: true },
  })
  if (!bill) throw notFound('Bill not found')
  // Scoped by the bill's own org_id (composite FK makes them agree), so visibility follows the lease.
  const lease = await prisma.leases.findFirst({
    where: { id: bill.lease_id, org_id: bill.org_id },
    select: { org_id: true, tenant_id: true },
  })
  // R38: the bill's lease tenant and staff/manager of its org see it; everyone else gets 404.
  if (!lease || rolesOnLease(caller, lease).length === 0) throw notFound('Bill not found')
  return {
    billId: bill.id,
    leaseId: bill.lease_id,
    amountSen: toSen(bill.amount_sen),
    status: asBillStatus(bill.status),
  }
}
