/**
 * Decides whether a failed delivery attempt is worth retrying.
 *
 * Network errors and timeouts are always retryable (the endpoint may just be
 * momentarily unreachable). For HTTP responses, most 4xx codes mean the request
 * itself is permanently wrong (bad URL, revoked auth, endpoint deleted) — retrying
 * with the exact same body will fail again every time, so retries are wasted.
 * 408 (timeout) and 429 (rate limited) are the exceptions: both are transient by
 * definition, so they're treated as retryable like a 5xx.
 */
export function isRetryableStatus(status: number): boolean {
  if (status >= 500) return true
  if (status === 408 || status === 429) return true
  if (status >= 400 && status < 500) return false
  // Anything outside the normal 4xx/5xx range (shouldn't happen from `fetch`,
  // but be conservative and retry rather than silently drop a delivery).
  return true
}

/** Network/timeout failures (no HTTP response at all) are always retryable. */
export const RETRYABLE_NETWORK_ERROR = true
