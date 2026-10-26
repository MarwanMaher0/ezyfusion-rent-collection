import { toMytDate } from '@/lib/billing'
import { isYearMonth } from '@/lib/dates'
import { badRequest } from '@/lib/errors'
import { toSen } from '@/lib/money'
import { prisma } from '@/lib/prisma'
import { loadCaller, requireMember } from '@/server/access'
import { isoDateToDb, paidByInvoice, serializeInvoice, type ServiceCtx } from './serialize'

// D49: 100 years still bounds generate_series without rejecting any realistic range.
const MAX_MONTHS = 1200

export type CollectionsRow = { month: string; collectedSen: number }

function monthIndex(ym: string): number {
  return Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1
}

// GET /api/reports/collections: approved payments summed per Malaysia calendar month of received_at.
export async function collectionsReport(ctx: ServiceCtx, from: string, to: string): Promise<CollectionsRow[]> {
  const caller = await loadCaller(ctx.userId)
  const { orgId } = requireMember(caller, ['manager', 'staff'])
  // Bounded so one request cannot ask Postgres for an arbitrarily long series.
  if (!isYearMonth(from) || !isYearMonth(to) || from > to || monthIndex(to) - monthIndex(from) + 1 > MAX_MONTHS) {
    throw badRequest('Invalid range')
  }
  // D25: generate_series gives every month in [from, to] so empty months appear as 0 (brief R29). The
  // series is built on timestamp WITHOUT time zone, so the session TimeZone never shifts a month. A
  // payment's month is its received_at in Asia/Kuala_Lumpur (R3), not UTC: 2026-03-01 00:30 MYT is March.
  // sum(bigint) is numeric, cast back to bigint; toSen turns it into a safe JS number (D3).
  const rows = await prisma.$queryRaw<{ month: string; collected_sen: bigint }[]>`
    with months as (
      select generate_series(
        to_date(${from}, 'YYYY-MM')::timestamp,
        to_date(${to}, 'YYYY-MM')::timestamp,
        interval '1 month'
      ) as m
    ),
    collected as (
      select to_char(p.received_at at time zone 'Asia/Kuala_Lumpur', 'YYYY-MM') as month,
             sum(p.amount_sen) as total
      from public.payments p
      where p.org_id = ${orgId}::uuid
        and p.status = 'approved'
      group by 1
    )
    select to_char(months.m, 'YYYY-MM') as month,
           coalesce(collected.total, 0)::bigint as collected_sen
    from months
    left join collected on collected.month = to_char(months.m, 'YYYY-MM')
    order by months.m`
  return rows.map((r) => ({ month: r.month, collectedSen: toSen(r.collected_sen) }))
}

// Dashboard: number of the org's invoices whose computed status (billing.ts, R27) is overdue at asOf.
export async function overdueCount(ctx: ServiceCtx, asOf: Date): Promise<number> {
  const caller = await loadCaller(ctx.userId)
  const { orgId } = requireMember(caller, ['manager', 'staff'])
  // Prefilter only (an invoice cannot be overdue before its due date has passed in MYT, D5); the
  // decision itself is invoiceStatus, so there is a single definition of overdue.
  const candidates = await prisma.invoices.findMany({
    where: { org_id: orgId, due_date: { lt: isoDateToDb(toMytDate(asOf)) } },
  })
  if (candidates.length === 0) return 0
  const sums = await prisma.payment_allocations.groupBy({
    by: ['invoice_id'],
    where: { org_id: orgId, invoice_id: { in: candidates.map((c) => c.id) } },
    _sum: { amount_sen: true },
  })
  const paid = paidByInvoice(sums)
  return candidates.filter((row) => serializeInvoice(row, paid.get(row.id) ?? 0, asOf).status === 'overdue').length
}
