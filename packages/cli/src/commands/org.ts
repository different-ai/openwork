import { api } from "../api.ts"
import { readStore, resolveSession, writeStore } from "../config.ts"
import { myOrganizations, noArgs, oneArg, openSession, organizationByIdOrSlug, type Context } from "../context.ts"
import { parseOrgDetails } from "../den.ts"
import { CliError } from "../io.ts"
import { emit, table } from "../output.ts"

export async function list(context: Context): Promise<void> {
  noArgs(context)
  const session = resolveSession(context.io, context.flags)
  const orgs = await myOrganizations(context, session)
  const current = session.requestedOrg ? organizationByIdOrSlug(orgs, session, session.requestedOrg).id : session.orgId ?? orgs.activeOrgId
  const rows = orgs.orgs.map((org) => ({ id: org.id, name: org.name, slug: org.slug, role: org.role, plan: org.planTier, members: org.memberCount, current: org.id === current }))
  emit(context.io, context.json, { organizations: rows }, rows.length
    ? table(["", "ID", "NAME", "SLUG", "ROLE", "PLAN", "MEMBERS"], rows.map((org) => [org.current ? "*" : " ", org.id, org.name, org.slug, org.role, org.plan, org.members]))
    : "You are not a member of any organization.")
}

export async function get(context: Context): Promise<void> {
  noArgs(context)
  const session = await openSession(context)
  const details = parseOrgDetails(await api(context.io, session, "GET", "/v1/org"))
  const result = {
    id: details.id,
    name: details.name,
    slug: details.slug,
    owner: details.ownerEmail,
    members: details.members.length,
    pendingInvitations: details.invitations.filter((invitation) => invitation.status === "pending").length,
    teams: details.teamCount,
    yourRole: details.yourRole,
    yourPermissions: details.yourPermissions,
  }
  emit(context.io, context.json, result, [
    `${result.name} (${result.slug})`,
    `ID:                  ${result.id}`,
    `Owner:               ${result.owner ?? "-"}`,
    `Members:             ${result.members}`,
    `Pending invitations: ${result.pendingInvitations}`,
    `Teams:               ${result.teams}`,
    `Your role:           ${result.yourRole}`,
  ].join("\n"))
}

export async function use(context: Context): Promise<void> {
  const wanted = oneArg(context, "organization id or slug")
  const session = resolveSession(context.io, context.flags)
  if (session.source !== "profile" || !session.profile) {
    throw new CliError("no_profile", `${session.source} has no profile to remember an organization. Pass --org or set OPENWORK_ORG_ID instead.`)
  }
  const org = organizationByIdOrSlug(await myOrganizations(context, session), session, wanted)
  const store = readStore(context.io)
  const profile = store.profiles[session.profile]
  if (!profile) throw new CliError("unknown_profile", `Profile "${session.profile}" no longer exists.`)
  store.profiles[session.profile] = { ...profile, orgId: org.id, orgSlug: org.slug }
  writeStore(context.io, store)
  emit(context.io, context.json, { profile: session.profile, organization: { id: org.id, name: org.name, slug: org.slug } }, `Profile ${session.profile} now uses ${org.name} (${org.slug}).`)
}
