import { env } from "./env.js"

const LOOPS_TRANSACTIONAL_API_URL = "https://app.loops.so/api/v1/transactional"

type VerificationRecord = {
  email: string
  url: string
  createdAt: string
}

const latestDevVerificationByEmail = new Map<string, VerificationRecord>()

function normalizeEmail(value: string | null | undefined) {
  return value?.trim().toLowerCase() ?? ""
}

export function canSendVerificationEmail() {
  if (env.openworkDevMode) {
    return true
  }

  return Boolean(
    env.loops.apiKey && env.loops.transactionalEmailVerificationId,
  )
}

export async function sendVerificationEmail(input: {
  user: { email: string; name?: string | null }
  url: string
}) {
  const email = normalizeEmail(input.user.email)
  if (!email) {
    return
  }

  if (env.openworkDevMode) {
    latestDevVerificationByEmail.set(email, {
      email,
      url: input.url,
      createdAt: new Date().toISOString(),
    })
    console.info(`[den] dev verification link for ${email}: ${input.url}`)
    return
  }

  const apiKey = env.loops.apiKey
  const transactionalId = env.loops.transactionalEmailVerificationId
  if (!apiKey || !transactionalId) {
    console.warn(
      `[den] email verification requested for ${email}, but delivery is not configured in this environment`,
    )
    return
  }

  const response = await fetch(LOOPS_TRANSACTIONAL_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      transactionalId,
      email,
      addToAudience: true,
      dataVariables: {
        email,
        name: input.user.name?.trim() || email,
        verificationUrl: input.url,
      },
    }),
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    throw new Error(
      `loops_verification_email_failed:${response.status}${detail ? `:${detail.slice(0, 240)}` : ""}`,
    )
  }
}

export function getLatestDevVerification(email: string) {
  return latestDevVerificationByEmail.get(normalizeEmail(email)) ?? null
}
