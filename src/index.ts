import { definePlugin } from 'payload'
import type { Config } from 'payload'

import type { OutboundWebhooksPluginConfig } from './types.js'
import { buildWebhookEndpointsCollection } from './collections/webhookEndpoints.js'
import { buildWebhookLogsCollection } from './collections/webhookLogs.js'
import { createAfterChangeHook, createAfterDeleteHook } from './hooks/createEventHooks.js'
import { buildDeliverWebhookTask } from './jobs/deliverWebhookTask.js'

export type { OutboundWebhooksPluginConfig, WebhookEndpoint, CollectionWebhookConfig, WebhookEvent } from './types.js'
export { verifyPayloadSignature } from './utilities/signPayload.js'

/**
 * Fires outbound, signed webhooks on collection create/update/delete events.
 * Delivery runs through Payload's Jobs Queue, so it's non-blocking and durably retried.
 *
 * @example
 * ```ts
 * outboundWebhooksPlugin({
 *   collections: {
 *     posts: { events: ['create', 'update'] },
 *     orders: {},
 *   },
 *   endpoints: [
 *     { label: 'CRM sync', url: 'https://example.com/hooks/payload', subscriptions: ['orders.*'], secret: process.env.WEBHOOK_SECRET },
 *   ],
 * })
 * ```
 */
export const outboundWebhooksPlugin = definePlugin<OutboundWebhooksPluginConfig>({
  slug: 'plugin-outbound-webhooks',
  // Runs after other plugins so it sees the final set of collections/fields they may have added.
  order: 100,
  plugin: (args) => {
    const { config, enabled = true, ...pluginConfig } = args
    let newConfig: Config = { ...config }

    if (!enabled) return newConfig

    // --- optional collections ---
    const endpointsSlug = pluginConfig.endpointsCollectionSlug ?? 'webhookEndpoints'
    const logsSlug = pluginConfig.logsCollectionSlug ?? 'webhookLogs'

    const extraCollections = []
    if (pluginConfig.enableEndpointsCollection !== false) {
      extraCollections.push(buildWebhookEndpointsCollection(endpointsSlug))
    }
    if (pluginConfig.enableDeliveryLog !== false) {
      extraCollections.push(buildWebhookLogsCollection(logsSlug))
    }
    if (extraCollections.length > 0) {
      newConfig.collections = [...(newConfig.collections || []), ...extraCollections]
    }

    // --- attach hooks to every watched collection ---
    newConfig.collections = (newConfig.collections || []).map((collection) => {
      const watchConfig = pluginConfig.collections?.[collection.slug as keyof typeof pluginConfig.collections]
      if (!watchConfig) return collection

      return {
        ...collection,
        hooks: {
          ...collection.hooks,
          afterChange: [...(collection.hooks?.afterChange || []), createAfterChangeHook(collection.slug, watchConfig)],
          afterDelete: [...(collection.hooks?.afterDelete || []), createAfterDeleteHook(collection.slug, watchConfig)],
        },
      }
    })

    // --- register the delivery job task ---
    newConfig.jobs = {
      ...newConfig.jobs,
      tasks: [...(newConfig.jobs?.tasks || []), buildDeliverWebhookTask(pluginConfig)],
    }

    return newConfig
  },
})

declare module 'payload' {
  interface RegisteredPlugins {
    'plugin-outbound-webhooks': OutboundWebhooksPluginConfig
  }
}

export default outboundWebhooksPlugin
