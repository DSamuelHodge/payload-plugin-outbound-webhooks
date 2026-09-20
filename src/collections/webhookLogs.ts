import type { CollectionConfig } from 'payload'

export function buildWebhookLogsCollection(slug: string): CollectionConfig {
  return {
    slug,
    admin: {
      useAsTitle: 'event',
      defaultColumns: ['event', 'endpointUrl', 'status', 'responseStatus', 'deliveredAt'],
      description: 'Read-only delivery history for outbound webhooks.',
      group: 'Webhooks',
    },
    access: {
      read: ({ req }) => Boolean(req.user),
      create: () => true, // written only by the delivery job
      update: () => false,
      delete: ({ req }) => Boolean(req.user),
    },
    fields: [
      {
        name: 'deliveryId',
        type: 'text',
        required: true,
        index: true,
        admin: {
          description:
            'Stable id shared by every attempt of the same triggering event (create/update/delete), used to dedupe on the receiving end and to skip endpoints already resolved when a job is retried.',
        },
      },
      { name: 'event', type: 'text', required: true },
      {
        name: 'endpointUrl',
        type: 'text',
        required: true,
        index: true,
        admin: {
          description:
            'Indexed: the circuit-breaker reads recent attempts per URL to protect static endpoints without a managed endpoint doc.',
        },
      },
      { name: 'endpointLabel', type: 'text' },
      { name: 'docId', type: 'text', required: true },
      { name: 'status', type: 'select', options: ['delivered', 'failed'], required: true },
      {
        name: 'retryable',
        type: 'checkbox',
        admin: {
          description:
            'Only set on failed attempts. False means the failure was permanent (e.g. 4xx) and the job will not retry this endpoint again for this delivery.',
        },
      },
      { name: 'responseStatus', type: 'number' },
      { name: 'error', type: 'text' },
      { name: 'deliveredAt', type: 'date', required: true },
    ],
  }
}
