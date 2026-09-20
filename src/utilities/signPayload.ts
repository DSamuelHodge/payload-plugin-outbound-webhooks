import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Signs a webhook body the way Stripe/GitHub do: HMAC-SHA256 over `${timestamp}.${body}`,
 * so a receiver can verify authenticity and reject stale/replayed requests.
 *
 * Returns a header value like: `t=1730000000,v1=<hex-digest>`
 */
export function signPayload({ body, secret, timestamp }: { body: string; secret: string; timestamp: number }): string {
  const signedPayload = `${timestamp}.${body}`
  const digest = createHmac('sha256', secret).update(signedPayload).digest('hex')
  return `t=${timestamp},v1=${digest}`
}

/**
 * Reference verifier for consumers of this plugin's webhooks (not used internally —
 * include this snippet, or the equivalent in another language, in your receiver).
 */
export function verifyPayloadSignature({
  body,
  header,
  secret,
  toleranceSeconds = 300,
}: {
  body: string
  header: string
  secret: string
  toleranceSeconds?: number
}): boolean {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]))
  const timestamp = Number(parts.t)
  const signature = parts.v1
  if (!timestamp || !signature) return false
  if (Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) return false

  const expected = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
  const expectedBuf = Buffer.from(expected, 'hex')
  const actualBuf = Buffer.from(signature, 'hex')
  if (expectedBuf.length !== actualBuf.length) return false
  return timingSafeEqual(expectedBuf, actualBuf)
}
