import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Io } from "../src/io.ts"
import { main } from "../src/main.ts"

export type Call = { method: string; path: string; query: string; headers: Headers; body: unknown }
export type Reply = { status?: number; body?: unknown }
export type Route = (call: Call) => Reply | undefined

export const ORG = { id: "organization_1", name: "Acme", slug: "acme", role: "owner", planTier: "team", memberCount: 2, isActive: true }
export const BETA = { ...ORG, id: "organization_2", name: "Beta", slug: "beta", isActive: false }
export const DETAILS = {
  organization: { id: ORG.id, name: "Acme", slug: "acme", owner: { email: "owner@acme.test" } },
  currentMember: { role: "owner", permissions: ["members.update"] },
  members: [
    { id: "member_1", role: "owner", effectiveRole: "owner", isOwner: true, joinedAt: "2026-01-02T00:00:00.000Z", user: { id: "user_1", email: "owner@acme.test", name: "Owner" } },
    { id: "member_2", role: "member", effectiveRole: "member", isOwner: false, joinedAt: "2026-02-03T00:00:00.000Z", user: { id: "user_2", email: "sam@acme.test", name: "Sam" } },
  ],
  invitations: [{ id: "invitation_1", email: "new@acme.test", role: "member", status: "pending", expiresAt: "2026-12-01T00:00:00.000Z", createdAt: "2026-11-24T00:00:00.000Z" }],
  teams: [],
}

/** A stand-in for the API: device sign-in, the reads every command uses, and per-test routes first. */
export function harness(options: { interactive?: boolean; env?: Record<string, string>; routes?: Route; confirm?: boolean } = {}) {
  const calls: Call[] = []
  const out: string[] = []
  const err: string[] = []
  let signIns = 0
  const configDir = mkdtempSync(join(tmpdir(), "openwork-cli-"))
  const io: Io = {
    env: { OPENWORK_CONFIG_DIR: configDir, OPENWORK_API_URL: "https://den.test", ...options.env },
    homeDir: "/nonexistent",
    interactive: options.interactive ?? false,
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    confirm: async () => options.confirm ?? false,
    sleep: async () => {},
    fetch: async (input, init) => {
      const url = new URL(String(input))
      const call: Call = { method: init?.method ?? "GET", path: url.pathname, query: url.search, headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : undefined }
      calls.push(call)
      const reply = options.routes?.(call) ?? builtIn(call)
      return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status ?? 200 })
    },
  }
  function builtIn(call: Call): Reply {
    if (call.path === "/api/auth/device/code") return { body: { device_code: "device", user_code: "ABCDEFGH", verification_uri_complete: "https://den.test/device?user_code=ABCDEFGH", interval: 1, expires_in: 900 } }
    if (call.path === "/api/auth/device/token") return { body: { access_token: `session-${++signIns}`, expires_in: 604800 } }
    if (call.path === "/api/auth/sign-out") return { body: {} }
    if (call.path === "/v1/me") return { body: { user: { id: "user_1", email: "owner@acme.test", name: "Owner" } } }
    if (call.path === "/v1/me/orgs") {
      const named = call.headers.get("x-openwork-org-id")
      const onlyTheNamedOrganizationLikeTheApi = [ORG, BETA].filter((org) => !named || org.id === named)
      return { body: { orgs: onlyTheNamedOrganizationLikeTheApi, activeOrgId: named ?? ORG.id, activeOrgSlug: onlyTheNamedOrganizationLikeTheApi[0]?.slug ?? null } }
    }
    if (call.path === "/v1/org") return { body: DETAILS }
    return { status: 404, body: { error: "not_found" } }
  }
  const run = (...argv: string[]) => main(argv, io)
  const sent = (method: string, path: string) => calls.filter((call) => call.method === method && call.path === path)
  return { io, calls, out, err, run, sent, configDir, profilesPath: join(configDir, "profiles.json") }
}
