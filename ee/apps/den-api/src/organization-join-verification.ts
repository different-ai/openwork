export type JoinVerificationResult =
  | { ok: true }
  | { ok: false; error: string; message: string }

/**
 * Verification boundary for organization membership.
 *
 * Unverified accounts are intentionally allowed to sign up, create their OWN
 * organization, and invite teammates so that an agent can bootstrap a workspace
 * end-to-end with no human in the loop. The one hard boundary is JOINING an
 * organization owned by someone else: that requires a verified email. This keeps
 * the open self-serve signup path agent-friendly while ensuring an unverified
 * actor can only ever affect their own sandbox org.
 */
export function validateInvitationAcceptVerification(input: {
  emailVerified: boolean | null | undefined
}): JoinVerificationResult {
  if (input.emailVerified === true) {
    return { ok: true }
  }

  return {
    ok: false,
    error: "email_verification_required",
    message: "Verify your email address before joining an organization.",
  }
}
