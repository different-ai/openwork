import { api, ApiError, rawRequest } from "./api.ts"
import { readStore, resolveSession, writeStore, type Profile, type Session } from "./config.ts"
import { parseMyOrgs, parseUser, type MyOrgs, type OrgSummary, type User } from "./den.ts"
import { deviceLogin } from "./device-login.ts"
import { CliError, type Io } from "./io.ts"
import { emit } from "./output.ts"

export type Flags = {
  json: boolean
  force: boolean
  dryRun: boolean
  profile?: string
  org?: string
  role?: string
  team?: string
  baseUrl?: string
  areas?: string
  out?: string
  mode?: string
  title?: string
  request?: string
  members?: string
  name?: string
  add?: string
  remove?: string
  type?: string
  scopes?: string
  from?: string
  to?: string
  action?: string
  actor?: string
  outcome?: string
  limit?: string
  cursor?: string
  format?: string
}

export type Context = { io: Io; flags: Flags; json: boolean; args: string[] }


export function oneArg(context: Context, name: string): string {
  const [value, ...rest] = context.args
  if (!value || rest.length) throw new CliError("usage", `Expected exactly one ${name}.`)
  return value
}

export function splitList(value: string | undefined): string[] {
  return (value ?? "").split(",").map((entry) => entry.trim()).filter((entry) => entry !== "")
}

export function noArgs(context: Context): void {
  if (context.args.length) throw new CliError("usage", `Unexpected argument "${context.args[0]}".`)
}

/** Ask before a destructive change. --force skips it; with no one at the terminal the command stops instead of guessing. */
export async function confirmDestructive(context: Context, question: string): Promise<void> {
  if (context.flags.force || context.flags.dryRun) return
  if (!context.io.interactive) throw new CliError("confirmation_required", "Aborted. Pass --force to confirm when no one is at the terminal.")
  if (!(await context.io.confirm(question))) throw new CliError("aborted", "Aborted.")
}

/** With --dry-run, print the request instead of sending it. Returns true when it did. */
export function dryRun(context: Context, method: string, path: string, body?: unknown): boolean {
  if (!context.flags.dryRun) return false
  emit(context.io, context.json, { dryRun: true, request: { method, path, ...(body === undefined ? {} : { body }) } }, `Would send ${method} ${path}${body === undefined ? "" : ` ${JSON.stringify(body)}`}`)
  return true
}

/** Every organization the caller belongs to. The API lists only one when a request names it, so this asks without naming any. */
export async function myOrganizations(context: Context, session: Session): Promise<MyOrgs> {
  const withoutOrganizationFilter = { ...session, orgId: null }
  return parseMyOrgs(await api(context.io, withoutOrganizationFilter, "GET", "/v1/me/orgs"))
}

export function organizationByIdOrSlug(orgs: MyOrgs, session: Session, wanted: string): OrgSummary {
  const org = orgs.orgs.find((candidate) => candidate.id === wanted || candidate.slug === wanted)
  if (org) return org
  throw new CliError("unknown_organization", session.auth.kind === "apiKey"
    ? `This API key does not work in an organization with the id or slug "${wanted}". A key works only in the organization it was created in.`
    : `You are not a member of an organization with the id or slug "${wanted}". Run \`openwork org list\`.`)
}

/**
 * The session a command acts with. The API ignores an organization it cannot
 * read and falls back to the session's own, so --org and OPENWORK_ORG_ID are
 * looked up here, by id or slug, before any request names them.
 */
export async function openSession(context: Context): Promise<Session> {
  const session = resolveSession(context.io, context.flags)
  if (!session.requestedOrg) return session
  const org = organizationByIdOrSlug(await myOrganizations(context, session), session, session.requestedOrg)
  return { ...session, orgId: org.id }
}

type SignIn = { accessToken: string; expiresAt: string | null; user: User; session: Session }

async function signIn(context: Context, name: string, baseUrl: string): Promise<SignIn> {
  const granted = await deviceLogin(context.io, baseUrl, context.json)
  const session: Session = { baseUrl, auth: { kind: "token", value: granted.accessToken }, orgId: null, requestedOrg: null, source: "profile", profile: name }
  const user = parseUser(await api(context.io, session, "GET", "/v1/me"))
  return { ...granted, user, session }
}

function saveProfile(context: Context, name: string, profile: Profile, makeActive: boolean): void {
  const store = readStore(context.io)
  store.profiles[name] = profile
  if (makeActive || !store.active) store.active = name
  writeStore(context.io, store)
}

export async function endSession(context: Context, baseUrl: string, accessToken: string): Promise<boolean> {
  return rawRequest(context.io, baseUrl, "/api/auth/sign-out", { method: "POST", body: {}, headers: { authorization: `Bearer ${accessToken}` } })
    .then((response) => response.status === 200, () => false)
}

export async function signInToProfile(context: Context, name: string, baseUrl: string): Promise<Profile> {
  const signedIn = await signIn(context, name, baseUrl)
  const orgs = await myOrganizations(context, signedIn.session)
  const profile: Profile = {
    baseUrl,
    accessToken: signedIn.accessToken,
    expiresAt: signedIn.expiresAt,
    user: { id: signedIn.user.id, email: signedIn.user.email },
    orgId: orgs.activeOrgId,
    orgSlug: orgs.activeOrgSlug,
    createdAt: new Date().toISOString(),
  }
  saveProfile(context, name, profile, true)
  return profile
}

async function signInAgainAsSamePerson(context: Context, name: string, previous: Profile): Promise<Profile> {
  const signedIn = await signIn(context, name, previous.baseUrl)
  if (signedIn.user.id !== previous.user.id) {
    await endSession(context, previous.baseUrl, signedIn.accessToken)
    throw new CliError("different_account", `You signed in as ${signedIn.user.email}, but profile "${name}" belongs to ${previous.user.email}. Nothing was changed.`)
  }
  const profile: Profile = { ...previous, accessToken: signedIn.accessToken, expiresAt: signedIn.expiresAt, createdAt: new Date().toISOString() }
  saveProfile(context, name, profile, false)
  return profile
}

/**
 * Run a call that needs a recent sign-in. When the API asks for one, a profile
 * signs in again as the same person and the call runs once more; a key, a token
 * from the environment, or a run with no one at the terminal gets an error that
 * says what to do.
 */
export async function withRecentSignIn<T>(context: Context, session: Session, run: (session: Session) => Promise<T>): Promise<T> {
  try {
    return await run(session)
  } catch (error) {
    if (!(error instanceof ApiError) || !error.needsRecentSignIn) throw error
    const previous = session.source === "profile" && session.profile ? readStore(context.io).profiles[session.profile] : undefined
    if (!session.profile || !previous) {
      throw new CliError("recent_sign_in_required", `This needs a recent sign-in, and ${session.source} cannot sign in again. Use \`openwork auth login\`, or an API key.`)
    }
    if (!context.io.interactive) {
      throw new CliError("recent_sign_in_required", "This needs a recent sign-in. Run `openwork auth login --force`, then try again.")
    }
    context.io.err("This needs a recent sign-in. Confirm it's you in the browser.")
    const profile = await signInAgainAsSamePerson(context, session.profile, previous)
    return run({ ...session, auth: { kind: "token", value: profile.accessToken } })
  }
}
