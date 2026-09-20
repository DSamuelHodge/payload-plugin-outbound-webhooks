import type { CollectionAfterChangeHook, CollectionAfterDeleteHook } from 'payload'

import type { CollectionWebhookConfig, WebhookEvent } from '../types.js'
import { DELIVER_WEBHOOK_TASK_SLUG } from '../jobs/deliverWebhookTask.js'

/**
 * Builds an `afterChange` hook that queues a webhook delivery job for `create`/`update`.
 * Queueing (rather than delivering inline) keeps the document save fast and makes
 * retries durable across server restarts, since jobs are persisted.
 */
export function createAfterChangeHook(collectionSlug: string, watchConfig: CollectionWebhookConfig): CollectionAfterChangeHook {
  const watchedEvents = watchConfig.events ?? ['create', 'update', 'delete']

  return async ({ doc, previousDoc, operation, req }) => {
    const event: WebhookEvent = operation === 'create' ? 'create' : 'update'
    if (!watchedEvents.includes(event)) return doc

    if (watchConfig.filter) {
      const shouldFire = await watchConfig.filter({ doc, previousDoc, event })
      if (!shouldFire) return doc
    }

    await req.payload.jobs.queue({
      task: DELIVER_WEBHOOK_TASK_SLUG,
      input: {
        collectionSlug,
        event,
        docId: doc.id,
        doc,
        previousDoc,
        occurredAt: new Date().toISOString(),
      },
    })

    return doc
  }
}

/** Builds an `afterDelete` hook that queues a webhook delivery job for `delete`. */
export function createAfterDeleteHook(collectionSlug: string, watchConfig: CollectionWebhookConfig): CollectionAfterDeleteHook {
  const watchedEvents = watchConfig.events ?? ['create', 'update', 'delete']

  return async ({ doc, req }) => {
    if (!watchedEvents.includes('delete')) return doc

    if (watchConfig.filter) {
      const shouldFire = await watchConfig.filter({ doc, event: 'delete' })
      if (!shouldFire) return doc
    }

    await req.payload.jobs.queue({
      task: DELIVER_WEBHOOK_TASK_SLUG,
      input: {
        collectionSlug,
        event: 'delete',
        docId: doc.id,
        doc,
        occurredAt: new Date().toISOString(),
      },
    })

    return doc
  }
}
