import { env } from "./env.js"

const LOOPS_CONTACTS_UPDATE_URL = "https://app.loops.so/api/v1/contacts/update"
const DEN_SIGNUP_SOURCE = "signup"

type DenSignupContact = {
  email: string
  name?: string | null
}

function splitName(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return {
    firstName: parts[0] ?? "",
    lastName: parts.slice(1).join(" ") || undefined,
  }
}

export async function syncDenSignupContact(contact: DenSignupContact) {
  const apiKey = env.loops.apiKey
  if (!apiKey) {
    return
  }

  const email = contact.email.trim()
  if (!email) {
    return
  }

  const name = contact.name?.trim()
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
