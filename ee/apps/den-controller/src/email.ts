import { env } from "./env.js"

const LOOPS_TRANSACTIONAL_API_URL = "https://app.loops.so/api/v1/transactional"

async function sendLoopsTransactionalEmail(input: {
  email: string
  transactionalId: string | undefined
  dataVariables: Record<string, string>
  logLabel: string
}) {
  const apiKey = env.loops.apiKey
  const email = input.email.trim()

  if (!email) {
    return
  }

  if (env.devMode) {
    console.info(`[auth] dev ${input.logLabel} payload for ${email}: ${JSON.stringify(input.dataVariables)}`)
    return
  }

  if (!apiKey || !input.transactionalId) {
    console.warn(`[auth] ${input.logLabel} skipped for ${email}: Loops is not configured`)
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
        transactionalId: input.transactionalId,
        email,
        dataVariables: input.dataVariables,
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

    console.warn(`[auth] failed to send ${input.logLabel} for ${email}: ${detail}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.warn(`[auth] failed to send ${input.logLabel} for ${email}: ${message}`)
  }
}

export async function sendDenVerificationEmail(input: {
  email: string
  verificationCode: string
}) {
  const verificationCode = input.verificationCode.trim()

  if (!input.email.trim() || !verificationCode) {
    return
  }

  await sendLoopsTransactionalEmail({
    email: input.email,
    transactionalId: env.loops.transactionalIdDenVerifyEmail,
    dataVariables: {
      verificationCode,
    },
    logLabel: "verification email",
  })
}

export async function sendDenOrganizationInvitationEmail(input: {
  email: string
  inviteLink: string
  invitedByName: string
  invitedByEmail: string
  organizationName: string
  role: string
}) {
  await sendLoopsTransactionalEmail({
    email: input.email,
    transactionalId: env.loops.transactionalIdDenOrgInviteEmail,
    dataVariables: {
      inviteLink: input.inviteLink,
      invitedByName: input.invitedByName,
      invitedByEmail: input.invitedByEmail,
      organizationName: input.organizationName,
      role: input.role,
    },
    logLabel: "organization invite email",
  })
}
