import { env } from "./env.js"

const LOOPS_TRANSACTIONAL_API_URL = "https://app.loops.so/api/v1/transactional"

export async function sendDenVerificationEmail(input: {
  email: string
  verificationCode: string
}) {
  const email = input.email.trim()
  const verificationCode = input.verificationCode.trim()

  if (!email || !verificationCode) {
    return
  }

  if (env.devMode) {
    console.info(`[auth] dev verification email payload for ${email}: ${JSON.stringify({ verificationCode })}`)
    return
  }

  if (!env.loops.apiKey || !env.loops.transactionalIdDenVerifyEmail) {
    console.warn(`[auth] verification email skipped for ${email}: Loops is not configured`)
    return
  }

  try {
    const response = await fetch(LOOPS_TRANSACTIONAL_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.loops.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        transactionalId: env.loops.transactionalIdDenVerifyEmail,
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

export async function sendDenOrganizationInvitationEmail(input: {
  email: string
  inviteLink: string
  invitedByName: string
  invitedByEmail: string
  organizationName: string
  role: string
}) {
  const email = input.email.trim()

  if (!email) {
    return
  }

  if (env.devMode) {
    console.info(
      `[auth] dev organization invite email payload for ${email}: ${JSON.stringify({
        inviteLink: input.inviteLink,
        invitedByName: input.invitedByName,
        invitedByEmail: input.invitedByEmail,
        organizationName: input.organizationName,
        role: input.role,
      })}`,
    )
    return
  }

  if (!env.loops.apiKey || !env.loops.transactionalIdDenOrgInviteEmail) {
    console.warn(`[auth] organization invite email skipped for ${email}: Loops is not configured`)
    return
  }

  try {
    const response = await fetch(LOOPS_TRANSACTIONAL_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.loops.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        transactionalId: env.loops.transactionalIdDenOrgInviteEmail,
        email,
        dataVariables: {
          inviteLink: input.inviteLink,
          invitedByName: input.invitedByName,
          invitedByEmail: input.invitedByEmail,
          organizationName: input.organizationName,
          role: input.role,
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

    console.warn(`[auth] failed to send organization invite email for ${email}: ${detail}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.warn(`[auth] failed to send organization invite email for ${email}: ${message}`)
  }
}
