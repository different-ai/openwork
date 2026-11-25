import { api } from "../api.ts"
import { confirmDestructive, dryRun, noArgs, oneArg, openSession, splitList, withRecentSignIn, type Context } from "../context.ts"
import { parseOrgDetails, parseTeamId, type OrgDetails, type Team } from "../den.ts"
import { CliError } from "../io.ts"
import { emit, table } from "../output.ts"

function teamByIdOrName(details: OrgDetails, wanted: string): Team {
  const byId = details.teams.find((team) => team.id === wanted)
  if (byId) return byId
  const named = details.teams.filter((team) => team.name.toLowerCase() === wanted.toLowerCase())
  if (named.length === 1 && named[0]) return named[0]
  throw new CliError(named.length ? "ambiguous_team" : "unknown_team", named.length
    ? `${named.length} teams are named "${wanted}". Use the id from \`openwork teams list\`.`
    : `No team with the id or name "${wanted}". Run \`openwork teams list\`.`)
}

function memberIds(details: OrgDetails, wanted: string[]): string[] {
  const found = wanted.map((entry) => details.members.find((member) => member.id === entry || member.email.toLowerCase() === entry.toLowerCase()))
  const unknown = wanted.filter((_, index) => !found[index])
  if (unknown.length) throw new CliError("unknown_member", `Not members of this organization: ${unknown.join(", ")}. Run \`openwork members list\`.`)
  return found.flatMap((member) => (member ? [member.id] : []))
}

function emails(details: OrgDetails, team: Team): string[] {
  return team.memberIds.flatMap((id) => details.members.filter((member) => member.id === id).map((member) => member.email))
}

export async function list(context: Context): Promise<void> {
  noArgs(context)
  const session = await openSession(context)
  const details = parseOrgDetails(await api(context.io, session, "GET", "/v1/org"))
  const teams = details.teams.map((team) => ({ id: team.id, name: team.name, members: emails(details, team), managedByScim: team.managedByScim, grantsOrganizationAdmin: team.grantsOrganizationAdmin }))
  emit(context.io, context.json, { teams }, teams.length
    ? table(["ID", "NAME", "MEMBERS", "ADMIN", "MANAGED BY"], teams.map((team) => [team.id, team.name, team.members.length, team.grantsOrganizationAdmin ? "yes" : "no", team.managedByScim ? "SCIM" : null]))
    : "No teams.")
}

export async function create(context: Context): Promise<void> {
  const name = oneArg(context, "team name")
  const session = await openSession(context)
  const wanted = splitList(context.flags.members)
  const details = wanted.length ? parseOrgDetails(await api(context.io, session, "GET", "/v1/org")) : null
  const body = { name, memberIds: details ? memberIds(details, wanted) : [] }
  if (dryRun(context, "POST", "/v1/teams", body)) return
  const id = parseTeamId(await withRecentSignIn(context, session, (current) => api(context.io, current, "POST", "/v1/teams", body)))
  emit(context.io, context.json, { id, name, members: wanted }, `Created team ${name} (${id})${wanted.length ? ` with ${wanted.length} members` : ""}.`)
}

/** Rename a team or change who is in it. The API replaces the whole member list, so --add and --remove are applied to the current one. */
export async function update(context: Context): Promise<void> {
  const wanted = oneArg(context, "team id or name")
  const adding = splitList(context.flags.add)
  const removing = splitList(context.flags.remove)
  if (!context.flags.name && !adding.length && !removing.length) throw new CliError("usage", "Pass --name, --add or --remove.")
  const session = await openSession(context)
  const details = parseOrgDetails(await api(context.io, session, "GET", "/v1/org"))
  const team = teamByIdOrName(details, wanted)
  const leaving = new Set(memberIds(details, removing))
  const members = [...new Set([...team.memberIds, ...memberIds(details, adding)])].filter((id) => !leaving.has(id))
  const body = { ...(context.flags.name ? { name: context.flags.name } : {}), ...(adding.length || removing.length ? { memberIds: members } : {}) }
  const path = `/v1/teams/${encodeURIComponent(team.id)}`
  if (dryRun(context, "PATCH", path, body)) return
  await withRecentSignIn(context, session, (current) => api(context.io, current, "PATCH", path, body))
  emit(context.io, context.json, { id: team.id, name: context.flags.name ?? team.name, members: members.length }, `Updated team ${context.flags.name ?? team.name}: ${members.length} members.`)
}

export async function remove(context: Context): Promise<void> {
  const wanted = oneArg(context, "team id or name")
  const session = await openSession(context)
  const team = teamByIdOrName(parseOrgDetails(await api(context.io, session, "GET", "/v1/org")), wanted)
  const path = `/v1/teams/${encodeURIComponent(team.id)}`
  if (dryRun(context, "DELETE", path)) return
  await confirmDestructive(context, `Delete team ${team.name} and its ${team.memberIds.length} memberships?`)
  await withRecentSignIn(context, session, (current) => api(context.io, current, "DELETE", path))
  emit(context.io, context.json, { id: team.id, name: team.name, deleted: true }, `Deleted team ${team.name}.`)
}
