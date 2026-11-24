import { api, ApiError } from "./api.ts"
import { readStore, writeStore, type Profile, type Session } from "./config.ts"
import { parseMyOrgs, parseUser } from "./den.ts"
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
}

export type Context = { io: Io; flags: Flags; json: boolean; args: string[] }


export function oneArg(context: Context, name: string): string {
  const [value, ...rest] = context.args
  if (!value || rest.length) throw new CliError("usage", `Expected exactly one ${name}.`)
  return value
}

export function noArgs(context: Context): void {
  if (context.args.length) throw new CliError("usage", `Unexpected argument "${context.args[0]}".`)
}

export async function confirmDestructive(context: Context, question: string): Promise<void> {
  if (context.flags.force || context.flags.dryRun) return
  if (!context.io.interactive) throw new CliError("confirmation_required", "Aborted. Pass --force to confirm when no one is at the terminal.")
  if (!(await context.io.confirm(question))) throw new CliError("aborted", "Aborted.")
}

export function dryRun(context: Context, method: string, path: string, body?: unknown): boolean {
  if (!context.flags.dryRun) return false
  emit(context.io, context.json, { dryRun: true, request: { method, path, ...(body === undefined ? {} : { body }) } }, `Would send ${method} ${path}${body === undefined ? "" : ` ${JSON.stringify(body)}`}`)
  return true
}

export async function signInProfile(context: Context, name: string, baseUrl: string, keepOrganization: boolean): Promise<Profile> {
  const granted = await deviceLogin(context.io, baseUrl, context.json)
  const session: Session = { baseUrl, auth: { kind: "token", value: granted.accessToken }, orgId: null, source: "profile", profile: name }
  const user = parseUser(await api(context.io, session, "GET", "/v1/me"))
  const store = readStore(context.io)
  const previous = store.profiles[name]
  let orgId = keepOrganization && previous?.user.id === user.id ? previous.orgId : null
  let orgSlug = orgId ? previous?.orgSlug ?? null : null
  if (!orgId) {
    const orgs = parseMyOrgs(await api(context.io, session, "GET", "/v1/me/orgs"))
    orgId = orgs.activeOrgId
    orgSlug = orgs.activeOrgSlug
  }
  const profile: Profile = {
    baseUrl,
    accessToken: granted.accessToken,
    expiresAt: granted.expiresAt,
    user: { id: user.id, email: user.email },
    orgId,
    orgSlug,
    createdAt: new Date().toISOString(),
  }
  store.profiles[name] = profile
  if (!keepOrganization || !store.active) store.active = name
  writeStore(context.io, store)
  return profile
}

export async function withRecentSignIn<T>(context: Context, session: Session, run: (session: Session) => Promise<T>): Promise<T> {
  try {
    return await run(session)
  } catch (error) {
    if (!(error instanceof ApiError) || !error.needsRecentSignIn) throw error
    if (session.source !== "profile" || !session.profile || !context.io.interactive) {
      throw new CliError("recent_sign_in_required", session.source === "profile"
        ? "This change needs a recent sign-in. Run `openwork auth login --force`, then try again."
        : `This change needs a recent sign-in, and ${session.source} cannot sign in again. Use \`openwork auth login\`, or an API key.`)
    }
    context.io.err("This change needs a recent sign-in. Confirm it's you in the browser.")
    const profile = await signInProfile(context, session.profile, session.baseUrl, true)
    return run({ ...session, auth: { kind: "token", value: profile.accessToken } })
  }
}
