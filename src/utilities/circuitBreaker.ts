export const DEFAULT_FAILURE_THRESHOLD = 5

/**
 * How long a tripped static endpoint stays skipped before a half-open probe
 * attempt is allowed through (see shouldSkipStaticEndpoint). Five minutes:
 * short enough to self-heal promptly, long enough not to hammer a dead
 * destination on every delivery.
 */
export const DEFAULT_PROBE_INTERVAL_MS = 5 * 60 * 1000

/**
 * Resolves the effective consecutive-failure threshold from plugin config.
 * Falls back to DEFAULT_FAILURE_THRESHOLD; non-finite values are ignored.
 */
export function resolveFailureThreshold(failureThreshold?: number): number {
  if (typeof failureThreshold === 'number' && Number.isFinite(failureThreshold)) {
    return Math.max(0, Math.floor(failureThreshold))
  }
  return DEFAULT_FAILURE_THRESHOLD
}

/** The breaker only acts when the resolved threshold is a positive number. */
export function isBreakerEnabled(failureThreshold?: number): boolean {
  return resolveFailureThreshold(failureThreshold) > 0
}

/**
 * Whether an endpoint with this many consecutive failures should be skipped.
 * A success resets the count to 0, so only an unbroken failure streak trips it.
 */
export function shouldTripBreaker(consecutiveFailures: number, failureThreshold?: number): boolean {
  const threshold = resolveFailureThreshold(failureThreshold)
  return threshold > 0 && consecutiveFailures >= threshold
}

/**
 * Counts the leading run of failures in a newest-first attempt history.
 * Used for endpoints without persistent breaker state (static endpoints),
 * where recent delivery-log rows are the only record. Stops at the first
 * success — anything after that is an older, already-recovered streak.
 */
export function countConsecutiveFailures(
  newestFirst: Array<{ status: 'delivered' | 'failed' }>,
): number {
  let count = 0
  for (const attempt of newestFirst) {
    if (attempt.status !== 'failed') break
    count += 1
  }
  return count
}

/**
 * Computes the counter value to persist after an attempt: reset on success,
 * increment on failure. Treats missing/garbage stored values as 0.
 */
export function nextConsecutiveFailures(
  current: number | undefined,
  outcome: 'delivered' | 'failed',
): number {
  if (outcome === 'delivered') return 0
  const base = typeof current === 'number' && Number.isFinite(current) ? Math.max(0, current) : 0
  return base + 1
}

/**
 * Resolves the half-open probe interval from plugin config.
 * Falls back to DEFAULT_PROBE_INTERVAL_MS; non-finite values are ignored.
 * Zero means "probe on every delivery" (effectively no skip for tripped
 * static endpoints) — a valid escape hatch, not a misconfiguration.
 */
export function resolveProbeIntervalMs(breakerProbeIntervalMs?: number): number {
  if (typeof breakerProbeIntervalMs === 'number' && Number.isFinite(breakerProbeIntervalMs)) {
    return Math.max(0, Math.floor(breakerProbeIntervalMs))
  }
  return DEFAULT_PROBE_INTERVAL_MS
}

/**
 * Whether enough time has passed since the last attempt to let a half-open
 * probe through. Missing or unparseable timestamps probe (fail-open toward
 * delivery — a skipped attempt that never probes can never self-heal).
 */
export function isProbeDue(
  lastAttemptAt: string | Date | undefined,
  probeIntervalMs?: number,
  now?: number,
): boolean {
  const interval = resolveProbeIntervalMs(probeIntervalMs)
  const at =
    typeof lastAttemptAt === 'string'
      ? Date.parse(lastAttemptAt)
      : lastAttemptAt instanceof Date
        ? lastAttemptAt.getTime()
        : Number.NaN
  if (!Number.isFinite(at)) return true
  return (now ?? Date.now()) - at >= interval
}

export interface StaticTripCheck {
  /** Recent attempts for the URL, newest first (as read from the delivery log). */
  attemptsNewestFirst: Array<{ status: 'delivered' | 'failed'; deliveredAt?: string | Date }>
  failureThreshold?: number
  probeIntervalMs?: number
  /** Overrideable clock for tests; defaults to Date.now(). */
  now?: number
}

/**
 * Skip decision for static endpoints (no managed doc, history is the only
 * signal). Returns true when the endpoint should be skipped for this delivery.
 *
 * A tripped endpoint (last `threshold` attempts all failed) is still skipped —
 * *unless* the probe interval has elapsed since the most recent attempt, in
 * which case one attempt is let through (half-open probe). A successful probe
 * lands a `delivered` row on top of the history and breaks the streak, so the
 * endpoint self-heals; a failed probe just extends the streak and restarts the
 * cooldown. Without this, a skipped attempt would never write a log row, and a
 * tripped static endpoint could never recover on its own.
 */
export function shouldSkipStaticEndpoint({
  attemptsNewestFirst,
  failureThreshold,
  probeIntervalMs,
  now,
}: StaticTripCheck): boolean {
  const threshold = resolveFailureThreshold(failureThreshold)
  if (threshold <= 0) return false
  const recent = attemptsNewestFirst.slice(0, threshold)
  if (countConsecutiveFailures(recent) < threshold) return false
  return !isProbeDue(recent[0]?.deliveredAt, probeIntervalMs, now)
}
