import { z } from 'zod'
import type { Prisma } from '@/generated/prisma/client'
import { generateSchedule, type ScheduledInvoice } from '@/lib/billing'
import { badRequest, forbidden, notFound, withRetry } from '@/lib/errors'
import { prisma } from '@/lib/prisma'
import { loadCaller, requireLeaseAccess, requireMember, type Caller } from '@/server/access'
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
    unitId: z.guid(), // D75: any 8-4-4-4-12 hex id; a well-formed id that does not exist is 404, not 400
    tenantId: z.guid(),
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

// Visibility shared by listLeases and listLeasesPage: staff/manager see their org's leases (scoped by the
// org_id read from memberships), a tenant only their own (tenant ids from tenants.user_id); neither -> 403.
function leaseVisibilityWhere(caller: Caller): Prisma.leasesWhereInput {
  const or: Prisma.leasesWhereInput[] = []
  if (caller.member) or.push({ org_id: caller.member.orgId })
  if (caller.tenantIds.length > 0) or.push({ tenant_id: { in: caller.tenantIds } })
  if (or.length === 0) throw forbidden()
  return { OR: or }
}

const LIST_INCLUDE = { units: { select: { name: true } }, tenants: { select: { full_name: true } } } as const

type LeaseListRow = Prisma.leasesGetPayload<{ include: typeof LIST_INCLUDE }>

function toListItem(row: LeaseListRow): LeaseListItem {
  return { ...serializeLease(row), unitName: row.units.name, tenantName: row.tenants.full_name }
}

// Leases list for the UI: staff/manager see their org's leases; a tenant sees only their own.
export async function listLeases(ctx: ServiceCtx): Promise<LeaseListItem[]> {
  const caller = await loadCaller(ctx.userId)
  const rows = await prisma.leases.findMany({
    where: leaseVisibilityWhere(caller),
    include: LIST_INCLUDE,
    orderBy: [{ start_date: 'asc' }, { id: 'asc' }],
  })
  return rows
    .map(toListItem)
    .sort((a, b) => (a.unitName === b.unitName ? 0 : a.unitName < b.unitName ? -1 : 1))
}

export type LeasePage = { items: LeaseListItem[]; total: number; page: number; pageSize: number; pageCount: number; q: string }

const DEFAULT_PAGE_SIZE = 10
const MAX_PAGE_SIZE = 50

// URL params are untrusted: only a plain positive integer counts; anything else (decimal, 0, negative,
// "1e1", empty, out of range) falls back to the default instead of erroring, so a bad link still renders.
function parsePositiveInt(v: string | number | null | undefined, fallback: number, max: number): number {
  let n: number
  if (typeof v === 'number') n = v
  else if (typeof v === 'string' && /^\d+$/.test(v.trim())) n = Number(v.trim())
  else return fallback
  return Number.isSafeInteger(n) && n >= 1 && n <= max ? n : fallback
}

// Server-side paginated + searched leases list (bonus R56). Same visibility as listLeases; the ?q= filter
// and skip/take run in the DB under the SAME where as the count, so total and items always agree.
export async function listLeasesPage(
  ctx: ServiceCtx,
  params: { q?: string | null; page?: string | number | null; pageSize?: string | number | null },
): Promise<LeasePage> {
  const caller = await loadCaller(ctx.userId)
  const visibility = leaseVisibilityWhere(caller)
  const q = typeof params.q === 'string' ? params.q.trim() : ''
  const pageSize = parsePositiveInt(params.pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)
  const requestedPage = parsePositiveInt(params.page, 1, Number.MAX_SAFE_INTEGER)

  // Prisma's `contains` escapes LIKE wildcards, so a q of "%" or "_" matches literally.
  const where: Prisma.leasesWhereInput =
    q === ''
      ? visibility
      : {
          AND: [
            visibility,
            {
              OR: [
                { units: { name: { contains: q, mode: 'insensitive' } } },
                { tenants: { full_name: { contains: q, mode: 'insensitive' } } },
              ],
            },
          ],
        }

  const total = await prisma.leases.count({ where })
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  // A page past the end clamps to the last page (page 1 when there are no rows).
  const page = Math.min(requestedPage, pageCount)
  const rows = await prisma.leases.findMany({
    where,
    include: LIST_INCLUDE,
    // id as the final key makes the order total, so pages never overlap or skip rows.
    orderBy: [{ units: { name: 'asc' } }, { start_date: 'asc' }, { id: 'asc' }],
    skip: (page - 1) * pageSize,
    take: pageSize,
  })
  return { items: rows.map(toListItem), total, page, pageSize, pageCount, q }
}
