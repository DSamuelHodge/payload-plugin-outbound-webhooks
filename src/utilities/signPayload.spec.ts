import { describe, expect, it } from 'vitest'

import { signPayload, verifyPayloadSignature } from './signPayload.js'

const SECRET = 'unit-test-secret'
const BODY = JSON.stringify({ event: 'orders.create', docId: 'abc123' })

function freshHeader(body: string = BODY, secret: string = SECRET): string {
  const timestamp = Math.floor(Date.now() / 1000)
  return signPayload({ body, secret, timestamp })
}

describe('signPayload', () => {
  it('produces a header in the expected format', () => {
    expect(freshHeader()).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/)
  })

  it('round-trips through verifyPayloadSignature', () => {
    const header = freshHeader()
    expect(verifyPayloadSignature({ body: BODY, header, secret: SECRET })).toBe(true)
  })
})

describe('verifyPayloadSignature', () => {
  it('rejects a tampered body', () => {
    const header = freshHeader()
    expect(
      verifyPayloadSignature({ body: `${BODY}tampered`, header, secret: SECRET }),
    ).toBe(false)
  })

  it('rejects the wrong secret', () => {
    const header = freshHeader()
    expect(verifyPayloadSignature({ body: BODY, header, secret: 'wrong-secret' })).toBe(false)
  })

  it('rejects a stale timestamp outside the tolerance window', () => {
    const staleTimestamp = Math.floor(Date.now() / 1000) - 3_600
    const header = signPayload({ body: BODY, secret: SECRET, timestamp: staleTimestamp })
    expect(verifyPayloadSignature({ body: BODY, header, secret: SECRET })).toBe(false)
  })

  it('rejects a malformed header', () => {
    expect(verifyPayloadSignature({ body: BODY, header: 'not-a-signature', secret: SECRET })).toBe(
      false,
    )
  })
})
