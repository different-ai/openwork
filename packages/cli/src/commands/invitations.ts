import { api, ApiError } from "../api.ts"
import type { Session } from "../config.ts"
import { confirmDestructive, dryRun, noArgs, oneArg, openSession, withRecentSignIn, type Context } from "../context.ts"
import { parseCreatedInvitation, parseInvitationLink, parseOrgDetails, type Invitation } from "../den.ts"
import { CliError } from "../io.ts"
import { emit, table } from "../output.ts"

async function findPendingInvitationByIdOrEmail(context: Context, session: Session, wanted: string): Promise<Invitation> {
  const details = parseOrgDetails(await api(context.io, session, "GET", "/v1/org"))
  const email = wanted.toLowerCase()
  const invitation = details.invitations.find((candidate) => candidate.status === "pending" && (candidate.id === wanted || candidate.email.toLowerCase() === email))
  if (!invitation) throw new CliError("unknown_invitation", `No pending invitation with the id or email "${wanted}". Run \`openwork invitations list\`.`)
  return invitation
}

export async function list(context: Context): Promise<void> {
  noArgs(context)
  const session = await openSession(context)
  const { invitations } = parseOrgDetails(await api(context.io, session, "GET", "/v1/org"))
  emit(context.io, context.json, { invitations }, invitations.length
    ? table(["ID", "EMAIL", "ROLE", "STATUS", "EXPIRES"], invitations.map((invitation) => [invitation.id, invitation.email, invitation.role, invitation.status, invitation.expiresAt.slice(0, 10)]))
    : "No invitations.")
}

function savedButEmailFailed(error: unknown, email: string): unknown {
  if (!(error instanceof ApiError) || error.status !== 502) return error
  return new CliError("invitation_email_failed", `The invitation for ${email} was saved, but the email could not be sent. Run the same command to send it again, or share the link from \`openwork invitations link ${email}\`.`, error.details)
}

export async function create(context: Context): Promise<void> {
  const email = oneArg(context, "email address")
  const body = { email, role: context.flags.role ?? "member", ...(context.flags.team ? { teamId: context.flags.team } : {}) }
  const session = await openSession(context)
  if (dryRun(context, "POST", "/v1/invitations", body)) return
  const answer = await withRecentSignIn(context, session, (current) => api(context.io, current, "POST", "/v1/invitations", body)).catch((error: unknown) => {
    throw savedButEmailFailed(error, email)
  })
  const withoutJoinToken = parseCreatedInvitation(answer)
  emit(context.io, context.json, withoutJoinToken, `Invited ${withoutJoinToken.email} as ${withoutJoinToken.role}. The invitation expires ${withoutJoinToken.expiresAt.slice(0, 10)}.`)
}

export async function cancel(context: Context): Promise<void> {
  const wanted = oneArg(context, "invitation id or email")
  const session = await openSession(context)
  const invitation = await findPendingInvitationByIdOrEmail(context, session, wanted)
  const path = `/v1/invitations/${encodeURIComponent(invitation.id)}/cancel`
  if (dryRun(context, "POST", path)) return
  await confirmDestructive(context, `Cancel the invitation for ${invitation.email}?`)
  await withRecentSignIn(context, session, (current) => api(context.io, current, "POST", path))
  emit(context.io, context.json, { invitationId: invitation.id, email: invitation.email, cancelled: true }, `Cancelled the invitation for ${invitation.email}.`)
}

export async function link(context: Context): Promise<void> {
  const wanted = oneArg(context, "invitation id or email")
  const session = await openSession(context)
  const invitation = await findPendingInvitationByIdOrEmail(context, session, wanted)
  const result = parseInvitationLink(await withRecentSignIn(context, session, (current) => api(context.io, current, "GET", `/v1/invitations/${encodeURIComponent(invitation.id)}/link`)))
  emit(context.io, context.json, { invitationId: result.invitationId, email: invitation.email, inviteLink: result.inviteLink, expiresAt: result.expiresAt }, result.inviteLink)
}
