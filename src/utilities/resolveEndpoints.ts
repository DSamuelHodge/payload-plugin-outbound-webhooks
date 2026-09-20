import type { Payload } from 'payload'

import type { OutboundWebhooksPluginConfig, WebhookEndpoint } from '../types.js'

function matchesSubscription(subscription: string, collectionSlug: string, event: string): boolean {
  const [subCollection, subEvent] = subscription.split('.')
  const collectionMatches = subCollection === '*' || subCollection === collectionSlug
  const eventMatches = subEvent === '*' || subEvent === event
  return collectionMatches && eventMatches
}

/**
 * Returns every active endpoint (static + admin-managed) subscribed to `collectionSlug.event`.
 * Called from inside the delivery job, not the request/response cycle, so a DB read here
 * doesn't add latency to the triggering document save.
 */
export async function resolveEndpoints({
  payload,
  pluginConfig,
  collectionSlug,
  event,
}: {
  payload: Payload
  pluginConfig: OutboundWebhooksPluginConfig
  collectionSlug: string
  event: string
}): Promise<WebhookEndpoint[]> {
  const staticEndpoints = (pluginConfig.endpoints ?? []).filter((e) => e.active !== false)

  let dbEndpoints: WebhookEndpoint[] = []
  if (pluginConfig.enableEndpointsCollection !== false) {
    const slug = pluginConfig.endpointsCollectionSlug ?? 'webhookEndpoints'
    // System read: delivery must not depend on admin-UI access rules, which
    // reasonably require a logged-in user the job context doesn't have.
    const result = await payload.find({
      collection: slug as 'webhookEndpoints',
      where: { active: { not_equals: false } },
      limit: 0,
      depth: 0,
      overrideAccess: true,
    })
    dbEndpoints = result.docs as unknown as WebhookEndpoint[]
  }

  return [...staticEndpoints, ...dbEndpoints].filter((endpoint) =>
    endpoint.subscriptions?.some((sub) => matchesSubscription(sub, collectionSlug, event)),
  )
}
