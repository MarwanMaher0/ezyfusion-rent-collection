import type { invoices, leases, payments } from '@/generated/prisma/client'
import { invoiceStatus, type InvoiceKind, type InvoiceStatus } from '@/lib/billing'
import { dateToIso, formatInstantMyt } from '@/lib/dates'
import { toSen } from '@/lib/money'

// Every service takes the verified caller id only; role and org are always re-read from the DB (R37).
export type ServiceCtx = { userId: string }

export type PaymentMethod = 'cash' | 'bank_transfer' | 'online'
export type PaymentStatus = 'pending_verification' | 'approved' | 'rejected' | 'voided'

export type LeaseDto = {
  id: string
  unitId: string
  tenantId: string
  startDate: string
  endDate: string
  monthlyRentSen: number
  depositSen: number
}

export type InvoiceDto = {
  id: string
  kind: InvoiceKind
  periodIndex: number | null
  periodStart: string | null
  periodEnd: string | null
  dueDate: string
  amountSen: number
  paidSen: number
  status: InvoiceStatus
}

export type PaymentDto = {
  id: string
  amountSen: number
  unappliedSen: number
  method: PaymentMethod
  status: PaymentStatus
  receivedAt: string
}

// "YYYY-MM-DD" -> the UTC-midnight Date Prisma expects for a @db.Date column (inverse of dateToIso).
export function isoDateToDb(iso: string): Date {
  const d = new Date(`${iso}T00:00:00.000Z`)
  if (Number.isNaN(d.getTime()) || dateToIso(d) !== iso) throw new Error('Invalid calendar date')
  return d
}

// DB CHECK constraints pin these columns; a value outside them means the schema drifted, so fail loudly.
function asKind(v: string): InvoiceKind {
  if (v === 'deposit' || v === 'rent') return v
  throw new Error('Unexpected invoice kind')
}

function asMethod(v: string): PaymentMethod {
  if (v === 'cash' || v === 'bank_transfer' || v === 'online') return v
  throw new Error('Unexpected payment method')
}

export function asPaymentStatus(v: string): PaymentStatus {
  if (v === 'pending_verification' || v === 'approved' || v === 'rejected' || v === 'voided') return v
  throw new Error('Unexpected payment status')
}

type LeaseRow = Pick<leases, 'id' | 'unit_id' | 'tenant_id' | 'start_date' | 'end_date' | 'monthly_rent_sen' | 'deposit_sen'>
type InvoiceRow = Pick<invoices, 'id' | 'kind' | 'period_index' | 'period_start' | 'period_end' | 'due_date' | 'amount_sen'>
type PaymentRow = Pick<payments, 'id' | 'amount_sen' | 'unapplied_sen' | 'method' | 'status' | 'received_at'>

export function serializeLease(row: LeaseRow): LeaseDto {
  return {
    id: row.id,
    unitId: row.unit_id,
    tenantId: row.tenant_id,
    startDate: dateToIso(row.start_date),
    endDate: dateToIso(row.end_date),
    monthlyRentSen: toSen(row.monthly_rent_sen),
    depositSen: toSen(row.deposit_sen),
  }
}

// R27: paid = sum of allocations; status is computed with billing.ts at read time, never stored.
export function serializeInvoice(row: InvoiceRow, paidSen: number, asOf: Date): InvoiceDto {
  const dueDate = dateToIso(row.due_date)
  const amountSen = toSen(row.amount_sen)
  return {
    id: row.id,
    kind: asKind(row.kind),
    periodIndex: row.period_index,
    periodStart: row.period_start ? dateToIso(row.period_start) : null,
    periodEnd: row.period_end ? dateToIso(row.period_end) : null,
    dueDate,
    amountSen,
    paidSen,
    status: invoiceStatus({ dueDate, amountSen, paidSen }, asOf),
  }
}

export function serializePayment(row: PaymentRow): PaymentDto {
  return {
    id: row.id,
    amountSen: toSen(row.amount_sen),
    unappliedSen: toSen(row.unapplied_sen),
    method: asMethod(row.method),
    status: asPaymentStatus(row.status),
    receivedAt: formatInstantMyt(row.received_at),
  }
}

// R26: allocation order = due date, then deposit before rent, then period index (deposit has none).
// The same order private.allocate_payment uses, so the page lists invoices in the order they fill.
export function compareAllocationOrder(a: InvoiceDto, b: InvoiceDto): number {
  if (a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1
  if (a.kind !== b.kind) return a.kind === 'deposit' ? -1 : 1
  return (a.periodIndex ?? -1) - (b.periodIndex ?? -1)
}

// Sums allocation rows (from a Prisma groupBy) into invoice_id -> paid sen.
export function paidByInvoice(rows: { invoice_id: string; _sum: { amount_sen: bigint | null } }[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const r of rows) map.set(r.invoice_id, r._sum.amount_sen === null ? 0 : toSen(r._sum.amount_sen))
  return map
}
