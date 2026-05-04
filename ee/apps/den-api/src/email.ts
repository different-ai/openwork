import { env } from "./env.js"

const LOOPS_TRANSACTIONAL_API_URL = "https://app.loops.so/api/v1/transactional"

/**
 * Error thrown when a transactional email send fails or is skipped because
 * of misconfiguration. Handlers can inspect `.reason` to decide how to
 * surface the failure to the caller (e.g. map to an HTTP status).
 */
export class DenEmailSendError extends Error {
  readonly reason:
    | "loops_not_configured"
    | "loops_rejected"
    | "loops_network"
  readonly template: "verification" | "organization_invite"
  readonly recipient: string
  readonly detail?: string

  constructor(input: {
    template: DenEmailSendError["template"]
    reason: DenEmailSendError["reason"]
    recipient: string
    detail?: string
  }) {
    super(
      `[${input.template}] email for ${input.recipient} failed: ${input.reason}${
        input.detail ? ` (${input.detail})` : ""
      }`,
    )
    this.name = "DenEmailSendError"
    this.reason = input.reason
    this.template = input.template
    this.recipient = input.recipient
    this.detail = input.detail
  }
}

async function postLoopsTransactional(input: {
  transactionalId: string
  email: string
  dataVariables: Record<string, string>
  template: DenEmailSendError["template"]
}): Promise<void> {
  let response: Response
  try {
    response = await fetch(LOOPS_TRANSACTIONAL_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.loops.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        transactionalId: input.transactionalId,
        email: input.email,
        dataVariables: input.dataVariables,
      }),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    throw new DenEmailSendError({
      template: input.template,
      reason: "loops_network",
      recipient: input.email,
      detail: message,
    })
  }

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

  throw new DenEmailSendError({
    template: input.template,
    reason: "loops_rejected",
    recipient: input.email,
    detail,
  })
}

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
    throw new DenEmailSendError({
      template: "verification",
      reason: "loops_not_configured",
      recipient: email,
    })
  }

  await postLoopsTransactional({
    transactionalId: env.loops.transactionalIdDenVerifyEmail,
    email,
    dataVariables: { verificationCode },
    template: "verification",
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
    throw new DenEmailSendError({
      template: "organization_invite",
      reason: "loops_not_configured",
      recipient: email,
    })
  }

  await postLoopsTransactional({
    transactionalId: env.loops.transactionalIdDenOrgInviteEmail,
    email,
    dataVariables: {
      inviteLink: input.inviteLink,
      invitedByName: input.invitedByName,
      invitedByEmail: input.invitedByEmail,
      organizationName: input.organizationName,
      role: input.role,
    },
    template: "organization_invite",
  })
}
