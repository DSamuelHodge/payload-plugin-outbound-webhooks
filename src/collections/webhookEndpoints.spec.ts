import { describe, expect, it } from 'vitest'
import { resetBreakerCounterOnReenable } from './webhookEndpoints.js'

type HookArgs = Parameters<typeof resetBreakerCounterOnReenable>[0]

function runHook(args: {
  data?: Record<string, unknown>
  originalDoc?: Record<string, unknown>
  operation?: string
}): Record<string, unknown> {
  return resetBreakerCounterOnReenable({
    data: args.data ?? {},
    originalDoc: args.originalDoc,
    operation: (args.operation ?? 'update') as HookArgs['operation'],
  } as HookArgs) as Record<string, unknown>
}

describe('resetBreakerCounterOnReenable', () => {
  it('zeroes consecutiveFailures when autoDisabled flips true -> false', () => {
    const out = runHook({
      data: { label: 'x', autoDisabled: false, consecutiveFailures: 5 },
      originalDoc: { autoDisabled: true, consecutiveFailures: 5 },
      operation: 'update',
    })
    expect(out.consecutiveFailures).toBe(0)
    expect(out.autoDisabled).toBe(false)
    expect(out.label).toBe('x')
  })

  it('leaves the counter alone when the endpoint stays disabled', () => {
    const out = runHook({
      data: { autoDisabled: true, consecutiveFailures: 5 },
      originalDoc: { autoDisabled: true, consecutiveFailures: 5 },
      operation: 'update',
    })
    expect(out.consecutiveFailures).toBe(5)
  })

  it('leaves the counter alone when the endpoint was never disabled', () => {
    const out = runHook({
      data: { autoDisabled: false, consecutiveFailures: 2 },
      originalDoc: { autoDisabled: false, consecutiveFailures: 2 },
      operation: 'update',
    })
    expect(out.consecutiveFailures).toBe(2)
  })

  it('does not touch creates, even with autoDisabled false', () => {
    const out = runHook({
      data: { autoDisabled: false, consecutiveFailures: 0 },
      originalDoc: undefined,
      operation: 'create',
    })
    expect(out.consecutiveFailures).toBe(0)
  })

  it('does nothing when there is no original doc to compare against', () => {
    const out = runHook({
      data: { autoDisabled: false, consecutiveFailures: 4 },
      originalDoc: undefined,
      operation: 'update',
    })
    expect(out.consecutiveFailures).toBe(4)
  })

  it('does nothing when the update does not touch autoDisabled', () => {
    const out = runHook({
      data: { label: 'renamed', consecutiveFailures: 3 },
      originalDoc: { autoDisabled: true, consecutiveFailures: 3 },
      operation: 'update',
    })
    expect(out.consecutiveFailures).toBe(3)
  })
})
