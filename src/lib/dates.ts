// R3/D5/D6: every instant the app shows or accepts is Malaysia time. Malaysia has a fixed +08:00 offset
// (no DST), so conversions are exact integer shifts and never depend on the machine or browser zone.
// One copy of the calendar rules: month lengths, leap years and the MYT offset live in billing.ts (pure).
import { daysInMonth, MYT_OFFSET_MS } from './billing'

export { toMytDate, addMonthsClamped, daysInMonth, isLeap, MYT_OFFSET_MS } from './billing'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|([+-])(\d{2}):(\d{2}))$/
const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/
const YEAR_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

function validParts(y: number, mo: number, d: number, h: number, mi: number, s: number): boolean {
  return y >= 1 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo) && h <= 23 && mi <= 59 && s <= 59
}

function utcMs(y: number, mo: number, d: number, h: number, mi: number, s: number, ms: number): number {
  const t = new Date(0)
  // setUTCFullYear, unlike Date.UTC, keeps years 0-99 as written.
  t.setUTCFullYear(y, mo - 1, d)
  t.setUTCHours(h, mi, s, ms)
  return t.getTime()
}

function assertValidDate(d: Date): void {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) throw new Error('Invalid date')
}

// D6: output instants as ISO 8601 in MYT with an explicit offset, e.g. 2026-01-31T10:00:00+08:00.
// Milliseconds are kept only when non-zero, so the value round-trips exactly.
export function formatInstantMyt(d: Date): string {
  assertValidDate(d)
  const shifted = new Date(d.getTime() + MYT_OFFSET_MS).toISOString()
  const ms = shifted.slice(20, 23)
  return `${shifted.slice(0, 19)}${ms === '000' ? '' : `.${ms}`}+08:00`
}

// D6: accept only ISO 8601 date-times that carry Z or a ±HH:MM offset; a naive time is ambiguous.
export function parseInstantWithOffset(s: string): Date {
  if (typeof s !== 'string') throw new Error('Instant must be a string')
  const m = INSTANT_RE.exec(s)
  if (!m) throw new Error('Instant must be ISO 8601 with a Z or ±HH:MM offset')
  const [y, mo, d, h, mi] = [m[1], m[2], m[3], m[4], m[5]].map(Number)
  const sec = m[6] === undefined ? 0 : Number(m[6])
  const ms = m[7] === undefined ? 0 : Number(m[7].slice(0, 3).padEnd(3, '0'))
  if (!validParts(y, mo, d, h, mi, sec)) throw new Error('Instant is not a real date-time')
  let offsetMin = 0
  if (m[8] !== 'Z') {
    const oh = Number(m[10])
    const om = Number(m[11])
    if (oh > 23 || om > 59) throw new Error('Invalid offset')
    offsetMin = (m[9] === '-' ? -1 : 1) * (oh * 60 + om)
  }
  return new Date(utcMs(y, mo, d, h, mi, sec, ms) - offsetMin * 60_000)
}

// D26: an <input type="datetime-local"> value is read as Malaysia time, never the browser's zone.
export function mytLocalToIso(dateTimeLocal: string): string {
  if (typeof dateTimeLocal !== 'string') throw new Error('Date-time must be a string')
  const m = LOCAL_RE.exec(dateTimeLocal)
  if (!m) throw new Error('Date-time must be YYYY-MM-DDTHH:MM')
  const [y, mo, d, h, mi] = [m[1], m[2], m[3], m[4], m[5]].map(Number)
  const sec = m[6] ?? '00'
  if (!validParts(y, mo, d, h, mi, Number(sec))) throw new Error('Not a real date-time')
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${sec}+08:00`
}

// Prisma returns @db.Date as UTC midnight; its UTC date part is the calendar date.
export function dateToIso(d: Date): string {
  assertValidDate(d)
  return d.toISOString().slice(0, 10)
}

// "31 Jan 2026, 10:00" in MYT. Built by hand (no Intl), so Node and every browser produce the same
// string and server-rendered text never causes a hydration mismatch (R52).
export function formatMytDisplay(d: Date): string {
  assertValidDate(d)
  const iso = new Date(d.getTime() + MYT_OFFSET_MS).toISOString()
  const day = Number(iso.slice(8, 10))
  const month = MONTHS[Number(iso.slice(5, 7)) - 1]
  return `${day} ${month} ${iso.slice(0, 4)}, ${iso.slice(11, 16)}`
}

export function isYearMonth(s: string): boolean {
  // Year 0000 does not exist (Postgres reads it as 1 BC), so it is not a valid month (D49).
  return typeof s === 'string' && YEAR_MONTH_RE.test(s) && !s.startsWith('0000')
}
