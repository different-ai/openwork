#!/usr/bin/env node
/**
 * Standalone smoke test for the invitation-email failure paths.
 *
 * Run inside the den-api container (or any environment where the package has
 * been built to `dist/`):
 *
 *   docker exec -e OPENWORK_DEV_MODE=0 \
 *     openwork-den-dev-<id>-den-1 \
 *     node ee/apps/den-api/scripts/smoke-email-failures.mjs
 *
 * Expected output:
 *   [smoke] ok loops_not_configured { reason: 'loops_not_configured', ... }
 *
 * Add `-e LOOPS_API_KEY=bogus -e LOOPS_TRANSACTIONAL_ID_DEN_ORG_INVITE_EMAIL=bogus`
 * to also reach the `loops_rejected` path (Loops returns 401).
 *
 * Intentionally side-effect free: no DB writes, no auth.
 */

const { sendDenOrganizationInvitationEmail, DenEmailSendError } = await import(
  "../dist/email.js"
)

const recipient = process.argv[2] ?? "smoke-test@example.com"

try {
  await sendDenOrganizationInvitationEmail({
    email: recipient,
    inviteLink: "https://example.com/join?invite=smoke",
    invitedByName: "Smoke Test",
    invitedByEmail: "smoke@example.com",
    organizationName: "Smoke Org",
    role: "member",
  })

  if (process.env.OPENWORK_DEV_MODE === "1" || !process.env.OPENWORK_DEV_MODE) {
    console.log("[smoke] ok dev_mode_noop (no email sent, no throw — expected)")
    process.exit(0)
  }

  console.error("[smoke] FAIL: expected throw when Loops is not configured or rejects")
  process.exit(1)
} catch (error) {
  if (!(error instanceof DenEmailSendError)) {
    console.error("[smoke] FAIL: wrong error class:", error)
    process.exit(1)
  }

  console.log(`[smoke] ok ${error.reason}`, {
    reason: error.reason,
    template: error.template,
    recipient: error.recipient,
    detail: error.detail,
  })
}
