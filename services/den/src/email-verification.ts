import { env } from "./env.js"

type VerificationRecord = {
  email: string
  url: string
  createdAt: string
}

const latestDevVerificationByEmail = new Map<string, VerificationRecord>()

function normalizeEmail(value: string | null | undefined) {
  return value?.trim().toLowerCase() ?? ""
}

export async function sendVerificationEmail(input: {
  user: { email: string }
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

  console.warn(
    `[den] email verification requested for ${email}, but delivery is not configured in this environment`,
  )
}

export function getLatestDevVerification(email: string) {
  return latestDevVerificationByEmail.get(normalizeEmail(email)) ?? null
}
