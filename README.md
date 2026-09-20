# payload-plugin-outbound-webhooks

[![npm version](https://img.shields.io/npm/v/payload-plugin-outbound-webhooks.svg)](https://www.npmjs.com/package/payload-plugin-outbound-webhooks) [![test](https://github.com/DSamuelHodge/payload-plugin-outbound-webhooks/actions/workflows/test.yml/badge.svg)](https://github.com/DSamuelHodge/payload-plugin-outbound-webhooks/actions/workflows/test.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

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
  "deliveryId": "b6b6e1c2-...",
  "event": "orders.create",
  "collection": "orders",
  "docId": "64f...",
  "doc": { "...": "the full document" },
  "previousDoc": { "...": "present on update events" },
  "occurredAt": "2026-09-19T20:00:00.000Z"
}
```

`docId` mirrors your collection's id type (string or number). `deliveryId` is generated once per triggering event (create/update/delete) and stays the same across every retry of that delivery — use it as your idempotency/dedupe key. Every request carries `Content-Type: application/json`, an `X-Webhook-Event` header (e.g. `orders.create`), and an `X-Webhook-Id` header mirroring `deliveryId` (so you can dedupe without parsing the body), plus `X-Webhook-Signature` when the endpoint has a `secret` set.

## Delivery guarantees

Delivery is **at-least-once**, with retries classified by failure type:

- **Retryable** failures — network errors, timeouts, and HTTP `5xx`/`408`/`429` responses — fail the job so Payload's Jobs Queue retries it, up to `maxRetries` times (default `5`).
- **Permanent** failures — any other `4xx` response (bad URL, revoked auth, endpoint deleted, etc.) — are logged but *not* retried, since resending the identical request would fail the same way every time.

On a retry, only endpoints still pending are re-attempted: endpoints that already succeeded or permanently failed for that `deliveryId` are skipped (tracked via the `webhookLogs` collection, so this requires `enableDeliveryLog` to stay on). Because a retry can still redeliver to an endpoint that failed with a transient error, receivers should dedupe on `deliveryId` (or the `X-Webhook-Id` header) rather than `(event, docId)`.

## Circuit-breaker

Retries are per-delivery; the circuit-breaker protects you *across* deliveries. After `failureThreshold` consecutive failures (default `5`, set to `0` to disable), an endpoint is automatically disabled so a dead destination stops burning job retries:

- **Admin-managed endpoints** (`webhookEndpoints` collection) keep a persistent `consecutiveFailures` counter on their doc. Any success resets it; reaching the threshold sets `autoDisabled`, and delivery skips the endpoint from then on. This works even with `enableDeliveryLog: false`. To re-enable, fix the destination and uncheck `autoDisabled` in the admin UI — a `beforeChange` hook zeroes `consecutiveFailures` at the same time, so the endpoint gets a fresh run at the threshold instead of re-tripping on the next single failure.
- **Static endpoints** (the `endpoints` array) have no doc to store a counter on, so the breaker reads their recent delivery history instead: if the last `failureThreshold` attempts for that URL all failed, the endpoint is skipped for this delivery (reported as `skipped` in the job output). This requires `enableDeliveryLog` to stay on — with the log disabled there is no history to read, so static endpoints are attempted every time (same caveat as retry-skip above). Tripped static endpoints self-heal via a half-open probe: once `breakerProbeIntervalMs` (default 5 minutes) has passed since the last attempt, one delivery is let through. If it succeeds, the streak is broken and normal delivery resumes; if it fails, the endpoint stays tripped and the cooldown restarts. To force an immediate retry instead of waiting out the cooldown, delete that URL's recent `webhookLogs` rows.

Both retryable (5xx, timeouts) and permanent (4xx) failures count toward the streak — a `404` from a deleted destination trips the breaker just like a `500` storm does.

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
| `failureThreshold`           | `number`                             | `5`                   | Consecutive failures before an endpoint is auto-disabled (`0` disables). |
| `breakerProbeIntervalMs`     | `number`                             | `300000`              | Cooldown before a tripped static endpoint gets a half-open probe (`0` probes every delivery). |
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
