import { z } from "zod"

// Permission vocabulary for OpenWork Apps.
//
// Two rules govern this file:
//
// 1. Deny by default. A capability the host can perform is only reachable by an
//    app when a permission here names it and the user approved that permission
//    for that app. There is no ambient authority and no escape hatch.
// 2. Every permission is a declaration the user can read. Parameters exist so
//    the review screen can say "Slack search and Gmail search" instead of
//    "connected sources", and so the broker can enforce exactly what was shown.
//
// External v1 apps deliberately have no vocabulary for shell access, arbitrary
// filesystem access, Node, native binaries, accessibility, screen capture, raw
// secret reads, provider credentials, arbitrary MCP execution, arbitrary IPC,
// or arbitrary server routes. Those are absent rather than gated: an app cannot
// request what cannot be spelled.

export const APP_PERMISSION_IDS = [
  "runtime.background.continuous",
  "audio.microphone",
  "ai.realtime",
  "ai.inference.transient",
  "openwork.connect.read",
  "openwork.threads.start",
  "openwork.attachments.create",
  "desktop.globalShortcut",
  "desktop.floatingSurface",
  "network.host",
  "storage.app",
] as const

export type AppPermissionId = (typeof APP_PERMISSION_IDS)[number]

/**
 * Read-only Connect operations an app may request. The broker resolves these
 * against live provider capability metadata; an operation absent from this list
 * cannot be requested, and an operation present here still fails closed when
 * the connected system does not advertise it.
 */
export const CONNECT_READ_SCOPES = [
  "slack.search",
  "slack.channel.history",
  "gmail.search",
  "gmail.message.read",
  "calendar.events.read",
] as const

export type ConnectReadScope = (typeof CONNECT_READ_SCOPES)[number]

/** Which connected provider each scope belongs to, for grouped review and enforcement. */
export const CONNECT_SCOPE_PROVIDER: Readonly<Record<ConnectReadScope, string>> = Object.freeze({
  "slack.search": "slack",
  "slack.channel.history": "slack",
  "gmail.search": "gmail",
  "gmail.message.read": "gmail",
  "calendar.events.read": "google-calendar",
})

const accelerator = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^(?:(?:CommandOrControl|Command|Control|Cmd|Ctrl|Alt|Option|Shift|Super)\+)*[A-Za-z0-9]+$/,
    "accelerator must be modifier+key, for example CommandOrControl+Shift+Space",
  )

const IPV4_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/

/** Names that resolve to the user's own machine or network, by convention or by RFC. */
const RESERVED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".in-addr.arpa"]

/**
 * Hosts an app can never be granted, whatever the manifest asks for.
 *
 * This permission is the allowlist the sandbox enforces, so an entry here is a
 * grant to reach something. Loopback reaches OpenWork's own server; a private
 * range reaches the user's LAN; `169.254.169.254` reaches cloud instance
 * metadata. IP literals are refused outright rather than range-checked — a name
 * that happens to resolve to a private address is a DNS question a manifest
 * cannot answer, and the sandbox re-checks the host on every request anyway.
 */
function isForbiddenNetworkHost(host: string): boolean {
  if (IPV4_LITERAL.test(host)) return true
  if (host === "localhost") return true
  return RESERVED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
}

// Hostnames only: no scheme, no port, no path, no wildcard. A wildcard host in
// v1 would make the review screen unreadable and the network filter unbounded.
const networkHost = z
  .string()
  .min(1)
  .max(253)
  .regex(
    /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(?:\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/,
    "host must be a lowercase fully-qualified hostname with no scheme, port, path, or wildcard",
  )
  .refine((host) => !isForbiddenNetworkHost(host), {
    message:
      "host must be a public domain name, not an IP literal, loopback, or private-network name",
  })

export const appPermissionSchema = z.discriminatedUnion("id", [
  z.object({
    id: z.literal("runtime.background.continuous"),
    /** Human reason shown verbatim on the trust screen. */
    reason: z.string().min(1).max(280),
  }).strict(),
  z.object({
    id: z.literal("audio.microphone"),
    reason: z.string().min(1).max(280),
  }).strict(),
  z.object({
    id: z.literal("ai.realtime"),
    reason: z.string().min(1).max(280),
  }).strict(),
  z.object({
    id: z.literal("ai.inference.transient"),
    reason: z.string().min(1).max(280),
  }).strict(),
  z.object({
    id: z.literal("openwork.connect.read"),
    reason: z.string().min(1).max(280),
    scopes: z.array(z.enum(CONNECT_READ_SCOPES)).min(1).max(CONNECT_READ_SCOPES.length),
  }).strict(),
  z.object({
    id: z.literal("openwork.threads.start"),
    reason: z.string().min(1).max(280),
  }).strict(),
  z.object({
    id: z.literal("openwork.attachments.create"),
    reason: z.string().min(1).max(280),
  }).strict(),
  z.object({
    id: z.literal("desktop.globalShortcut"),
    reason: z.string().min(1).max(280),
    shortcuts: z
      .array(
        z.object({
          id: z.string().min(1).max(64),
          default_accelerator: accelerator,
        }).strict(),
      )
      .min(1)
      .max(8),
  }).strict(),
  z.object({
    id: z.literal("desktop.floatingSurface"),
    reason: z.string().min(1).max(280),
    always_on_top: z.boolean(),
  }).strict(),
  z.object({
    id: z.literal("network.host"),
    reason: z.string().min(1).max(280),
    hosts: z.array(networkHost).min(1).max(16),
  }).strict(),
  z.object({
    id: z.literal("storage.app"),
    reason: z.string().min(1).max(280),
    quota_bytes: z.int().positive().max(256 * 1024 * 1024),
  }).strict(),
])

export type AppPermission = z.infer<typeof appPermissionSchema>

export type AppPermissionRisk = "critical" | "high" | "moderate" | "low"

/**
 * Risk band drives grouping and ordering on the trust screen. It is a
 * presentation aid, never an enforcement input — the broker checks the grant,
 * not the band.
 */
export const APP_PERMISSION_RISK: Readonly<Record<AppPermissionId, AppPermissionRisk>> =
  Object.freeze({
    "audio.microphone": "critical",
    "openwork.connect.read": "critical",
    "runtime.background.continuous": "high",
    "openwork.threads.start": "high",
    "network.host": "high",
    "ai.realtime": "moderate",
    "ai.inference.transient": "moderate",
    "desktop.floatingSurface": "moderate",
    "openwork.attachments.create": "moderate",
    "desktop.globalShortcut": "low",
    "storage.app": "low",
  })

export const APP_PERMISSION_RISK_ORDER: readonly AppPermissionRisk[] = Object.freeze([
  "critical",
  "high",
  "moderate",
  "low",
])

/**
 * When consent is collected. Install-time consent is recorded at trust review;
 * enable-time consent is re-confirmed when the runtime first starts; use-time
 * permissions additionally need a live user gesture for every call.
 */
export type AppConsentStage = "install" | "enable" | "use"

export const APP_PERMISSION_CONSENT: Readonly<Record<AppPermissionId, AppConsentStage>> =
  Object.freeze({
    "runtime.background.continuous": "enable",
    "audio.microphone": "enable",
    "ai.realtime": "enable",
    "ai.inference.transient": "install",
    "openwork.connect.read": "enable",
    "openwork.threads.start": "use",
    "openwork.attachments.create": "use",
    "desktop.globalShortcut": "enable",
    "desktop.floatingSurface": "enable",
    "network.host": "install",
    "storage.app": "install",
  })

/** Permissions whose every use must be backed by a fresh host-issued gesture token. */
export function requiresUserGesture(id: AppPermissionId): boolean {
  return APP_PERMISSION_CONSENT[id] === "use"
}

/** Short label used in review UI, audit records, and CLI diagnostics. */
export const APP_PERMISSION_LABEL: Readonly<Record<AppPermissionId, string>> = Object.freeze({
  "runtime.background.continuous": "Run continuously in the background",
  "audio.microphone": "Use the microphone",
  "ai.realtime": "Open a realtime AI session",
  "ai.inference.transient": "Run transient AI inference",
  "openwork.connect.read": "Read from connected sources",
  "openwork.threads.start": "Start an OpenWork thread",
  "openwork.attachments.create": "Attach a file to a thread",
  "desktop.globalShortcut": "Register a global keyboard shortcut",
  "desktop.floatingSurface": "Show a floating window",
  "network.host": "Reach specific network hosts",
  "storage.app": "Store its own data",
})

/**
 * The parameters that make a permission's authority specific — everything the
 * trust screen shows as detail beneath the label.
 *
 * This is the single source of a permission's identity. `permissionKey` and
 * `widenedBeyond` both derive from it, so what the user is shown and what the
 * host enforces cannot drift apart. There is deliberately no `default` case:
 * adding a parameterised permission without deciding its facets is a compile
 * error, not a silently unbound parameter the review screen displays and the
 * comparison ignores.
 */
export function permissionFacets(permission: AppPermission): string[] {
  switch (permission.id) {
    case "openwork.connect.read":
      return [...permission.scopes].sort()
    case "network.host":
      return [...permission.hosts].sort()
    case "desktop.globalShortcut":
      // The accelerator is part of the identity. A shortcut rebound to a
      // different key combination is different authority, however the id reads.
      return permission.shortcuts.map((s) => `${s.id}=${s.default_accelerator}`).sort()
    case "desktop.floatingSurface":
      return [`always_on_top=${permission.always_on_top}`]
    case "storage.app":
      return [String(permission.quota_bytes)]
    case "runtime.background.continuous":
    case "audio.microphone":
    case "ai.realtime":
    case "ai.inference.transient":
    case "openwork.threads.start":
    case "openwork.attachments.create":
      return []
  }
}

export function permissionKey(permission: AppPermission): string {
  const facets = permissionFacets(permission)
  return facets.length === 0 ? permission.id : `${permission.id}:${facets.join(",")}`
}

export type PermissionDeltaEntry =
  | { change: "added"; permission: AppPermission }
  | { change: "widened"; permission: AppPermission; previous: AppPermission }
  | { change: "removed"; permission: AppPermission }
  | { change: "narrowed"; permission: AppPermission; previous: AppPermission }

export type PermissionDelta = {
  entries: PermissionDeltaEntry[]
  /** True when the update asks for anything the user has not already approved. */
  requiresReview: boolean
}

/**
 * Whether `next` claims authority `previous` did not have.
 *
 * Set-valued permissions widen by gaining a facet, so they are compared through
 * `permissionFacets` — which is what makes a rebound global shortcut count as
 * widening rather than as no change at all. Scalar-valued permissions widen in
 * one direction only, so they are compared explicitly. As with the facets, there
 * is no `default`: a new permission has to say which kind it is.
 */
function widenedBeyond(previous: AppPermission, next: AppPermission): boolean {
  if (previous.id !== next.id) return true
  switch (next.id) {
    case "openwork.connect.read":
    case "network.host":
    case "desktop.globalShortcut": {
      const before = new Set(permissionFacets(previous))
      return permissionFacets(next).some((facet) => !before.has(facet))
    }
    case "desktop.floatingSurface": {
      const before = previous as Extract<AppPermission, { id: "desktop.floatingSurface" }>
      return next.always_on_top && !before.always_on_top
    }
    case "storage.app": {
      const before = previous as Extract<AppPermission, { id: "storage.app" }>
      return next.quota_bytes > before.quota_bytes
    }
    case "runtime.background.continuous":
    case "audio.microphone":
    case "ai.realtime":
    case "ai.inference.transient":
    case "openwork.threads.start":
    case "openwork.attachments.create":
      return false
  }
}

/**
 * Compare an approved permission set against the set an update requests.
 *
 * `requiresReview` is the gate the update installer honours: an update that
 * adds a permission, or widens the parameters of one already granted, stays
 * blocked until the user reviews it. Removals and narrowings never block.
 */
export function diffPermissions(
  granted: readonly AppPermission[],
  requested: readonly AppPermission[],
): PermissionDelta {
  const grantedById = new Map(granted.map((permission) => [permission.id, permission] as const))
  const requestedById = new Map(requested.map((permission) => [permission.id, permission] as const))
  const entries: PermissionDeltaEntry[] = []

  for (const permission of requested) {
    const previous = grantedById.get(permission.id)
    if (!previous) {
      entries.push({ change: "added", permission })
      continue
    }
    if (permissionKey(previous) === permissionKey(permission)) continue
    entries.push(
      widenedBeyond(previous, permission)
        ? { change: "widened", permission, previous }
        : { change: "narrowed", permission, previous },
    )
  }

  for (const permission of granted) {
    if (!requestedById.has(permission.id)) entries.push({ change: "removed", permission })
  }

  return {
    entries,
    requiresReview: entries.some((entry) => entry.change === "added" || entry.change === "widened"),
  }
}
