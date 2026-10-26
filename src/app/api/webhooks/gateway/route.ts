import { json } from '@/server/http'
import { handleGatewayCallback } from '@/server/services/webhook'

// POST /api/webhooks/gateway (R32-R35). Not behind a login (the proxy matcher skips /api/webhooks); the
// HMAC is the only credential. The raw text is read once (never formData) so the signed fields are
// exactly the bytes the gateway sent.
export async function POST(req: Request): Promise<Response> {
  let rawBody: string
  try {
    rawBody = await req.text()
  } catch {
    return json({ error: 'Invalid signature' }, 401)
  }
  const result = await handleGatewayCallback(rawBody, req.headers.get('content-type'))
  return json(result.body, result.status)
}
