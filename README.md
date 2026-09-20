# payload-plugin-outbound-webhooks

Generic outbound webhooks for [Payload CMS](https://payloadcms.com). Fire signed HTTP callbacks whenever documents in chosen collections are created, updated, or deleted — delivered through Payload's Jobs Queue so it's non-blocking and durably retried.

## Why

Payload doesn't ship a generic "POST to a URL on document change" mechanism. This plugin adds one, aimed at wiring Payload into Zapier/Make/n8n, syncing to a CRM, or notifying any external service.

## Install

```bash
pnpm add payload-plugin-outbound-webhooks
```

```ts
// payload.config.ts
import { outboundWebhooksPlugin } from 'payload-plugin-outbound-webhooks'

export default buildConfig({
  // ...
  jobs: {
    // Required: the plugin delivers via the Jobs Queue, so it needs a runner.
    autoRun: [{ cron: '*/10 * * * * *', limit: 10, queue: 'default' }],
  },
  plugins: [
    outboundWebhooksPlugin({
      collections: {
        posts: { events: ['create', 'update'] },
        orders: {},
      },
      endpoints: [
        {
          label: 'CRM sync',
          url: 'https://example.com/hooks/payload',
          subscriptions: ['orders.*'],
          secret: process.env.WEBHOOK_SECRET,
        },
      ],
    }),
  ],
})
```

## Managing endpoints from the admin UI

By default the plugin adds a `webhookEndpoints` collection so editors can add, disable, or remove destinations without a deploy. Set `enableEndpointsCollection: false` to turn this off and rely solely on the `endpoints` array in your config.

Endpoints from both sources are merged at delivery time and matched against a `collection.event` string, e.g. `orders.create`. Use `*` as a wildcard on either side: `orders.*` matches every event on `orders`; `*.delete` matches deletes on any watched collection.

## Delivery log

A `webhookLogs` collection records every delivery attempt (status, HTTP response code, error). Set `enableDeliveryLog: false` if you don't want the extra collection.

## Filtering which changes fire a webhook

```ts
posts: {
  events: ['update'],
  filter: ({ doc, previousDoc }) =>
    doc.status === 'published' && previousDoc?.status !== 'published',
}
```

## Payload sent to your endpoint

```json
{
  "event": "orders.create",
  "collection": "orders",
  "docId": "64f...",
  "doc": { "...": "the full document" },
  "previousDoc": { "...": "present on update events" },
  "occurredAt": "2026-09-19T20:00:00.000Z"
}
```

## Verifying the signature

If an endpoint has a `secret` set, requests include an `X-Webhook-Signature` header formatted as `t=<unix timestamp>,v1=<hmac-sha256 hex digest>`, signed over `${timestamp}.${rawBody}`. Verify it on the receiving end:

```ts
import { verifyPayloadSignature } from 'payload-plugin-outbound-webhooks'

const isValid = verifyPayloadSignature({
  body: rawRequestBody, // the exact bytes received, before JSON.parse
  header: req.headers['x-webhook-signature'],
  secret: process.env.WEBHOOK_SECRET,
})
```

The helper also rejects signatures older than 5 minutes by default (`toleranceSeconds`), to blunt replay attacks.

## Options reference

| Option                      | Type                                | Default             | Description                                             |
| ---------------------------- | ------------------------------------ | -------------------- | --------------------------------------------------------- |
| `enabled`                    | `boolean`                            | `true`               | Disable without removing from the `plugins` array.         |
| `collections`                | `{ [slug]: CollectionWebhookConfig }`| —                     | Which collections/events to watch, required.               |
| `endpoints`                  | `WebhookEndpoint[]`                  | `[]`                  | Statically configured destinations.                         |
| `enableEndpointsCollection`  | `boolean`                            | `true`                | Adds the `webhookEndpoints` admin collection.               |
| `enableDeliveryLog`          | `boolean`                            | `true`                | Adds the `webhookLogs` admin collection.                    |
| `maxRetries`                 | `number`                             | `5`                   | Job retry attempts per delivery.                            |
| `timeoutMs`                  | `number`                             | `10000`               | Per-attempt request timeout.                                |

## Development

```bash
pnpm install
pnpm test       # unit tests (src/**/*.spec.ts, no database needed)
pnpm test:int   # integration tests (needs DATABASE_URI, see below)
pnpm typecheck
pnpm build      # emits dist/ (the published artifact)
```

Integration tests boot the `dev/` Payload harness (example `posts` + `orders` collections, local receiver on `:4000`) and need a Postgres database:

```bash
export DATABASE_URI=postgres://user:pass@localhost:5432/webhooks_plugin_test
pnpm test:int
```

## License

MIT
