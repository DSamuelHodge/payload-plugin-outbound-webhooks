import { describe, expect, it } from 'vitest'
import { isRetryableStatus } from './retryPolicy.js'

describe('isRetryableStatus', () => {
  it('treats 5xx as retryable', () => {
    expect(isRetryableStatus(500)).toBe(true)
    expect(isRetryableStatus(502)).toBe(true)
    expect(isRetryableStatus(503)).toBe(true)
  })

  it('treats 429 and 408 as retryable despite being 4xx', () => {
    expect(isRetryableStatus(429)).toBe(true)
    expect(isRetryableStatus(408)).toBe(true)
  })

  it('treats other 4xx as permanent (non-retryable)', () => {
    expect(isRetryableStatus(400)).toBe(false)
    expect(isRetryableStatus(401)).toBe(false)
    expect(isRetryableStatus(403)).toBe(false)
    expect(isRetryableStatus(404)).toBe(false)
    expect(isRetryableStatus(410)).toBe(false)
    expect(isRetryableStatus(422)).toBe(false)
  })

  it('falls back to retryable for unexpected status ranges', () => {
    expect(isRetryableStatus(0)).toBe(true)
    expect(isRetryableStatus(304)).toBe(true)
  })
})
