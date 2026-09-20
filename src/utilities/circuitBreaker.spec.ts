import { describe, expect, it } from 'vitest'
import {
  countConsecutiveFailures,
  DEFAULT_FAILURE_THRESHOLD,
  isBreakerEnabled,
  nextConsecutiveFailures,
  resolveFailureThreshold,
  shouldTripBreaker,
} from './circuitBreaker.js'

describe('resolveFailureThreshold', () => {
  it('defaults to 5 when unset', () => {
    expect(resolveFailureThreshold(undefined)).toBe(DEFAULT_FAILURE_THRESHOLD)
    expect(resolveFailureThreshold(undefined)).toBe(5)
  })

  it('honours an explicit threshold', () => {
    expect(resolveFailureThreshold(2)).toBe(2)
  })

  it('floors fractional values and ignores non-finite ones', () => {
    expect(resolveFailureThreshold(2.9)).toBe(2)
    expect(resolveFailureThreshold(Number.NaN)).toBe(DEFAULT_FAILURE_THRESHOLD)
  })
})

describe('isBreakerEnabled', () => {
  it('is enabled by default', () => {
    expect(isBreakerEnabled(undefined)).toBe(true)
  })

  it('is disabled when the threshold is 0 or negative', () => {
    expect(isBreakerEnabled(0)).toBe(false)
    expect(isBreakerEnabled(-3)).toBe(false)
  })
})

describe('shouldTripBreaker', () => {
  it('trips once failures reach the threshold', () => {
    expect(shouldTripBreaker(4, 5)).toBe(false)
    expect(shouldTripBreaker(5, 5)).toBe(true)
    expect(shouldTripBreaker(9, 5)).toBe(true)
  })

  it('never trips while disabled', () => {
    expect(shouldTripBreaker(100, 0)).toBe(false)
  })
})

describe('countConsecutiveFailures', () => {
  it('counts the leading failure run in newest-first history', () => {
    expect(
      countConsecutiveFailures([{ status: 'failed' }, { status: 'failed' }, { status: 'delivered' }]),
    ).toBe(2)
  })

  it('returns 0 when the newest attempt succeeded', () => {
    expect(countConsecutiveFailures([{ status: 'delivered' }, { status: 'failed' }])).toBe(0)
  })

  it('handles empty history', () => {
    expect(countConsecutiveFailures([])).toBe(0)
  })
})

describe('nextConsecutiveFailures', () => {
  it('resets to 0 on success', () => {
    expect(nextConsecutiveFailures(4, 'delivered')).toBe(0)
  })

  it('increments on failure, treating missing values as 0', () => {
    expect(nextConsecutiveFailures(undefined, 'failed')).toBe(1)
    expect(nextConsecutiveFailures(2, 'failed')).toBe(3)
  })
})
