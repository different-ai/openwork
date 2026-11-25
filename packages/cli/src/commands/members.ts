import { api } from "../api.ts"
import type { Session } from "../config.ts"
import { confirmDestructive, dryRun, noArgs, oneArg, openSession, withRecentSignIn, type Context } from "../context.ts"
import { parseOrgDetails, type Member } from "../den.ts"
import { CliError } from "../io.ts"
import { emit, table } from "../output.ts"

async function findMemberByIdOrEmail(context: Context, session: Session, wanted: string): Promise<Member> {
  const details = parseOrgDetails(await api(context.io, session, "GET", "/v1/org"))
  const email = wanted.toLowerCase()
  const member = details.members.find((candidate) => candidate.id === wanted || candidate.email.toLowerCase() === email)
  if (!member) throw new CliError("unknown_member", `No member with the id or email "${wanted}". Run \`openwork members list\`.`)
  return member
}

export async function list(context: Context): Promise<void> {
  noArgs(context)
  const session = await openSession(context)
  const { members } = parseOrgDetails(await api(context.io, session, "GET", "/v1/org"))
  emit(context.io, context.json, { members }, table(["ID", "EMAIL", "NAME", "ROLE", "JOINED"],
    members.map((member) => [member.id, member.email, member.name, member.isOwner ? "owner" : member.role, member.joinedAt ? member.joinedAt.slice(0, 10) : "invited"])))
}

export async function setRole(context: Context): Promise<void> {
  const wanted = oneArg(context, "member id or email")
  const role = context.flags.role
  if (!role) throw new CliError("usage", "Pass the new role with --role, for example --role admin.")
  const session = await openSession(context)
  const member = await findMemberByIdOrEmail(context, session, wanted)
  const path = `/v1/members/${encodeURIComponent(member.id)}/role`
  if (dryRun(context, "POST", path, { role })) return
  await withRecentSignIn(context, session, (current) => api(context.io, current, "POST", path, { role }))
  emit(context.io, context.json, { memberId: member.id, email: member.email, role }, `${member.email} is now ${role}.`)
}

export async function remove(context: Context): Promise<void> {
  const wanted = oneArg(context, "member id or email")
  const session = await openSession(context)
  const member = await findMemberByIdOrEmail(context, session, wanted)
  const path = `/v1/members/${encodeURIComponent(member.id)}`
  if (dryRun(context, "DELETE", path)) return
  await confirmDestructive(context, `Remove ${member.email} from the organization?`)
  await withRecentSignIn(context, session, (current) => api(context.io, current, "DELETE", path))
  emit(context.io, context.json, { memberId: member.id, email: member.email, removed: true }, `Removed ${member.email}.`)
}
