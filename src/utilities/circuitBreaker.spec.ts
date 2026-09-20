import { describe, expect, it } from 'vitest'
import {
  countConsecutiveFailures,
  DEFAULT_FAILURE_THRESHOLD,
  DEFAULT_PROBE_INTERVAL_MS,
  isBreakerEnabled,
  isProbeDue,
  nextConsecutiveFailures,
  resolveFailureThreshold,
  resolveProbeIntervalMs,
  shouldSkipStaticEndpoint,
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

describe('resolveProbeIntervalMs', () => {
  it('defaults to 5 minutes when unset', () => {
    expect(resolveProbeIntervalMs(undefined)).toBe(DEFAULT_PROBE_INTERVAL_MS)
    expect(resolveProbeIntervalMs(undefined)).toBe(5 * 60 * 1000)
  })

  it('honours an explicit interval, flooring fractions and clamping negatives to 0', () => {
    expect(resolveProbeIntervalMs(60_000)).toBe(60_000)
    expect(resolveProbeIntervalMs(1500.9)).toBe(1500)
    expect(resolveProbeIntervalMs(0)).toBe(0)
    expect(resolveProbeIntervalMs(-100)).toBe(0)
  })

  it('ignores non-finite values', () => {
    expect(resolveProbeIntervalMs(Number.NaN)).toBe(DEFAULT_PROBE_INTERVAL_MS)
  })
})

describe('isProbeDue', () => {
  const NOW = Date.parse('2026-09-20T20:00:00.000Z')
  const ago = (ms: number) => new Date(NOW - ms).toISOString()

  it('is due once the interval has elapsed since the last attempt', () => {
    expect(isProbeDue(ago(10 * 60 * 1000), 5 * 60 * 1000, NOW)).toBe(true)
    expect(isProbeDue(ago(60 * 1000), 5 * 60 * 1000, NOW)).toBe(false)
  })

  it('probes on every delivery when the interval is 0', () => {
    expect(isProbeDue(new Date(NOW).toISOString(), 0, NOW)).toBe(true)
  })

  it('accepts Date instances as well as ISO strings', () => {
    expect(isProbeDue(new Date(NOW - 10 * 60 * 1000), 5 * 60 * 1000, NOW)).toBe(true)
    expect(isProbeDue(new Date(NOW - 60 * 1000), 5 * 60 * 1000, NOW)).toBe(false)
  })

  it('fails open toward delivery on missing or unparseable timestamps', () => {
    expect(isProbeDue(undefined, 5 * 60 * 1000, NOW)).toBe(true)
    expect(isProbeDue('not-a-date', 5 * 60 * 1000, NOW)).toBe(true)
  })
})

describe('shouldSkipStaticEndpoint', () => {
  const NOW = Date.parse('2026-09-20T20:00:00.000Z')
  const ago = (ms: number) => new Date(NOW - ms).toISOString()
  const failed = (msAgo: number) => ({ status: 'failed' as const, deliveredAt: ago(msAgo) })
  const delivered = (msAgo: number) => ({ status: 'delivered' as const, deliveredAt: ago(msAgo) })
  const check = (
    attemptsNewestFirst: Array<{ status: 'delivered' | 'failed'; deliveredAt?: string }>,
    extra?: { failureThreshold?: number; probeIntervalMs?: number },
  ) =>
    shouldSkipStaticEndpoint({
      attemptsNewestFirst,
      failureThreshold: 2,
      probeIntervalMs: 5 * 60 * 1000,
      now: NOW,
      ...extra,
    })

  it('does not skip below the threshold, even when every attempt failed', () => {
    expect(check([failed(1000)])).toBe(false)
    expect(check([])).toBe(false)
  })

  it('does not skip when the newest attempt succeeded', () => {
    expect(check([delivered(1000), failed(2000), failed(3000)])).toBe(false)
  })

  it('skips a tripped endpoint while the probe is not yet due', () => {
    expect(check([failed(60 * 1000), failed(2 * 60 * 1000)])).toBe(true)
  })

  it('lets a half-open probe through once the interval has elapsed', () => {
    expect(check([failed(10 * 60 * 1000), failed(11 * 60 * 1000)])).toBe(false)
  })

  it('recovers end-to-end: trip, probe, then a success breaks the streak', () => {
    // Tripped and cooling down: skipped.
    expect(check([failed(60 * 1000), failed(2 * 60 * 1000)])).toBe(true)
    // Cooldown elapsed: probe goes through (not skipped).
    expect(check([failed(10 * 60 * 1000), failed(11 * 60 * 1000)])).toBe(false)
    // The probe succeeded — newest row is now a delivery, streak broken.
    expect(check([delivered(1000), failed(10 * 60 * 1000), failed(11 * 60 * 1000)])).toBe(false)
  })

  it('a failed probe restarts the cooldown', () => {
    // Probe went through and failed 30s ago: back to skipping.
    expect(check([failed(30 * 1000), failed(10 * 60 * 1000)])).toBe(true)
  })

  it('never skips while the breaker is disabled', () => {
    const history = [failed(1000), failed(2000), failed(3000)]
    expect(check(history, { failureThreshold: 0 })).toBe(false)
  })
})
