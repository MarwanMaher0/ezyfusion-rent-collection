// D3/D4: money is integer sen; parsing and the single rounding rule live in billing.ts (pure, imported
// directly by graders) and are re-exported here so app code has one money entry point.
export { parseRinggitToSen, roundHalfUpDiv } from './billing'

// D3: the one place a Prisma BigInt (bigint sen column) becomes a JS number; refuses unsafe values.
export function toSen(v: bigint | number): number {
  if (typeof v === 'bigint') {
    if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new Error('Amount is outside the safe integer range')
    }
    return Number(v)
  }
  if (!Number.isSafeInteger(v)) throw new Error('Amount must be a safe integer')
  return v
}

// "RM 1,500.00"; built from integer digits (no Intl, so server and browser render identically).
export function formatSen(sen: number): string {
  const value = toSen(sen)
  const abs = Math.abs(value)
  const ringgit = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const cents = String(abs % 100).padStart(2, '0')
  return `${value < 0 ? '-' : ''}RM ${ringgit}.${cents}`
}
