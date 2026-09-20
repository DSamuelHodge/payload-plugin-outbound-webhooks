import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DELIVER_WEBHOOK_TASK_SLUG } from '../jobs/deliverWebhookTask.js'
import { createAfterChangeHook, createAfterDeleteHook } from './createEventHooks.js'

function stubReq() {
  const queue = vi.fn().mockResolvedValue({})
  const req = { payload: { jobs: { queue } } }
  return { queue, req }
}

const DOC = { id: 'abc123', title: 'Test order' }

describe('createAfterChangeHook', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('queues a delivery job on create when all events are watched', async () => {
    const { queue, req } = stubReq()
    const hook = createAfterChangeHook('orders', {})
    const result = await hook({ doc: DOC, operation: 'create', req } as never)

    expect(result).toEqual(DOC)
    expect(queue).toHaveBeenCalledTimes(1)
    expect(queue).toHaveBeenCalledWith({
      task: DELIVER_WEBHOOK_TASK_SLUG,
      input: expect.objectContaining({
        collectionSlug: 'orders',
        event: 'create',
        docId: 'abc123',
        doc: DOC,
        deliveryId: expect.any(String),
      }),
    })
  })

  it('generates a fresh deliveryId per triggering event', async () => {
    const { queue, req } = stubReq()
    const hook = createAfterChangeHook('orders', {})
    await hook({ doc: DOC, operation: 'create', req } as never)
    await hook({ doc: DOC, operation: 'update', req } as never)

    const firstId = queue.mock.calls[0][0].input.deliveryId
    const secondId = queue.mock.calls[1][0].input.deliveryId
    expect(firstId).toBeTruthy()
    expect(secondId).toBeTruthy()
    expect(firstId).not.toEqual(secondId)
  })

  it('maps the update operation to the update event', async () => {
    const { queue, req } = stubReq()
    const hook = createAfterChangeHook('orders', {})
    await hook({ doc: DOC, previousDoc: DOC, operation: 'update', req } as never)

    expect(queue).toHaveBeenCalledWith({
      task: DELIVER_WEBHOOK_TASK_SLUG,
      input: expect.objectContaining({ event: 'update' }),
    })
  })

  it('skips operations not listed in events', async () => {
    const { queue, req } = stubReq()
    const hook = createAfterChangeHook('orders', { events: ['update'] })
    await hook({ doc: DOC, operation: 'create', req } as never)
    expect(queue).not.toHaveBeenCalled()
  })

  it('respects a filter that returns false', async () => {
    const { queue, req } = stubReq()
    const hook = createAfterChangeHook('orders', { filter: () => false })
    await hook({ doc: DOC, operation: 'create', req } as never)
    expect(queue).not.toHaveBeenCalled()
  })

  it('fires when the filter returns true', async () => {
    const { queue, req } = stubReq()
    const hook = createAfterChangeHook('orders', { filter: () => true })
    await hook({ doc: DOC, operation: 'create', req } as never)
    expect(queue).toHaveBeenCalledTimes(1)
  })
})

describe('createAfterDeleteHook', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('queues a delivery job for deletes', async () => {
    const { queue, req } = stubReq()
    const hook = createAfterDeleteHook('orders', {})
    await hook({ doc: DOC, req } as never)

    expect(queue).toHaveBeenCalledWith({
      task: DELIVER_WEBHOOK_TASK_SLUG,
      input: expect.objectContaining({ collectionSlug: 'orders', event: 'delete', deliveryId: expect.any(String) }),
    })
  })

  it('skips deletes when delete is not a watched event', async () => {
    const { queue, req } = stubReq()
    const hook = createAfterDeleteHook('orders', { events: ['create', 'update'] })
    await hook({ doc: DOC, req } as never)
    expect(queue).not.toHaveBeenCalled()
  })
})
