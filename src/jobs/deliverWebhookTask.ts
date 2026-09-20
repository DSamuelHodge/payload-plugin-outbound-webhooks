import type { Payload, TaskConfig } from 'payload'

import type { OutboundWebhooksPluginConfig, WebhookEndpoint } from '../types.js'
import {
  countConsecutiveFailures,
  isBreakerEnabled,
  nextConsecutiveFailures,
  resolveFailureThreshold,
} from '../utilities/circuitBreaker.js'
import { resolveEndpoints } from '../utilities/resolveEndpoints.js'
import { signPayload } from '../utilities/signPayload.js'
import { isRetryableStatus } from '../utilities/retryPolicy.js'

export const DELIVER_WEBHOOK_TASK_SLUG = 'deliverWebhook' as const

export interface DeliverWebhookInput {
  /** Stable across every retry of this job — see createEventHooks.ts. */
  deliveryId: string
  collectionSlug: string
  event: 'create' | 'update' | 'delete'
  docId: string | number
  doc: Record<string, unknown>
  previousDoc?: Record<string, unknown>
  occurredAt: string
}

/**
 * Looks up which endpoints (by URL) this deliveryId has already been resolved for —
 * either delivered successfully, or permanently failed (non-retryable) — so a job
 * retry only re-attempts endpoints that are still pending. Returns an empty set (i.e.
 * "attempt everything") when the log collection is disabled, since there's nowhere
 * to read prior state from; in that setup receivers must rely on `deliveryId` alone
 * to dedupe any redelivery.
 */
async function getResolvedEndpointUrls({
  payload,
  pluginConfig,
  deliveryId,
}: {
  payload: Payload
  pluginConfig: OutboundWebhooksPluginConfig
  deliveryId: string
}): Promise<Set<string>> {
  if (pluginConfig.enableDeliveryLog === false) return new Set()

  const slug = pluginConfig.logsCollectionSlug ?? 'webhookLogs'
  try {
    const result = await payload.find({
      collection: slug as 'webhookLogs',
      where: {
        and: [
          { deliveryId: { equals: deliveryId } },
          { or: [{ status: { equals: 'delivered' } }, { retryable: { equals: false } }] },
        ],
      },
      limit: 0,
      depth: 0,
      overrideAccess: true,
    })
    return new Set(result.docs.map((d) => (d as unknown as { endpointUrl: string }).endpointUrl))
  } catch {
    // If the lookup itself fails, fall back to attempting every endpoint again —
    // safer to risk a duplicate delivery than to silently drop one.
    return new Set()
  }
}

/**
 * Builds the Payload Job task definition. Returned as a factory so the task's handler
 * can close over the plugin's own config (endpoints, timeout, log collection slug)
 * without Payload's job system needing to know about any of that.
 */
export function buildDeliverWebhookTask(pluginConfig: OutboundWebhooksPluginConfig): TaskConfig<'deliverWebhook'> {
  return {
    slug: DELIVER_WEBHOOK_TASK_SLUG,
    retries: pluginConfig.maxRetries ?? 5,
    inputSchema: [
      { name: 'deliveryId', type: 'text', required: true },
      { name: 'collectionSlug', type: 'text', required: true },
      { name: 'event', type: 'text', required: true },
      { name: 'docId', type: 'text', required: true },
      { name: 'doc', type: 'json', required: true },
      { name: 'previousDoc', type: 'json' },
      { name: 'occurredAt', type: 'text', required: true },
    ],
    outputSchema: [
      { name: 'delivered', type: 'number', required: true },
      { name: 'permanentlyFailed', type: 'number', required: true },
      { name: 'retryableFailed', type: 'number', required: true },
      { name: 'skipped', type: 'number', required: true },
    ],
    handler: async ({ input, req }) => {
      const { deliveryId, collectionSlug, event, docId, doc, previousDoc, occurredAt } = input as DeliverWebhookInput
      const payload = req.payload
      const breakerThreshold = resolveFailureThreshold(pluginConfig.failureThreshold)
      const breakerOn = isBreakerEnabled(pluginConfig.failureThreshold)

      const allEndpoints = await resolveEndpoints({ payload, pluginConfig, collectionSlug, event })

      // On a fresh job this is empty. On a retry, it's every endpoint we've already
      // delivered to or permanently failed against for this exact deliveryId — skip
      // them so a retry only touches endpoints that are still pending.
      const alreadyResolved = await getResolvedEndpointUrls({ payload, pluginConfig, deliveryId })
      const endpoints = allEndpoints.filter((e) => !alreadyResolved.has(e.url))

      let delivered = 0
      let permanentlyFailed = 0
      let retryableFailed = 0
      let skipped = 0

      for (const endpoint of endpoints) {
        // Circuit-breaker, history path: endpoints without a managed
        // `webhookEndpoints` doc (static endpoints, or the endpoints collection
        // is disabled) keep no persistent counter, so a streak of recent
        // failures in the delivery log is the trip signal. Doc-backed endpoints
        // carry their own counter (see recordBreakerOutcome) and were already
        // filtered by resolveEndpoints once tripped.
        if (
          breakerOn &&
          !isDocManagedEndpoint(pluginConfig, endpoint) &&
          (await isTrippedByHistory({ payload, pluginConfig, url: endpoint.url, threshold: breakerThreshold }))
        ) {
          skipped += 1
          continue
        }

        const outcome = await attemptDelivery({ endpoint, deliveryId, collectionSlug, event, docId, doc, previousDoc, occurredAt, pluginConfig })

        await logDelivery({ payload, pluginConfig, endpoint, deliveryId, event: `${collectionSlug}.${event}`, docId, ...outcome })

        // Circuit-breaker, persistent path: fold this attempt into the
        // endpoint doc's failure streak, tripping `autoDisabled` at threshold.
        // Works even with the delivery log disabled.
        await recordBreakerOutcome({
          payload,
          pluginConfig,
          endpoint,
          outcome: outcome.status,
          threshold: breakerThreshold,
          breakerOn,
        })

        if (outcome.status === 'delivered') delivered += 1
        else if (outcome.retryable) retryableFailed += 1
        else permanentlyFailed += 1
      }

      // Only retryable failures (network errors, timeouts, 5xx, 408, 429) trigger
      // a job retry. Permanent failures (most 4xx — bad URL, revoked auth, deleted
      // endpoint) are logged and left alone; retrying them would just repeat the
      // same result every time and burn through the retry budget for nothing.
      // Receivers should still dedupe on `deliveryId`, since a retry can legitimately
      // redeliver to an endpoint that failed with a transient error last time.
      if (retryableFailed > 0) {
        throw new Error(
          `Webhook delivery: ${retryableFailed} retryable failure(s) on ${collectionSlug}.${event} doc ${String(docId)} (deliveryId ${deliveryId})`,
        )
      }

      return { output: { delivered, permanentlyFailed, retryableFailed, skipped } }
    },
  }
}

/** Endpoints carrying a `webhookEndpoints` doc id get persistent breaker state. */
function isDocManagedEndpoint(
  pluginConfig: OutboundWebhooksPluginConfig,
  endpoint: WebhookEndpoint,
): boolean {
  return pluginConfig.enableEndpointsCollection !== false && endpoint.id != null
}

/**
 * Log-derived trip check for endpoints without a managed doc. Reads at most
 * `threshold` recent attempts for the URL (newest first) and trips when every
 * one of them failed. Fail-open: a broken lookup attempts delivery rather
 * than silently dropping it.
 */
async function isTrippedByHistory({
  payload,
  pluginConfig,
  url,
  threshold,
}: {
  payload: Payload
  pluginConfig: OutboundWebhooksPluginConfig
  url: string
  threshold: number
}): Promise<boolean> {
  if (pluginConfig.enableDeliveryLog === false) return false

  const slug = pluginConfig.logsCollectionSlug ?? 'webhookLogs'
  try {
    const result = await payload.find({
      collection: slug as 'webhookLogs',
      where: { endpointUrl: { equals: url } },
      sort: '-deliveredAt',
      limit: threshold,
      depth: 0,
      overrideAccess: true,
    })
    return (
      countConsecutiveFailures(
        result.docs as unknown as Array<{ status: 'delivered' | 'failed' }>,
      ) >= threshold
    )
  } catch {
    return false
  }
}

/**
 * Folds an attempt into a doc-backed endpoint's failure streak. Success resets
 * the counter; failure increments it and trips `autoDisabled` at threshold —
 * after which resolveEndpoints skips the endpoint until an editor re-enables it.
 *
 * The update is guarded by URL as well as id: static endpoints may carry a
 * custom `id` that must never touch an unrelated admin-managed doc (a
 * non-matching where-update simply writes nothing). Concurrent deliveries can
 * race this read-modify-write; the worst case is a slightly late trip, which
 * is acceptable for a safety breaker.
 *
 * Never throws: breaker bookkeeping must not affect delivery/job outcome.
 */
async function recordBreakerOutcome({
  payload,
  pluginConfig,
  endpoint,
  outcome,
  threshold,
  breakerOn,
}: {
  payload: Payload
  pluginConfig: OutboundWebhooksPluginConfig
  endpoint: WebhookEndpoint
  outcome: 'delivered' | 'failed'
  threshold: number
  breakerOn: boolean
}): Promise<void> {
  if (!breakerOn) return
  if (!isDocManagedEndpoint(pluginConfig, endpoint)) return

  const next = nextConsecutiveFailures(endpoint.consecutiveFailures, outcome)
  // Nothing worth persisting: a success against an already-clean counter.
  if (outcome === 'delivered' && next === 0 && !endpoint.consecutiveFailures) return

  const data: { consecutiveFailures: number; lastFailureAt?: string; autoDisabled?: boolean } = {
    consecutiveFailures: next,
  }
  if (outcome === 'failed') {
    data.lastFailureAt = new Date().toISOString()
    if (next >= threshold) data.autoDisabled = true
  }

  const slug = pluginConfig.endpointsCollectionSlug ?? 'webhookEndpoints'
  try {
    await payload.update({
      collection: slug as 'webhookEndpoints',
      where: { and: [{ id: { equals: endpoint.id } }, { url: { equals: endpoint.url } }] },
      data: data as never,
      overrideAccess: true,
    })
  } catch {
    // Never let breaker bookkeeping affect delivery/job outcome.
  }
}

type DeliveryOutcome =
  | { status: 'delivered'; responseStatus: number; retryable: false }
  | { status: 'failed'; retryable: boolean; responseStatus?: number; error?: string }

async function attemptDelivery(args: {
  endpoint: WebhookEndpoint
  deliveryId: string
  collectionSlug: string
  event: 'create' | 'update' | 'delete'
  docId: string | number
  doc: Record<string, unknown>
  previousDoc?: Record<string, unknown>
  occurredAt: string
  pluginConfig: OutboundWebhooksPluginConfig
}): Promise<DeliveryOutcome> {
  const { endpoint, deliveryId, collectionSlug, event, docId, doc, previousDoc, occurredAt, pluginConfig } = args

  const body = JSON.stringify({
    deliveryId,
    event: `${collectionSlug}.${event}`,
    collection: collectionSlug,
    docId,
    doc,
    previousDoc,
    occurredAt,
  })

  const timestamp = Math.floor(Date.now() / 1000)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Webhook-Event': `${collectionSlug}.${event}`,
    // Lets receivers dedupe redeliveries without parsing the body first.
    'X-Webhook-Id': deliveryId,
    ...endpoint.headers,
  }
  if (endpoint.secret) {
    headers['X-Webhook-Signature'] = signPayload({ body, secret: endpoint.secret, timestamp })
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), pluginConfig.timeoutMs ?? 10_000)

  try {
    const res = await fetch(endpoint.url, { method: 'POST', headers, body, signal: controller.signal })
    clearTimeout(timeout)

    if (!res.ok) {
      return { status: 'failed', retryable: isRetryableStatus(res.status), responseStatus: res.status }
    }
    return { status: 'delivered', responseStatus: res.status, retryable: false }
  } catch (err) {
    clearTimeout(timeout)
    // fetch throws for network errors, DNS failures, and our own abort-on-timeout —
    // none of these carry an HTTP status, and all are transient conditions worth retrying.
    return { status: 'failed', retryable: true, error: err instanceof Error ? err.message : String(err) }
  }
}

async function logDelivery(args: {
  payload: Payload
  pluginConfig: OutboundWebhooksPluginConfig
  endpoint: { id?: string; url: string; label?: string }
  deliveryId: string
  event: string
  docId: string | number
  status: 'delivered' | 'failed'
  responseStatus?: number
  error?: string
  retryable?: boolean
}): Promise<void> {
  const { payload, pluginConfig, endpoint, deliveryId, event, docId, status, responseStatus, error, retryable } = args
  if (pluginConfig.enableDeliveryLog === false) return

  const slug = pluginConfig.logsCollectionSlug ?? 'webhookLogs'
  try {
    await payload.create({
      collection: slug as 'webhookLogs',
      data: {
        deliveryId,
        endpointUrl: endpoint.url,
        endpointLabel: endpoint.label,
        event,
        docId: String(docId),
        status,
        retryable: status === 'failed' ? Boolean(retryable) : undefined,
        responseStatus,
        error,
        deliveredAt: new Date().toISOString(),
      },
    })
  } catch {
    // Never let logging failures affect delivery/job outcome.
  }
}
