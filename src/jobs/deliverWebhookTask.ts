import type { TaskConfig } from 'payload'

import type { OutboundWebhooksPluginConfig } from '../types.js'
import { resolveEndpoints } from '../utilities/resolveEndpoints.js'
import { signPayload } from '../utilities/signPayload.js'

export const DELIVER_WEBHOOK_TASK_SLUG = 'deliverWebhook' as const

export interface DeliverWebhookInput {
  collectionSlug: string
  event: 'create' | 'update' | 'delete'
  docId: string | number
  doc: Record<string, unknown>
  previousDoc?: Record<string, unknown>
  occurredAt: string
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
      { name: 'collectionSlug', type: 'text', required: true },
      { name: 'event', type: 'text', required: true },
      { name: 'docId', type: 'text', required: true },
      { name: 'doc', type: 'json', required: true },
      { name: 'previousDoc', type: 'json' },
      { name: 'occurredAt', type: 'text', required: true },
    ],
    outputSchema: [
      { name: 'delivered', type: 'number', required: true },
      { name: 'failed', type: 'number', required: true },
    ],
    handler: async ({ input, req }) => {
      const { collectionSlug, event, docId, doc, previousDoc, occurredAt } = input as DeliverWebhookInput
      const payload = req.payload

      const endpoints = await resolveEndpoints({ payload, pluginConfig, collectionSlug, event })

      let delivered = 0
      let failed = 0

      for (const endpoint of endpoints) {
        const body = JSON.stringify({
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
            failed += 1
            await logDelivery({ payload, pluginConfig, endpoint, event: `${collectionSlug}.${event}`, docId, status: 'failed', responseStatus: res.status })
            continue
          }

          delivered += 1
          await logDelivery({ payload, pluginConfig, endpoint, event: `${collectionSlug}.${event}`, docId, status: 'delivered', responseStatus: res.status })
        } catch (err) {
          clearTimeout(timeout)
          failed += 1
          await logDelivery({
            payload,
            pluginConfig,
            endpoint,
            event: `${collectionSlug}.${event}`,
            docId,
            status: 'failed',
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }

      // At-least-once: every endpoint is attempted, then any failure surfaces as
      // a job failure so Payload's retry policy (`retries`) kicks in uniformly
      // for HTTP errors, network errors, and timeouts. Receivers must dedupe
      // on (event, docId) since retries can redeliver to healthy endpoints.
      if (failed > 0) {
        throw new Error(
          `Webhook delivery failed for ${failed} endpoint(s) on ${collectionSlug}.${event} doc ${String(docId)}`,
        )
      }

      return { output: { delivered, failed } }
    },
  }
}

async function logDelivery(args: {
  payload: import('payload').Payload
  pluginConfig: OutboundWebhooksPluginConfig
  endpoint: { id?: string; url: string; label?: string }
  event: string
  docId: string | number
  status: 'delivered' | 'failed'
  responseStatus?: number
  error?: string
}): Promise<void> {
  const { payload, pluginConfig, endpoint, event, docId, status, responseStatus, error } = args
  if (pluginConfig.enableDeliveryLog === false) return

  const slug = pluginConfig.logsCollectionSlug ?? 'webhookLogs'
  try {
    await payload.create({
      collection: slug as 'webhookLogs',
      data: {
        endpointUrl: endpoint.url,
        endpointLabel: endpoint.label,
        event,
        docId: String(docId),
        status,
        responseStatus,
        error,
        deliveredAt: new Date().toISOString(),
      },
    })
  } catch {
    // Never let logging failures affect delivery/job outcome.
  }
}
