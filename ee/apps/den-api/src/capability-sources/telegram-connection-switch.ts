export type TelegramWebhookRegistration = {
  botToken: string
  secret: string
  url: string
}

/**
 * Keeps webhook side effects consistent with a transactional DB switch.
 * `switchConnection` must invoke activate from inside its transaction, after
 * unique constraints have passed and before commit.
 */
export async function switchTelegramConnectionSafely<T>(input: {
  deleteWebhook: (botToken: string) => Promise<void>
  next: TelegramWebhookRegistration
  previous: TelegramWebhookRegistration | null
  registerWebhook: (registration: TelegramWebhookRegistration) => Promise<void>
  switchConnection: (activate: () => Promise<void>) => Promise<T>
}): Promise<T> {
  let activationAttempted = false
  try {
    const result = await input.switchConnection(async () => {
      activationAttempted = true
      await input.registerWebhook(input.next)
    })

    if (input.previous && input.previous.botToken !== input.next.botToken) {
      try {
        await input.deleteWebhook(input.previous.botToken)
      } catch {
        // The new connection is active. The stale webhook can only hit the
        // same endpoint with an obsolete secret and is safely rejected.
      }
    }
    return result
  } catch (error) {
    if (activationAttempted) {
      try {
        if (input.previous?.botToken === input.next.botToken) {
          await input.registerWebhook(input.previous)
        } else {
          await input.deleteWebhook(input.next.botToken)
        }
      } catch {
        // Preserve the original switch error. The DB transaction has rolled
        // back, and secret verification prevents a mismatched webhook from
        // reaching a worker.
      }
    }
    throw error
  }
}
