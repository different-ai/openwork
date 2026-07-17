import { env } from "./env.js"
import { appLogger } from "./observability/logger.js"

const LOOPS_CONTACTS_UPDATE_URL = "https://app.loops.so/api/v1/contacts/update"
const LOOPS_EVENTS_SEND_URL = "https://app.loops.so/api/v1/events/send"
const DEN_SIGNUP_SOURCE = "signup"
const SUBSCRIBED_TO_DEN_EVENT = "subscribedToDen"
const logger = appLogger.child({ component: "loops" })

function splitName(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return {
    firstName: parts[0] ?? "",
    lastName: parts.slice(1).join(" ") || undefined,
  }
}

export async function syncDenSignupContact(input: {
  email: string
  name?: string | null
}) {
  const apiKey = env.loops.apiKey
  if (!env.loops.marketingEnabled || !apiKey) {
    return
  }

  const email = input.email.trim()
  if (!email) {
    return
  }

  const name = input.name?.trim()
  const { firstName, lastName } = name ? splitName(name) : { firstName: "", lastName: undefined }

  try {
    const response = await fetch(LOOPS_CONTACTS_UPDATE_URL, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email,
        firstName: firstName || undefined,
        lastName,
        source: DEN_SIGNUP_SOURCE,
      }),
    })

    if (response.ok) {
      return
    }

    let detail = `status ${response.status}`
    try {
      const payload = (await response.json()) as { message?: string }
      if (payload.message?.trim()) {
        detail = payload.message
      }
    } catch {
      // Ignore non-JSON error bodies from Loops.
    }

    logger.warn("failed to sync Loops contact", { reason: detail })
  } catch (error) {
    logger.warn("failed to sync Loops contact", { error })
  }
}

export async function sendSubscribedToDenEvent(input: {
  email: string
  name?: string | null
}) {
  const apiKey = env.loops.apiKey
  if (!env.loops.marketingEnabled || !apiKey) {
    return
  }

  const email = input.email.trim()
  if (!email) {
    return
  }

  const name = input.name?.trim()
  const { firstName, lastName } = name ? splitName(name) : { firstName: "", lastName: undefined }

  try {
    const response = await fetch(LOOPS_EVENTS_SEND_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email,
        eventName: SUBSCRIBED_TO_DEN_EVENT,
        firstName: firstName || undefined,
        lastName,
        eventProperties: {
          subscribedAt: new Date().toISOString(),
        },
      }),
    })

    if (!response.ok) {
      let detail = `status ${response.status}`
      try {
        const payload = (await response.json()) as { message?: string }
        if (payload.message?.trim()) {
          detail = payload.message
        }
      } catch {
        // Ignore non-JSON error bodies from Loops.
      }

      logger.warn("failed to send Loops event", { event: SUBSCRIBED_TO_DEN_EVENT, reason: detail })
    }
  } catch (error) {
    logger.warn("failed to send Loops event", { event: SUBSCRIBED_TO_DEN_EVENT, error })
  }
}
