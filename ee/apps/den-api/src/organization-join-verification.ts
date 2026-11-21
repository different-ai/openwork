export type JoinVerificationResult =
  | { ok: true }
  | { ok: false; error: string; message: string }

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
