import { badRequest, toErrorResponse } from '@/lib/errors'

// Wraps a route handler so every thrown error becomes the SPEC error body (D2), never a stack trace.
export function route<C>(handler: (req: Request, ctx: C) => Promise<Response>): (req: Request, ctx: C) => Promise<Response> {
  return async (req, ctx) => {
    try {
      return await handler(req, ctx)
    } catch (e) {
      return toErrorResponse(e)
    }
  }
}

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status })
}

// R45: request bodies are JSON objects; anything else is a 400 before validation.
export async function readJson(req: Request): Promise<Record<string, unknown>> {
  let text: string
  try {
    text = await req.text()
  } catch {
    throw badRequest('Could not read the request body')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw badRequest('Malformed JSON body')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw badRequest('Request body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}
