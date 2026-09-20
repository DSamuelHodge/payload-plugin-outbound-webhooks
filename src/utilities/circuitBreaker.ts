export const DEFAULT_FAILURE_THRESHOLD = 5

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
