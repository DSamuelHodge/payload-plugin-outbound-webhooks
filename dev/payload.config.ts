import { buildConfig } from 'payload'
import { postgresAdapter } from '@payloadcms/db-postgres' // swap for your adapter of choice
import { lexicalEditor } from '@payloadcms/richtext-lexical'

import { outboundWebhooksPlugin } from '../src/index.js'

export default buildConfig({
  editor: lexicalEditor(),
  db: postgresAdapter({
    pool: { connectionString: process.env.DATABASE_URI },
    // Dev harness only: create tables on boot so `test:int` needs no migrations.
    push: true,
  }),
  secret: process.env.PAYLOAD_SECRET || 'dev-secret',
  collections: [
    {
      slug: 'posts',
      fields: [
        { name: 'title', type: 'text', required: true },
        { name: 'status', type: 'select', options: ['draft', 'published'], defaultValue: 'draft' },
      ],
    },
    {
      slug: 'orders',
      fields: [
        { name: 'total', type: 'number', required: true },
      ],
    },
  ],
  // Required for the plugin's delivery job to actually run.
  jobs: {
    autoRun: [{ cron: '*/10 * * * * *', limit: 10, queue: 'default' }],
  },
  plugins: [
    outboundWebhooksPlugin({
      collections: {
        // Only fire when a post transitions into `published`.
        posts: {
          events: ['update'],
          filter: ({ doc, previousDoc }) => doc.status === 'published' && previousDoc?.status !== 'published',
        },
        // Fire on every create/update/delete for orders.
        orders: {},
      },
      endpoints: [
        {
          label: 'Local test receiver',
          url: 'http://localhost:4000/webhooks/payload',
          subscriptions: ['orders.*', 'posts.update'],
          secret: process.env.WEBHOOK_SECRET,
        },
      ],
      // Editors can add more endpoints at /admin/collections/webhookEndpoints without a deploy.
      enableEndpointsCollection: true,
      enableDeliveryLog: true,
      // No retries here so tests observe exactly one delivery attempt per job run.
      // Production configs should leave the default (5) for at-least-once delivery.
      maxRetries: 0,
    }),
  ],
})
