import { env } from "./env.js"

const LOOPS_TRANSACTIONAL_API_URL = "https://app.loops.so/api/v1/transactional"

export async function sendDenVerificationEmail(input: {
  email: string
  verificationCode: string
}) {
  const apiKey = env.loops.apiKey
  const transactionalId = env.loops.transactionalIdDenVerifyEmail
  const email = input.email.trim()
  const verificationCode = input.verificationCode.trim()

  if (!email || !verificationCode) {
    return
  }

  if (env.devMode) {
    console.info(`[auth] dev verification code for ${email}: ${verificationCode}`)
    return
  }

  if (!apiKey || !transactionalId) {
    console.warn(`[auth] verification email skipped for ${email}: Loops is not configured`)
    return
  }

  try {
    const response = await fetch(LOOPS_TRANSACTIONAL_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        transactionalId,
        email,
        dataVariables: {
          verificationCode,
        },
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
      // Ignore invalid upstream payloads.
    }

    console.warn(`[auth] failed to send verification email for ${email}: ${detail}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.warn(`[auth] failed to send verification email for ${email}: ${message}`)
  }
}
