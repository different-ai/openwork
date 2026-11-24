import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { CliError, type Io } from "./io.ts"
import { field, isRecord, optionalText } from "./json.ts"

export const DEFAULT_API_URL = "https://api.openworklabs.com"

export type Profile = {
  baseUrl: string
  accessToken: string
  expiresAt: string | null
  user: { id: string; email: string }
  orgId: string | null
  orgSlug: string | null
  createdAt: string
}

export type Store = { active: string | null; profiles: Record<string, Profile> }

export type Session = {
  baseUrl: string
  auth: { kind: "token" | "apiKey"; value: string }
  orgId: string | null
  requestedOrg: string | null
  source: "OPENWORK_API_KEY" | "OPENWORK_API_TOKEN" | "profile" | "openwork-bootstrap"
  profile: string | null
}

export function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "")
  if (!URL.canParse(trimmed) || !/^https?:$/.test(new URL(trimmed).protocol)) {
    throw new CliError("invalid_api_url", `"${value}" is not an http or https address.`)
  }
  return trimmed
}

function configDir(io: Io): string {
  return io.env.OPENWORK_CONFIG_DIR || join(io.homeDir, ".openwork")
}

export function storePath(io: Io): string {
  return join(configDir(io), "profiles.json")
}

function parseProfile(value: unknown): Profile | null {
  const baseUrl = optionalText(value, "baseUrl")
  const accessToken = optionalText(value, "accessToken")
  const user = field(value, "user")
  const id = optionalText(user, "id")
  const email = optionalText(user, "email")
  if (!baseUrl || !accessToken || !id || !email) return null
  return {
    baseUrl,
    accessToken,
    expiresAt: optionalText(value, "expiresAt"),
    user: { id, email },
    orgId: optionalText(value, "orgId"),
    orgSlug: optionalText(value, "orgSlug"),
    createdAt: optionalText(value, "createdAt") ?? "",
  }
}

export function readStore(io: Io): Store {
  const path = storePath(io)
  if (!existsSync(path)) return { active: null, profiles: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    throw new CliError("invalid_profiles_file", `${path} is not valid JSON. Fix or delete it, then run \`openwork auth login\`.`)
  }
  const saved = field(parsed, "profiles")
  const profiles: Record<string, Profile> = {}
  for (const [name, value] of Object.entries(isRecord(saved) ? saved : {})) {
    const profile = parseProfile(value)
    if (profile) profiles[name] = profile
  }
  const wanted = optionalText(parsed, "active")
  const active = wanted && profiles[wanted] ? wanted : null
  return { active, profiles }
}

/** Saved sign-ins are bearer secrets: an owner-only file whose tokens are never printed. */
export function writeStore(io: Io, store: Store): void {
  const path = storePath(io)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
  try {
    chmodSync(path, 0o600)
  } catch {}
}

function expired(expiresAt: string | null): boolean {
  return expiresAt !== null && Date.parse(expiresAt) <= Date.now()
}

function bootstrapProfile(io: Io): Profile | null {
  const path = io.env.OPENWORK_CREDENTIALS_PATH || join(configDir(io), "credentials.json")
  if (!existsSync(path)) return null
  try {
    const saved = parseProfile(JSON.parse(readFileSync(path, "utf8")))
    return saved && { ...saved, orgId: null, orgSlug: null }
  } catch {
    return null
  }
}

/** The profile a command uses: --profile, then OPENWORK_PROFILE, then the one last switched to. */
export function chosenProfileName(io: Io, store: Store, flag: string | undefined): string | null {
  return flag || io.env.OPENWORK_PROFILE || store.active
}

/**
 * The credential to act with, in order: OPENWORK_API_KEY, OPENWORK_API_TOKEN,
 * the chosen profile, then a sign-in saved by `openwork-bootstrap login`.
 */
export function resolveSession(io: Io, flags: { profile?: string; org?: string }): Session {
  const requestedOrg = flags.org || io.env.OPENWORK_ORG_ID || null
  const envUrl = normalizeBaseUrl(io.env.OPENWORK_API_URL || DEFAULT_API_URL)
  const apiKey = io.env.OPENWORK_API_KEY?.trim()
  if (apiKey) return { baseUrl: envUrl, auth: { kind: "apiKey", value: apiKey }, orgId: null, requestedOrg, source: "OPENWORK_API_KEY", profile: null }
  const token = io.env.OPENWORK_API_TOKEN?.trim()
  if (token) return { baseUrl: envUrl, auth: { kind: "token", value: token }, orgId: null, requestedOrg, source: "OPENWORK_API_TOKEN", profile: null }

  const store = readStore(io)
  const name = chosenProfileName(io, store, flags.profile)
  if (name) {
    const profile = store.profiles[name]
    if (!profile) throw new CliError("unknown_profile", `There is no profile named "${name}". Run \`openwork auth list\` to see them.`)
    if (expired(profile.expiresAt)) throw new CliError("sign_in_expired", `The sign-in for profile "${name}" has expired. Run \`openwork auth login\`.`)
    return { baseUrl: profile.baseUrl, auth: { kind: "token", value: profile.accessToken }, orgId: profile.orgId, requestedOrg, source: "profile", profile: name }
  }

  const bootstrap = bootstrapProfile(io)
  if (bootstrap && !expired(bootstrap.expiresAt)) {
    return { baseUrl: normalizeBaseUrl(bootstrap.baseUrl), auth: { kind: "token", value: bootstrap.accessToken }, orgId: null, requestedOrg, source: "openwork-bootstrap", profile: null }
  }
  throw new CliError("not_signed_in", "You are not signed in. Run `openwork auth login`, or set OPENWORK_API_KEY.")
}
