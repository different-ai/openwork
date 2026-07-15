export type JoinVerificationResult =
  | { ok: true }
  | { ok: false; error: string; message: string }

/**
 * Verification boundary for organization membership.
 *
 * Global account creation can remain available to unverified accounts, but an
 * email invitation is only trusted when the account email has been verified.
 * The deployment-wide signup setting therefore does not weaken this boundary.
 */
export function validateInvitationAcceptVerification(input: {
  emailVerified: boolean | null | undefined
  emailVerificationRequired: boolean
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
