import { env } from "./env.js"

const LOOPS_CONTACTS_UPDATE_URL = "https://app.loops.so/api/v1/contacts/update"
const LOOPS_EVENTS_SEND_URL = "https://app.loops.so/api/v1/events/send"
const DEN_SIGNUP_SOURCE = "signup"
const SUBSCRIBED_TO_DEN_EVENT = "subscribedToDen"

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
  if (!apiKey) {
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

    console.warn(`[auth] failed to sync Loops contact for ${email}: ${detail}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.warn(`[auth] failed to sync Loops contact for ${email}: ${message}`)
  }
}

export async function sendSubscribedToDenEvent(input: {
  email: string
  name?: string | null
}) {
  const apiKey = env.loops.apiKey
  if (!apiKey) {
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

      console.warn(`[billing] failed to send Loops event ${SUBSCRIBED_TO_DEN_EVENT} for ${email}: ${detail}`)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.warn(`[billing] failed to send Loops event ${SUBSCRIBED_TO_DEN_EVENT} for ${email}: ${message}`)
  }
}
