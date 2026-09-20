import type { CollectionSlug } from 'payload'

/** The lifecycle events this plugin can fire webhooks for. */
export type WebhookEvent = 'create' | 'update' | 'delete'

/**
 * A single outbound webhook destination.
 * Can be supplied statically via plugin options, or created/edited in the
 * admin UI if the `webhookEndpoints` collection is enabled.
 */
export interface WebhookEndpoint {
  /** Unique id, used in logs and for de-duplication when merging static + DB endpoints. */
  id?: string
  /** Human-readable label shown in the admin UI. */
  label?: string
  /** Destination URL the payload will be POSTed to. */
  url: string
  /**
   * Which collection.event combinations trigger this endpoint, e.g. `['posts.update', 'orders.create']`.
   * Use `'*'` on either side as a wildcard, e.g. `'orders.*'` or `'*.delete'`.
   */
  subscriptions: string[]
  /** Shared secret used to HMAC-sign the request body. Required to enable signature verification. */
  secret?: string
  /** Extra static headers to send with every request to this endpoint. */
  headers?: Record<string, string>
  /** Set to false to keep the endpoint configured but stop sending to it. @default true */
  active?: boolean
  /**
   * Consecutive delivery failures recorded by the circuit-breaker. Managed by
   * the delivery job on admin-managed (`webhookEndpoints` collection) endpoints;
   * reset to 0 on every success.
   */
  consecutiveFailures?: number
  /**
   * Set automatically once `consecutiveFailures` reaches `failureThreshold`.
   * Skipped by delivery until an editor unchecks it, which also resets
   * `consecutiveFailures` to 0 for a fresh run at the threshold.
   */
  autoDisabled?: boolean
  /** ISO timestamp of the most recent failed attempt. Set by the delivery job. */
  lastFailureAt?: string
}

/** Per-collection webhook configuration. */
export interface CollectionWebhookConfig {
  /** Which operations on this collection should queue a webhook delivery. @default ['create', 'update', 'delete'] */
  events?: WebhookEvent[]
  /**
   * Optional per-document filter. Return false to skip firing for a given change
   * (e.g. only fire on `update` when a `status` field just became `'published'`).
   */
  filter?: (args: {
    doc: Record<string, unknown>
    previousDoc?: Record<string, unknown>
    event: WebhookEvent
  }) => boolean | Promise<boolean>
}

export type OutboundWebhooksPluginConfig = {
  /** Disable the plugin without removing it from the config array. @default true */
  enabled?: boolean
  /** Collections to watch, keyed by slug. Only listed collections get hooks attached. */
  collections: {
    [key in CollectionSlug]?: CollectionWebhookConfig
  }
  /** Statically configured endpoints, merged at delivery time with any stored in the `webhookEndpoints` collection. */
  endpoints?: WebhookEndpoint[]
  /**
   * Let editors manage additional webhook endpoints from the admin UI by adding a
   * `webhookEndpoints` collection. @default true
   */
  enableEndpointsCollection?: boolean
  /**
   * Persist a record of every delivery attempt (status, response code, error) by adding
   * a `webhookLogs` collection. Useful for debugging, costs one extra collection. @default true
   */
  enableDeliveryLog?: boolean
  /** Number of delivery attempts before giving up. @default 5 */
  maxRetries?: number
  /**
   * Consecutive delivery failures after which an endpoint is automatically
   * disabled (circuit-breaker). Applies to admin-managed endpoints via
   * persistent counters, and to static endpoints via recent delivery history
   * (which requires `enableDeliveryLog`). Set to 0 to disable. @default 5
   */
  failureThreshold?: number
  /**
   * How long a tripped static endpoint stays skipped before one probe attempt
   * is let through (half-open). A successful probe self-heals the endpoint; a
   * failed one restarts the cooldown. Set to 0 to probe on every delivery.
   * @default 300000 (5 minutes)
   */
  breakerProbeIntervalMs?: number
  /** Request timeout in milliseconds per delivery attempt. @default 10000 */
  timeoutMs?: number
  /** Override the slug used for the endpoints collection. @default 'webhookEndpoints' */
  endpointsCollectionSlug?: string
  /** Override the slug used for the delivery log collection. @default 'webhookLogs' */
  logsCollectionSlug?: string
}
