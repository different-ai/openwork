export type JoinVerificationResult =
  | { ok: true }
  | { ok: false; error: string; message: string }

/**
 * Verification boundary for organization membership.
 *
 * Unverified accounts are intentionally allowed to sign up when a deployment
 * does not require email verification. When verification is required, joining
 * another organization remains the hard boundary; when it is not required (the
 * single-org default), the email invite itself is the join proof.
 */
export function validateInvitationAcceptVerification(input: {
  emailVerified: boolean | null | undefined
  emailVerificationRequired: boolean
}): JoinVerificationResult {
  if (!input.emailVerificationRequired || input.emailVerified === true) {
    return { ok: true }
  }

  return {
    ok: false,
    error: "email_verification_required",
    message: "Verify your email address before joining an organization.",
  }
}
