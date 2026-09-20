import type { CollectionBeforeChangeHook, CollectionConfig } from 'payload'

/**
 * Gives a manually re-enabled endpoint a fresh run at the threshold. Without
 * this, unchecking `autoDisabled` leaves the old `consecutiveFailures` value
 * in place (e.g. 5 against a threshold of 5), so a single failure on the very
 * next attempt re-trips the breaker and the editor gets zero grace period.
 * Only fires on the true → false transition; every other update passes through
 * untouched.
 */
export const resetBreakerCounterOnReenable: CollectionBeforeChangeHook = ({
  data,
  originalDoc,
  operation,
}) => {
  if (
    operation === 'update' &&
    (originalDoc as { autoDisabled?: boolean } | undefined)?.autoDisabled === true &&
    (data as { autoDisabled?: boolean } | undefined)?.autoDisabled === false
  ) {
    ;(data as { consecutiveFailures?: number }).consecutiveFailures = 0
  }
  return data
}

export function buildWebhookEndpointsCollection(slug: string): CollectionConfig {
  return {
    slug,
    hooks: {
      beforeChange: [resetBreakerCounterOnReenable],
    },
    admin: {
      useAsTitle: 'label',
      defaultColumns: ['label', 'url', 'subscriptions', 'active', 'autoDisabled'],
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
      {
        name: 'consecutiveFailures',
        type: 'number',
        defaultValue: 0,
        admin: {
          readOnly: true,
          description:
            'Maintained by the delivery job. Reset to 0 on every successful delivery.',
        },
      },
      {
        name: 'autoDisabled',
        type: 'checkbox',
        defaultValue: false,
        admin: {
          description:
            'Set automatically by the circuit-breaker once consecutive failures reach failureThreshold. Uncheck to re-enable the endpoint after fixing the destination (the failure counter resets to 0 automatically).',
        },
      },
      {
        name: 'lastFailureAt',
        type: 'date',
        admin: {
          readOnly: true,
          description: 'When the most recent delivery failure occurred.',
        },
      },
    ],
  }
}
