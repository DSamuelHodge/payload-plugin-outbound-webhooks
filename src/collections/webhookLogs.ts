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
      { name: 'event', type: 'text', required: true },
      { name: 'endpointUrl', type: 'text', required: true },
      { name: 'endpointLabel', type: 'text' },
      { name: 'docId', type: 'text', required: true },
      { name: 'status', type: 'select', options: ['delivered', 'failed'], required: true },
      { name: 'responseStatus', type: 'number' },
      { name: 'error', type: 'text' },
      { name: 'deliveredAt', type: 'date', required: true },
    ],
  }
}
