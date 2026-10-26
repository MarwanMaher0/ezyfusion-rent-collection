import { ZodError } from 'zod'

// D2: every error body is { "error": "<message>" }, a plain string (brief section 7).
export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export const badRequest = (msg = 'Invalid input') => new ApiError(400, msg)
export const unauthorized = (msg = 'Unauthorized') => new ApiError(401, msg)
export const forbidden = (msg = 'Forbidden') => new ApiError(403, msg)
export const notFound = (msg = 'Not found') => new ApiError(404, msg)
export const conflict = (msg = 'Conflict') => new ApiError(409, msg)
export const unprocessable = (msg = 'Unprocessable') => new ApiError(422, msg)

export function errorResponse(status: number, message: string): Response {
  return Response.json({ error: message }, { status })
}

type PgError = { code: string; message: string }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

// Finds the Postgres SQLSTATE behind an error, wherever the stack put it:
// - Prisma 7 + adapter-pg: PrismaClientKnownRequestError.meta.driverAdapterError.cause.{originalCode, originalMessage}
//   ($queryRaw failures arrive as P2010 with the real SQLSTATE only there);
// - a bare DriverAdapterError (.cause.originalCode), or a pg DatabaseError (.code + .severity).
function findPgError(e: unknown, depth = 0): PgError | null {
  if (!isRecord(e) || depth > 4) return null
  if (typeof e.originalCode === 'string') {
    return { code: e.originalCode, message: typeof e.originalMessage === 'string' ? e.originalMessage : '' }
  }
  if (typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code) && typeof e.severity === 'string') {
    return { code: e.code, message: typeof e.message === 'string' ? e.message : '' }
  }
  if (isRecord(e.meta)) {
    const found = findPgError(e.meta.driverAdapterError, depth + 1)
    if (found) return found
  }
  return findPgError(e.cause, depth + 1)
}

function prismaCode(e: unknown): string | null {
  return isRecord(e) && typeof e.code === 'string' && /^P\d{4}$/.test(e.code) ? e.code : null
}

const RETRYABLE_SQLSTATES = new Set(['40001', '40P01'])

export function isRetryable(e: unknown): boolean {
  const pg = findPgError(e)
  if (pg) return RETRYABLE_SQLSTATES.has(pg.code)
  return prismaCode(e) === 'P2034'
}

// Error contract: serialization failure / deadlock is retried once, then surfaces as 409.
export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (!isRetryable(e)) throw e
    return fn()
  }
}

function zodMessage(e: ZodError): string {
  const issue = e.issues[0]
  if (!issue) return 'Invalid input'
  const path = issue.path.map(String).join('.')
  return path ? `Invalid input: ${path}: ${issue.message}` : `Invalid input: ${issue.message}`
}

const DB_CODE_STATUS: Record<string, { status: number; message: string | null }> = {
  // private.* functions raise these with a human message that is safe to show (SPEC money functions).
  P0400: { status: 400, message: null },
  P0404: { status: 404, message: null },
  P0409: { status: 409, message: null },
  P0422: { status: 422, message: null },
  '23P01': { status: 409, message: 'Lease overlaps another lease on this unit' }, // D16
  '23505': { status: 409, message: 'Conflict with an existing record' },
  '22P02': { status: 400, message: 'Invalid input' },
  '22007': { status: 400, message: 'Invalid input' },
  '22008': { status: 400, message: 'Invalid input' },
  '23503': { status: 400, message: 'Invalid reference' },
  '23514': { status: 400, message: 'Invalid input' },
  '23502': { status: 400, message: 'Invalid input' },
  '40001': { status: 409, message: 'Conflict with a concurrent request, please retry' },
  '40P01': { status: 409, message: 'Conflict with a concurrent request, please retry' },
}

const PRISMA_CODE_STATUS: Record<string, { status: number; message: string }> = {
  P2002: { status: 409, message: 'Conflict with an existing record' },
  P2025: { status: 404, message: 'Not found' },
  P2023: { status: 400, message: 'Invalid input' },
  P2003: { status: 400, message: 'Invalid reference' },
  P2034: { status: 409, message: 'Conflict with a concurrent request, please retry' },
}

export function toErrorResponse(e: unknown): Response {
  if (e instanceof ApiError) return errorResponse(e.status, e.message)
  if (e instanceof ZodError) return errorResponse(400, zodMessage(e))

  const pg = findPgError(e)
  if (pg) {
    const mapped = DB_CODE_STATUS[pg.code]
    if (mapped) {
      const fallback = mapped.status === 404 ? 'Not found' : 'Invalid request'
      return errorResponse(mapped.status, mapped.message ?? (pg.message.trim() || fallback))
    }
  }
  const pc = prismaCode(e)
  if (pc && PRISMA_CODE_STATUS[pc]) {
    const { status, message } = PRISMA_CODE_STATUS[pc]
    return errorResponse(status, message)
  }

  // Generic 500: only the error class and code are logged (no payloads, no SQL, no secrets).
  const name = isRecord(e) && typeof e.name === 'string' ? e.name : typeof e
  console.error('[api] unhandled error', { name, code: pg?.code ?? pc ?? null })
  return errorResponse(500, 'Internal error')
}
