import { createHmac, timingSafeEqual } from "node:crypto"
import type { OrganizationInviteEmailProps } from "@openwork/email"
import { env } from "./env.js"

// Builds the invitation email for both products. Kept free of auth/db imports
// so unit tests can exercise it without booting Better Auth.

const CLOUD_SUPPORT_EMAIL = "team@openworklabs.com"
const CLOUD_QUICKSTART_URL = "https://openworklabs.com/docs/cloud/team-quickstart"
const SELF_HOSTED_QUICKSTART_URL = "https://openworklabs.com/docs/start-here/get-started"

type InvitationEmailSettings = {
  deployment: "cloud" | "self_hosted"
  supportAddress?: string
  webUrl: string
  now?: Date
}

export function organizationInviteEmailProps(
  input: {
    inviteLink: string
    inviterName: string | null | undefined
    inviterEmail: string | null | undefined
    inviteeEmail: string
    organizationName: string
    role: string
  },
  settings: InvitationEmailSettings = {
    deployment: env.features.deployment,
    supportAddress: env.email.supportAddress,
    webUrl: env.webUrl,
  },
): OrganizationInviteEmailProps {
  const cloud = settings.deployment === "cloud"
  const inviterEmail = input.inviterEmail?.trim() ?? ""
  const invitedByName = input.inviterName?.trim() || inviterEmail || "Your workspace admin"
  const supportEmail = settings.supportAddress?.trim() || (cloud ? CLOUD_SUPPORT_EMAIL : undefined)

  return {
    inviteLink: input.inviteLink,
    invitedByName,
    invitedByEmail: inviterEmail,
    organizationName: input.organizationName,
    role: input.role,
    inviteeEmail: input.inviteeEmail,
    gettingStartedUrl: cloud ? CLOUD_QUICKSTART_URL : SELF_HOSTED_QUICKSTART_URL,
    supportEmail,
    reportAbuseUrl: supportEmail ? reportAbuseLink(supportEmail, { inviterEmail, organizationName: input.organizationName }) : undefined,
    footerLines: cloud
      ? [`© ${(settings.now ?? new Date()).getFullYear()} Different AI. All rights reserved.`, "openworklabs.com"]
      : [`Sent by the OpenWork server at ${hostOf(settings.webUrl)} for ${input.organizationName}.`],
  }
}

function reportAbuseLink(supportEmail: string, invitation: { inviterEmail: string; organizationName: string }) {
  const subject = "Report an OpenWork invitation"
  const body = `I received an invitation I don't trust.\n\nWorkspace: ${invitation.organizationName}\nSent by: ${invitation.inviterEmail || "unknown"}`
  return `mailto:${supportEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
}

function hostOf(url: string) {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/**
 * Proof that an invitation link came from the invited mailbox.
 *
 * The inviter can read the join token (to share the link by hand), so the
 * token alone cannot show that whoever signs up owns the invited address.
 * Only the emailed link carries this value, made from the token and the
 * address with the server secret; no API returns it. Signing up with it marks
 * the email verified; without it the person verifies their email as usual.
 */
export function invitationEmailProof(input: { inviteToken: string; email: string }, secret: string = env.betterAuthSecret): string {
  return createHmac("sha256", secret)
    .update(`openwork-invitation-email-proof:${input.inviteToken}:${input.email.trim().toLowerCase()}`)
    .digest("base64url")
}

export function invitationEmailProofMatches(input: { inviteToken: string; email: string; proof: string | null | undefined }, secret: string = env.betterAuthSecret): boolean {
  if (!input.proof) return false
  const expected = new Uint8Array(Buffer.from(invitationEmailProof(input, secret)))
  const presented = new Uint8Array(Buffer.from(input.proof))
  return expected.length === presented.length && timingSafeEqual(expected, presented)
}
