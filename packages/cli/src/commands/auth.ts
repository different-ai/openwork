import { api, authHeaders, rawRequest } from "../api.ts"
import { chosenProfileName, DEFAULT_API_URL, normalizeBaseUrl, readStore, resolveSession, writeStore, type Session } from "../config.ts"
import { endSession, myOrganizations, noArgs, oneArg, organizationByIdOrSlug, signInToProfile, type Context } from "../context.ts"
import { parseUser } from "../den.ts"
import { CliError } from "../io.ts"
import { emit, table } from "../output.ts"

function refuseEnvironmentCredential(context: Context): void {
  for (const name of ["OPENWORK_API_KEY", "OPENWORK_API_TOKEN"] as const) {
    if (context.io.env[name]?.trim()) throw new CliError("environment_credential", `${name} is set and takes priority over profiles. Unset it to manage profiles.`)
  }
}

export async function login(context: Context): Promise<void> {
  noArgs(context)
  refuseEnvironmentCredential(context)
  const store = readStore(context.io)
  const name = chosenProfileName(context.io, store, context.flags.profile) ?? "default"
  const existing = store.profiles[name]
  const baseUrl = normalizeBaseUrl(context.flags.baseUrl || existing?.baseUrl || context.io.env.OPENWORK_API_URL || DEFAULT_API_URL)

  if (existing && !context.flags.force && existing.baseUrl === baseUrl) {
    const session: Session = { baseUrl, auth: { kind: "token", value: existing.accessToken }, orgId: null, requestedOrg: null, source: "profile", profile: name }
    const me = await rawRequest(context.io, baseUrl, "/v1/me", { headers: authHeaders(session) })
    if (me.status === 200) {
      emit(context.io, context.json, { profile: name, user: existing.user, alreadySignedIn: true }, `Already signed in as ${existing.user.email} (profile ${name}). Pass --force to sign in again.`)
      return
    }
  }

  const profile = await signInToProfile(context, name, baseUrl)
  emit(context.io, context.json, { profile: name, user: profile.user, organization: profile.orgId ? { id: profile.orgId, slug: profile.orgSlug } : null, baseUrl },
    `Signed in as ${profile.user.email} (profile ${name})${profile.orgSlug ? `, organization ${profile.orgSlug}` : ""}.`)
}

export async function logout(context: Context): Promise<void> {
  noArgs(context)
  refuseEnvironmentCredential(context)
  const store = readStore(context.io)
  const name = chosenProfileName(context.io, store, context.flags.profile)
  const profile = name ? store.profiles[name] : undefined
  if (!name || !profile) {
    emit(context.io, context.json, { signedOut: false }, "Not signed in.")
    return
  }
  const ended = await endSession(context, profile.baseUrl, profile.accessToken)
  delete store.profiles[name]
  if (store.active === name) store.active = Object.keys(store.profiles)[0] ?? null
  writeStore(context.io, store)
  emit(context.io, context.json, { signedOut: true, profile: name, sessionEnded: ended }, `Signed out of profile ${name}.`)
}

export async function whoami(context: Context): Promise<void> {
  noArgs(context)
  const session = resolveSession(context.io, context.flags)
  const user = parseUser(await api(context.io, session, "GET", "/v1/me"))
  const orgs = await myOrganizations(context, session)
  const org = session.requestedOrg
    ? organizationByIdOrSlug(orgs, session, session.requestedOrg)
    : orgs.orgs.find((candidate) => candidate.id === (session.orgId ?? orgs.activeOrgId)) ?? null
  const result = {
    user,
    organization: org ? { id: org.id, name: org.name, slug: org.slug, role: org.role } : null,
    credential: session.source,
    profile: session.profile,
    baseUrl: session.baseUrl,
  }
  emit(context.io, context.json, result, [
    `Signed in as ${user.email}`,
    `Organization: ${org ? `${org.name} (${org.slug}), role ${org.role}` : "none"}`,
    `Credential:   ${session.profile ? `profile ${session.profile}` : session.source}`,
    `API:          ${session.baseUrl}`,
  ].join("\n"))
}

export async function list(context: Context): Promise<void> {
  noArgs(context)
  const store = readStore(context.io)
  const active = chosenProfileName(context.io, store, context.flags.profile)
  const profiles = Object.entries(store.profiles).map(([name, profile]) => ({
    name,
    active: name === active,
    email: profile.user.email,
    organization: profile.orgSlug ?? profile.orgId,
    baseUrl: profile.baseUrl,
    expiresAt: profile.expiresAt,
  }))
  emit(context.io, context.json, { profiles }, profiles.length
    ? table(["", "PROFILE", "EMAIL", "ORGANIZATION", "API"], profiles.map((profile) => [profile.active ? "*" : " ", profile.name, profile.email, profile.organization, profile.baseUrl]))
    : "No profiles. Run `openwork auth login`.")
}

export async function switchProfile(context: Context): Promise<void> {
  const name = oneArg(context, "profile name")
  const store = readStore(context.io)
  if (!store.profiles[name]) throw new CliError("unknown_profile", `There is no profile named "${name}". Run \`openwork auth list\` to see them.`)
  store.active = name
  writeStore(context.io, store)
  emit(context.io, context.json, { active: name }, `Now using profile ${name}.`)
}
