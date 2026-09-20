import type { CollectionConfig } from 'payload'

export function buildWebhookEndpointsCollection(slug: string): CollectionConfig {
  return {
    slug,
    admin: {
      useAsTitle: 'label',
      defaultColumns: ['label', 'url', 'subscriptions', 'active'],
      description: 'Outbound webhook destinations. Editors can add or disable endpoints here without a deploy.',
      group: 'Webhooks',
    },
    access: {
      // Endpoint URLs and secrets are sensitive — restrict by default to admin-role users.
      // Override this access config from your own config by editing the returned collection.
      read: ({ req }) => Boolean(req.user),
      create: ({ req }) => Boolean(req.user),
      update: ({ req }) => Boolean(req.user),
      delete: ({ req }) => Boolean(req.user),
    },
    fields: [
      { name: 'label', type: 'text', required: true },
      { name: 'url', type: 'text', required: true, admin: { description: 'Destination URL that will receive the POST request.' } },
      {
        name: 'subscriptions',
        type: 'text',
        hasMany: true,
        required: true,
        admin: {
          description:
            "Which events trigger this endpoint, e.g. 'posts.update', 'orders.create'. Use '*' as a wildcard on either side, e.g. 'orders.*'.",
        },
      },
      {
        name: 'secret',
        type: 'text',
        admin: { description: 'Used to HMAC-sign delivered payloads. Leave blank to send unsigned.' },
      },
      {
        name: 'headers',
        type: 'json',
        admin: { description: 'Optional extra headers to send with every request, as a JSON object.' },
      },
      { name: 'active', type: 'checkbox', defaultValue: true },
    ],
  }
}
