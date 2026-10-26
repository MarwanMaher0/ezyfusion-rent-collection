import { z } from 'zod'
import { generateSchedule, type ScheduledInvoice } from '@/lib/billing'
import { badRequest, forbidden, notFound, withRetry } from '@/lib/errors'
import { prisma } from '@/lib/prisma'
import { loadCaller, requireLeaseAccess, requireMember } from '@/server/access'
import {
  compareAllocationOrder,
  isoDateToDb,
  paidByInvoice,
  serializeInvoice,
  serializeLease,
  serializePayment,
  type InvoiceDto,
  type LeaseDto,
  type PaymentDto,
  type ServiceCtx,
} from './serialize'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

const createLeaseSchema = z
  .object({
    unitId: z.string().uuid(),
    tenantId: z.string().uuid(),
    startDate: z.string().regex(ISO_DATE, 'must be YYYY-MM-DD'),
    endDate: z.string().regex(ISO_DATE, 'must be YYYY-MM-DD'),
    monthlyRentSen: z.number().int().positive(),
    depositSen: z.number().int().nonnegative(),
  })
  .strict()

export type CreateLeaseInput = z.infer<typeof createLeaseSchema>

// D2 order for POST /api/leases: the route calls this before reading the body, so a non-manager gets 403
// even when the body is malformed JSON. createLease repeats the check, so it is safe to call alone.
export async function requireLeaseCreator(ctx: ServiceCtx): Promise<void> {
  requireMember(await loadCaller(ctx.userId), ['manager'])
}

export async function createLease(ctx: ServiceCtx, input: unknown): Promise<{ id: string }> {
  const caller = await loadCaller(ctx.userId)
  // POST /api/leases has no target record yet, so the role check (403) precedes body validation (400).
  const { orgId } = requireMember(caller, ['manager'])
  const body = createLeaseSchema.parse(input)

  // R11/R46: the schedule comes only from billing.ts; its validation errors are the 400 message.
  let schedule: ScheduledInvoice[]
  try {
    schedule = generateSchedule(body)
  } catch (e) {
    throw badRequest(e instanceof Error ? e.message : 'Invalid lease')
  }

  // R39/D15: body ids are untrusted; a unit or tenant outside the caller's org is a 404, exactly like a
  // nonexistent one, so another org's ids are never confirmed. The composite FKs enforce the same in the DB.
  const [unit, tenant] = await Promise.all([
    prisma.units.findFirst({ where: { id: body.unitId, org_id: orgId }, select: { id: true } }),
    prisma.tenants.findFirst({ where: { id: body.tenantId, org_id: orgId }, select: { id: true } }),
  ])
  if (!unit) throw notFound('Unit not found')
  if (!tenant) throw notFound('Tenant not found')

  // R46: lease + exactly the scheduled invoices + audit row commit together or not at all. Overlap is
  // enforced by the leases_no_overlap EXCLUDE constraint (D16): a concurrent overlapping insert waits,
  // then fails with 23P01, which errors.ts maps to 409. withRetry covers a deadlock (40P01) once.
  return withRetry(() =>
    prisma.$transaction(async (tx) => {
      const lease = await tx.leases.create({
        data: {
          org_id: orgId,
          unit_id: body.unitId,
          tenant_id: body.tenantId,
          start_date: isoDateToDb(body.startDate),
          end_date: isoDateToDb(body.endDate),
          monthly_rent_sen: body.monthlyRentSen,
          deposit_sen: body.depositSen,
          created_by: caller.userId,
        },
        select: { id: true },
      })
      await tx.invoices.createMany({
        data: schedule.map((inv) => ({
          org_id: orgId,
          lease_id: lease.id,
          kind: inv.kind,
          period_index: inv.periodIndex,
          period_start: inv.periodStart === null ? null : isoDateToDb(inv.periodStart),
          period_end: inv.periodEnd === null ? null : isoDateToDb(inv.periodEnd),
          due_date: isoDateToDb(inv.dueDate),
          amount_sen: inv.amountSen,
        })),
      })
      await tx.audit_log.create({
        data: {
          org_id: orgId,
          actor_id: caller.userId,
          action: 'lease.created',
          entity_id: lease.id,
          details: {
            unitId: body.unitId,
            tenantId: body.tenantId,
            startDate: body.startDate,
            endDate: body.endDate,
            monthlyRentSen: body.monthlyRentSen,
            depositSen: body.depositSen,
            invoiceCount: schedule.length,
          },
        },
      })
      return { id: lease.id }
    }),
  )
}

export type LeaseDetail = { lease: LeaseDto; invoices: InvoiceDto[]; payments: PaymentDto[] }

// GET /api/leases/:leaseId, the brief's shape exactly. asOf drives the overdue status (R17).
export async function getLease(ctx: ServiceCtx, leaseId: string, asOf: Date = new Date()): Promise<LeaseDetail> {
  const caller = await loadCaller(ctx.userId)
  const lease = await requireLeaseAccess(caller, leaseId, ['manager', 'staff', 'tenant'])
  // Every query is scoped by the checked lease's own org_id as well as its id (D18).
  const scope = { lease_id: lease.id, org_id: lease.org_id }
  const [invoiceRows, allocationSums, paymentRows] = await Promise.all([
    prisma.invoices.findMany({ where: scope }),
    prisma.payment_allocations.groupBy({ by: ['invoice_id'], where: scope, _sum: { amount_sen: true } }),
    prisma.payments.findMany({ where: scope, orderBy: [{ received_at: 'asc' }, { created_at: 'asc' }, { id: 'asc' }] }),
  ])
  // Voiding deletes that payment's allocations (D14), so every remaining allocation counts as paid.
  const paid = paidByInvoice(allocationSums)
  const invoices = invoiceRows.map((row) => serializeInvoice(row, paid.get(row.id) ?? 0, asOf)).sort(compareAllocationOrder)
  return { lease: serializeLease(lease), invoices, payments: paymentRows.map(serializePayment) }
}

export type LeaseFormOptions = {
  units: { id: string; name: string }[]
  tenants: { id: string; fullName: string; email: string }[]
}

// Pickers for the create-lease form (R46/R56): manager only, like createLease; scoped to the caller's org.
export async function leaseFormOptions(ctx: ServiceCtx): Promise<LeaseFormOptions> {
  const { orgId } = requireMember(await loadCaller(ctx.userId), ['manager'])
  const [units, tenants] = await Promise.all([
    prisma.units.findMany({ where: { org_id: orgId }, select: { id: true, name: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }] }),
    prisma.tenants.findMany({
      where: { org_id: orgId },
      select: { id: true, full_name: true, email: true },
      orderBy: [{ full_name: 'asc' }, { id: 'asc' }],
    }),
  ])
  return {
    units,
    tenants: tenants.map((t) => ({ id: t.id, fullName: t.full_name, email: t.email })),
  }
}

export type LeaseListItem = LeaseDto & { unitName: string; tenantName: string }

// Leases list for the UI: staff/manager see their org's leases; a tenant sees only their own.
export async function listLeases(ctx: ServiceCtx): Promise<LeaseListItem[]> {
  const caller = await loadCaller(ctx.userId)
  const or: ({ org_id: string } | { tenant_id: { in: string[] } })[] = []
  if (caller.member) or.push({ org_id: caller.member.orgId })
  if (caller.tenantIds.length > 0) or.push({ tenant_id: { in: caller.tenantIds } })
  if (or.length === 0) throw forbidden()
  const rows = await prisma.leases.findMany({
    where: { OR: or },
    include: { units: { select: { name: true } }, tenants: { select: { full_name: true } } },
    orderBy: [{ start_date: 'asc' }, { id: 'asc' }],
  })
  return rows
    .map((row) => ({ ...serializeLease(row), unitName: row.units.name, tenantName: row.tenants.full_name }))
    .sort((a, b) => (a.unitName === b.unitName ? 0 : a.unitName < b.unitName ? -1 : 1))
}
