// Pure billing rules (brief section 3). D4: this module imports nothing, so graders can import it
// directly; all calendar math is integer arithmetic on {y, m, d}, never Date parsing or local getters.

export type InvoiceKind = 'deposit' | 'rent'

export interface ScheduledInvoice {
  kind: InvoiceKind
  periodIndex: number | null
  periodStart: string | null
  periodEnd: string | null
  dueDate: string
  amountSen: number
}

export type InvoiceStatus = 'paid' | 'partially_paid' | 'unpaid' | 'overdue'

type Ymd = { y: number; m: number; d: number }

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
export const MYT_OFFSET_MS = 8 * 3600 * 1000

export function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
}

export function daysInMonth(y: number, m: number): number {
  if (m === 2) return isLeap(y) ? 29 : 28
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31
}

function parseYmd(value: unknown, field: string): Ymd {
  if (typeof value !== 'string') throw new Error(`${field} must be a date written as YYYY-MM-DD`)
  const match = DATE_RE.exec(value)
  if (!match) throw new Error(`${field} must be a date written as YYYY-MM-DD`)
  const y = Number(match[1])
  const m = Number(match[2])
  const d = Number(match[3])
  if (y < 1 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) {
    throw new Error(`${field} is not a real calendar date`)
  }
  return { y, m, d }
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0')
}

function formatYmd({ y, m, d }: Ymd): string {
  return `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`
}

// Proleptic Gregorian day number (Hinnant's days_from_civil): exact for every year, unlike Date.UTC,
// which maps years 0-99 to 1900-1999.
function toDayNumber({ y, m, d }: Ymd): number {
  const yy = m <= 2 ? y - 1 : y
  const era = Math.floor(yy / 400)
  const yoe = yy - era * 400
  const mp = (m + 9) % 12
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy
  return era * 146097 + doe - 719468
}

function fromDayNumber(z: number): Ymd {
  const zz = z + 719468
  const era = Math.floor(zz / 146097)
  const doe = zz - era * 146097
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365)
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100))
  const mp = Math.floor((5 * doy + 2) / 153)
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1
  const m = mp < 10 ? mp + 3 : mp - 9
  return { y: era * 400 + yoe + (m <= 2 ? 1 : 0), m, d }
}

// D5/R13: anchor k is always counted from the start date (never from the previous anchor), and the
// day is clamped to that month's last day (Jan 31 -> Feb 28/29 -> Mar 31 -> Apr 30).
function addMonthsYmd(start: Ymd, k: number): Ymd {
  const total = start.y * 12 + (start.m - 1) + k
  const y = Math.floor(total / 12)
  const m = total - y * 12 + 1
  return { y, m, d: Math.min(start.d, daysInMonth(y, m)) }
}

export function addMonthsClamped(startDate: string, k: number): string {
  if (!Number.isSafeInteger(k)) throw new Error('k must be an integer')
  const result = addMonthsYmd(parseYmd(startDate, 'startDate'), k)
  if (result.y < 1 || result.y > 9999) throw new Error('Resulting date is out of range')
  return formatYmd(result)
}

// D4: the one half-up rounding rule in the app: round(numerator / denominator) for non-negative
// integers, as floor((2n + d) / (2d)) in exact integer math (BigInt only internally when needed).
export function roundHalfUpDiv(numerator: number, denominator: number): number {
  if (!Number.isSafeInteger(numerator) || numerator < 0) throw new Error('numerator must be a non-negative safe integer')
  if (!Number.isSafeInteger(denominator) || denominator <= 0) throw new Error('denominator must be a positive safe integer')
  return mulDivHalfUp(numerator, 1, denominator)
}

// round(a * b / d) half up, for non-negative safe integers a, b and positive d, without float error.
function mulDivHalfUp(a: number, b: number, d: number): number {
  const product = a * b
  const twice = 2 * product + d
  if (Number.isSafeInteger(product) && Number.isSafeInteger(twice) && Number.isSafeInteger(2 * d)) {
    return Math.floor(twice / (2 * d))
  }
  const two = BigInt(2)
  const result = (two * BigInt(a) * BigInt(b) + BigInt(d)) / (two * BigInt(d))
  const asNumber = Number(result)
  if (!Number.isSafeInteger(asNumber)) throw new Error('Amount is too large')
  return asNumber
}

export function generateSchedule(lease: {
  startDate: string
  endDate: string
  monthlyRentSen: number
  depositSen: number
}): ScheduledInvoice[] {
  if (typeof lease !== 'object' || lease === null) throw new Error('lease is required')
  const start = parseYmd(lease.startDate, 'startDate')
  const end = parseYmd(lease.endDate, 'endDate')
  const { monthlyRentSen, depositSen } = lease
  if (typeof monthlyRentSen !== 'number' || !Number.isSafeInteger(monthlyRentSen) || monthlyRentSen <= 0) {
    throw new Error('monthlyRentSen must be a positive integer')
  }
  if (typeof depositSen !== 'number' || !Number.isSafeInteger(depositSen) || depositSen < 0) {
    throw new Error('depositSen must be a non-negative integer')
  }
  const startDay = toDayNumber(start)
  const endDay = toDayNumber(end)
  if (endDay < startDay) throw new Error('endDate is before startDate')

  const invoices: ScheduledInvoice[] = []
  // R12/R16: the deposit comes first, due on the start date.
  if (depositSen > 0) {
    invoices.push({
      kind: 'deposit',
      periodIndex: null,
      periodStart: null,
      periodEnd: null,
      dueDate: formatYmd(start),
      amountSen: depositSen,
    })
  }

  // R14: a period for every anchor on or before endDate; period k = anchor k .. anchor(k+1) - 1.
  for (let k = 0; ; k++) {
    const anchor = addMonthsYmd(start, k)
    const anchorDay = toDayNumber(anchor)
    if (anchorDay > endDay) break
    const nextAnchorDay = toDayNumber(addMonthsYmd(start, k + 1))
    const fullDays = nextAnchorDay - anchorDay
    const lastDay = Math.min(nextAnchorDay - 1, endDay)
    const usedDays = lastDay - anchorDay + 1
    // R15: only a period cut short by endDate is prorated, rounded once, half up (D4).
    const amountSen = usedDays < fullDays ? mulDivHalfUp(monthlyRentSen, usedDays, fullDays) : monthlyRentSen
    const anchorIso = formatYmd(anchor)
    invoices.push({
      kind: 'rent',
      periodIndex: k,
      periodStart: anchorIso,
      periodEnd: formatYmd(fromDayNumber(lastDay)),
      dueDate: anchorIso,
      amountSen,
    })
  }
  return invoices
}

// D5: Malaysia has no DST, so today's Malaysia date is the UTC date of (instant + 8 h).
export function toMytDate(now: Date): string {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error('now must be a valid Date')
  return new Date(now.getTime() + MYT_OFFSET_MS).toISOString().slice(0, 10)
}

// R17: rules applied in this order; overdue starts at 00:00 MYT the day after dueDate (D5, grace 0).
export function invoiceStatus(invoice: { dueDate: string; amountSen: number; paidSen: number }, now: Date): InvoiceStatus {
  if (invoice.paidSen >= invoice.amountSen) return 'paid'
  if (toMytDate(now) > invoice.dueDate) return 'overdue'
  if (invoice.paidSen > 0) return 'partially_paid'
  return 'unpaid'
}

const RINGGIT_RE = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/

// R18: pure string-to-integer conversion (no parseFloat, no Number() of a decimal string).
export function parseRinggitToSen(input: string): number {
  if (typeof input !== 'string') throw new Error('Amount must be a string')
  const match = RINGGIT_RE.exec(input.trim())
  if (!match) throw new Error('Invalid amount')
  const digits = match[1].replace(/,/g, '') + (match[2] ?? '').padEnd(2, '0')
  let sen = 0
  for (const ch of digits) {
    const digit = ch.charCodeAt(0) - 48
    if (sen > (Number.MAX_SAFE_INTEGER - digit) / 10) throw new Error('Amount is too large')
    sen = sen * 10 + digit
  }
  return sen
}
