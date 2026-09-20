import type { Payload } from 'payload'
import http from 'node:http'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { verifyPayloadSignature } from '../src/index.js'

// The dev config reads these at import time, so they must be set before the
// dynamic import in beforeAll (static imports would hoist above this).
process.env.WEBHOOK_SECRET ??= 'test-secret'
process.env.PAYLOAD_SECRET ??= 'dev-secret'

const DATABASE_URI = process.env.DATABASE_URI ?? process.env.DATABASE_URL
if (!DATABASE_URI) {
  throw new Error(
    'Set DATABASE_URI (or DATABASE_URL) to a Postgres database before running integration tests.',
  )
}
process.env.DATABASE_URI = DATABASE_URI

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET as string

let payload: Payload
let receivedRequests: Array<{ body: string; headers: http.IncomingHttpHeaders }> = []
let receiver: http.Server

/** Binds an ephemeral port then releases it, yielding a (virtually) guaranteed-closed port. */
async function getClosedPort(): Promise<number> {
  const server = http.createServer()
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const { port } = server.address() as { port: number }
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  )
  return port
}

beforeAll(async () => {
  const [{ default: config }, { getPayload }] = await Promise.all([
    import('./payload.config.js'),
    import('payload'),
  ])
  payload = await getPayload({ config })

  // Minimal local HTTP receiver standing in for the real destination.
  receiver = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      receivedRequests.push({ body, headers: req.headers })
      res.writeHead(200)
      res.end('ok')
    })
  })
  await new Promise<void>((resolve) => receiver.listen(4000, resolve))
}, 120_000)

afterAll(async () => {
  await new Promise((resolve) => receiver.close(resolve))
  await payload.db.destroy()
})

beforeEach(() => {
  receivedRequests = []
})

describe('outboundWebhooksPlugin', () => {
  it('queues and delivers a signed webhook when a watched collection changes', async () => {
    const order = await payload.create({ collection: 'orders', data: { total: 42 } })

    // Run due jobs synchronously instead of waiting on the cron schedule.
    await payload.jobs.run()

    expect(receivedRequests).toHaveLength(1)
    const [request] = receivedRequests
    const parsed = JSON.parse(request.body)
    expect(parsed.event).toBe('orders.create')
    expect(parsed.docId).toBe(order.id)

    const signature = request.headers['x-webhook-signature'] as string
    expect(
      verifyPayloadSignature({ body: request.body, header: signature, secret: WEBHOOK_SECRET }),
    ).toBe(true)
  })

  it('respects a collection filter and does not fire when the condition is not met', async () => {
    await payload.create({ collection: 'posts', data: { title: 'Draft post', status: 'draft' } })
    await payload.jobs.run()
    expect(receivedRequests).toHaveLength(0)
  })

  it('logs a failed delivery when the endpoint is unreachable', async () => {
    const deadUrl = `http://localhost:${await getClosedPort()}/hook`
    const deadEndpoint = await payload.create({
      collection: 'webhookEndpoints',
      data: {
        label: 'Dead endpoint',
        url: deadUrl,
        subscriptions: ['orders.*'],
      },
      overrideAccess: true,
    })

    const order = await payload.create({ collection: 'orders', data: { total: 7 } })
    // run() resolves even when jobs fail; the failure shows up in jobStatus.
    // Dev sets maxRetries: 0, so this fails fast with no retry.
    const { jobStatus } = await payload.jobs.run()
    const statuses = Object.values(jobStatus ?? {}).map((job) =>
      typeof job === 'object' && job !== null ? (job as { status?: unknown }).status : job,
    )
    expect(statuses).toContain('error-reached-max-retries')

    // The static receiver still gets its copy; only the dead endpoint fails.
    expect(receivedRequests).toHaveLength(1)

    const { docs } = await payload.find({
      collection: 'webhookLogs',
      where: {
        and: [{ endpointUrl: { equals: deadUrl } }, { docId: { equals: String(order.id) } }],
      },
      overrideAccess: true,
    })
    expect(docs).toHaveLength(1)
    expect(docs[0].status).toBe('failed')
    expect(docs[0].error).toBeTruthy()

    // Keep reruns isolated: remove the dead endpoint (log rows stay, filtered by docId).
    await payload.delete({
      collection: 'webhookEndpoints',
      id: deadEndpoint.id,
      overrideAccess: true,
    })
  })

  it('auto-disables an endpoint after failureThreshold consecutive failures', async () => {
    const deadUrl = `http://localhost:${await getClosedPort()}/hook`
    const deadEndpoint = await payload.create({
      collection: 'webhookEndpoints',
      data: {
        label: 'Breaker test endpoint',
        url: deadUrl,
        subscriptions: ['orders.*'],
      },
      overrideAccess: true,
    })

    const readEndpoint = () =>
      payload.findByID({ collection: 'webhookEndpoints', id: deadEndpoint.id, overrideAccess: true })
    const countDeadLogs = async () => {
      const { totalDocs } = await payload.count({
        collection: 'webhookLogs',
        where: { endpointUrl: { equals: deadUrl } },
        overrideAccess: true,
      })
      return totalDocs
    }

    // First failure: streak recorded, endpoint still active.
    await payload.create({ collection: 'orders', data: { total: 1 } })
    await payload.jobs.run()
    expect((await readEndpoint()).consecutiveFailures).toBe(1)
    expect((await readEndpoint()).autoDisabled).not.toBe(true)

    // Second consecutive failure trips the breaker (dev failureThreshold: 2).
    await payload.create({ collection: 'orders', data: { total: 2 } })
    await payload.jobs.run()
    const tripped = await readEndpoint()
    expect(tripped.consecutiveFailures).toBe(2)
    expect(tripped.autoDisabled).toBe(true)
    expect(await countDeadLogs()).toBe(2)

    // Third delivery skips the tripped endpoint entirely: no new attempt logged.
    await payload.create({ collection: 'orders', data: { total: 3 } })
    await payload.jobs.run()
    expect(await countDeadLogs()).toBe(2)
    // Only the static receiver got each of the 3 orders.
    expect(receivedRequests).toHaveLength(3)

    await payload.delete({
      collection: 'webhookEndpoints',
      id: deadEndpoint.id,
      overrideAccess: true,
    })
  })

  it('gives a manually re-enabled endpoint a fresh run at the threshold', async () => {
    const deadUrl = `http://localhost:${await getClosedPort()}/hook`
    const deadEndpoint = await payload.create({
      collection: 'webhookEndpoints',
      data: {
        label: 'Re-enable test endpoint',
        url: deadUrl,
        subscriptions: ['orders.*'],
      },
      overrideAccess: true,
    })

    const readEndpoint = () =>
      payload.findByID({ collection: 'webhookEndpoints', id: deadEndpoint.id, overrideAccess: true })
    const countDeadLogs = async () => {
      const { totalDocs } = await payload.count({
        collection: 'webhookLogs',
        where: { endpointUrl: { equals: deadUrl } },
        overrideAccess: true,
      })
      return totalDocs
    }

    // Trip the breaker (dev failureThreshold: 2).
    await payload.create({ collection: 'orders', data: { total: 1 } })
    await payload.jobs.run()
    await payload.create({ collection: 'orders', data: { total: 2 } })
    await payload.jobs.run()
    expect((await readEndpoint()).autoDisabled).toBe(true)
    expect(await countDeadLogs()).toBe(2)

    // Unchecking autoDisabled resets the counter via the beforeChange hook.
    await payload.update({
      collection: 'webhookEndpoints',
      id: deadEndpoint.id,
      data: { autoDisabled: false },
      overrideAccess: true,
    })
    const reenabled = await readEndpoint()
    expect(reenabled.autoDisabled).toBe(false)
    expect(reenabled.consecutiveFailures).toBe(0)

    // Next delivery attempts the endpoint again instead of skipping it…
    await payload.create({ collection: 'orders', data: { total: 3 } })
    await payload.jobs.run()
    expect(await countDeadLogs()).toBe(3)
    // …and one failure against a zeroed counter does NOT re-trip (1 < 2).
    const afterProbe = await readEndpoint()
    expect(afterProbe.consecutiveFailures).toBe(1)
    expect(afterProbe.autoDisabled).not.toBe(true)

    await payload.delete({
      collection: 'webhookEndpoints',
      id: deadEndpoint.id,
      overrideAccess: true,
    })
  })
})
