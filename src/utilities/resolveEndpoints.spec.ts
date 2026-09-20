import type { Payload } from 'payload'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { OutboundWebhooksPluginConfig, WebhookEndpoint } from '../types.js'
import { resolveEndpoints } from './resolveEndpoints.js'

function baseConfig(overrides: Partial<OutboundWebhooksPluginConfig> = {}): OutboundWebhooksPluginConfig {
  return { collections: { orders: {} }, endpoints: [], ...overrides }
}

function stubPayload(docs: WebhookEndpoint[] = []): Payload & { find: ReturnType<typeof vi.fn> } {
  const find = vi.fn().mockResolvedValue({ docs })
  return { find } as unknown as Payload & { find: ReturnType<typeof vi.fn> }
}

describe('resolveEndpoints', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('matches an exact collection.event subscription', async () => {
    const payload = stubPayload()
    const result = await resolveEndpoints({
      payload,
      pluginConfig: baseConfig({
        endpoints: [{ url: 'https://example.com/a', subscriptions: ['orders.create'] }],
      }),
      collectionSlug: 'orders',
      event: 'create',
    })
    expect(result).toHaveLength(1)
  })

  it('supports wildcards on either side', async () => {
    const payload = stubPayload()
    const config = baseConfig({
      endpoints: [
        { url: 'https://example.com/orders', subscriptions: ['orders.*'] },
        { url: 'https://example.com/deletes', subscriptions: ['*.delete'] },
      ],
    })

    const orderEvents = await resolveEndpoints({ payload, pluginConfig: config, collectionSlug: 'orders', event: 'create' })
    expect(orderEvents.map((e) => e.url)).toEqual(['https://example.com/orders'])

    const deleteEvents = await resolveEndpoints({ payload, pluginConfig: config, collectionSlug: 'posts', event: 'delete' })
    expect(deleteEvents.map((e) => e.url)).toEqual(['https://example.com/deletes'])
  })

  it('excludes static endpoints with active: false', async () => {
    const payload = stubPayload()
    const result = await resolveEndpoints({
      payload,
      pluginConfig: baseConfig({
        endpoints: [{ url: 'https://example.com/off', subscriptions: ['orders.*'], active: false }],
      }),
      collectionSlug: 'orders',
      event: 'create',
    })
    expect(result).toHaveLength(0)
  })

  it('merges admin-managed endpoints from the database', async () => {
    const payload = stubPayload([
      { url: 'https://example.com/db', subscriptions: ['orders.create'] },
    ])
    const result = await resolveEndpoints({
      payload,
      pluginConfig: baseConfig({
        endpoints: [{ url: 'https://example.com/static', subscriptions: ['orders.create'] }],
      }),
      collectionSlug: 'orders',
      event: 'create',
    })
    expect(result.map((e) => e.url).sort()).toEqual([
      'https://example.com/db',
      'https://example.com/static',
    ])
  })

  it('excludes admin-managed endpoints tripped by the circuit-breaker', async () => {
    const payload = stubPayload([
      { url: 'https://example.com/tripped', subscriptions: ['orders.create'], autoDisabled: true },
      { url: 'https://example.com/healthy', subscriptions: ['orders.create'], autoDisabled: false },
    ])
    const result = await resolveEndpoints({
      payload,
      pluginConfig: baseConfig(),
      collectionSlug: 'orders',
      event: 'create',
    })
    expect(result.map((e) => e.url)).toEqual(['https://example.com/healthy'])
  })

  it('keeps endpoints created before the breaker fields existed', async () => {
    const payload = stubPayload([{ url: 'https://example.com/legacy', subscriptions: ['orders.create'] }])
    const result = await resolveEndpoints({
      payload,
      pluginConfig: baseConfig(),
      collectionSlug: 'orders',
      event: 'create',
    })
    expect(result.map((e) => e.url)).toEqual(['https://example.com/legacy'])
  })

  it('skips the database lookup when the endpoints collection is disabled', async () => {
    const payload = stubPayload()
    await resolveEndpoints({
      payload,
      pluginConfig: baseConfig({ enableEndpointsCollection: false }),
      collectionSlug: 'orders',
      event: 'create',
    })
    expect(payload.find).not.toHaveBeenCalled()
  })
})
