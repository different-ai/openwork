import { z } from "zod"

/**
 * Remote devices (feature `remoteDevices`): Den's registry of the computers a
 * member can reach through OpenWork. One row per computer and organization:
 *
 * - `desktop`: a computer running OpenWork Desktop signed in to the
 *   organization (a MacBook, a PC). It registers itself and reports how its
 *   computer use is doing.
 * - `vm`: a virtual computer. Workbot's own cloud computer for a chat, a
 *   Freestyle or Daytona VM someone registered, or a Mac sandbox on a shared
 *   Mac host.
 *
 * The registry names computers and records their state and recent activity; it
 * never holds provider credentials and grants no access by itself. Workbot's
 * computers stay governed by the runner, a desktop's by its own sign-in.
 */
export const REMOTE_DEVICE_KINDS = ["desktop", "vm"] as const
export type RemoteDeviceKind = (typeof REMOTE_DEVICE_KINDS)[number]

/** Who runs the computer. `workbot` is Workbot's own cloud computer, whatever provider the runner uses. */
export const REMOTE_DEVICE_PROVIDERS = ["openwork_desktop", "workbot", "freestyle", "daytona", "mac_host", "other"] as const
export type RemoteDeviceProvider = (typeof REMOTE_DEVICE_PROVIDERS)[number]

/** Providers a member can register a VM for by hand. */
export const REMOTE_DEVICE_REGISTERABLE_PROVIDERS = ["freestyle", "daytona", "mac_host", "other"] as const
export type RemoteDeviceRegisterableProvider = (typeof REMOTE_DEVICE_REGISTERABLE_PROVIDERS)[number]

/** How the row came to exist. */
export const REMOTE_DEVICE_SOURCES = ["desktop_app", "workbot", "manual"] as const
export type RemoteDeviceSource = (typeof REMOTE_DEVICE_SOURCES)[number]

export const REMOTE_DEVICE_PLATFORMS = ["darwin", "win32", "linux"] as const
export type RemoteDevicePlatform = (typeof REMOTE_DEVICE_PLATFORMS)[number]

/** The last state the computer, or whoever drives it, reported. */
export const REMOTE_DEVICE_STATES = ["ready", "paused", "setup_required", "unavailable", "unknown"] as const
export type RemoteDeviceState = (typeof REMOTE_DEVICE_STATES)[number]

/** Last reported availability: stale virtual-computer reports are unknown, not assumed pauses. */
export const REMOTE_DEVICE_AVAILABILITIES = ["online", "paused", "needs_setup", "offline", "unknown"] as const
export type RemoteDeviceAvailability = (typeof REMOTE_DEVICE_AVAILABILITIES)[number]

/** A desktop, or a Workbot computer in use, counts as online this long after it was last heard from. */
export const REMOTE_DEVICE_ONLINE_WINDOW_MS = 10 * 60_000
/** A desktop that has not been heard from for this long leaves the list. */
export const REMOTE_DEVICE_DESKTOP_RETENTION_MS = 30 * 24 * 60 * 60_000
/** How often a signed-in desktop reports when nothing changed. */
export const REMOTE_DEVICE_REPORT_INTERVAL_SECONDS = 5 * 60
/** Events kept per device. */
export const REMOTE_DEVICE_EVENT_LIMIT = 200
export const REMOTE_DEVICE_EVENT_RETENTION_MS = 30 * 24 * 60 * 60_000

export const remoteDeviceAvailability = (input: {
  kind: RemoteDeviceKind
  provider: RemoteDeviceProvider
  state: RemoteDeviceState
  lastSeenAt: number | null
  now: number
}): RemoteDeviceAvailability => {
  const recent = input.lastSeenAt !== null && input.now - input.lastSeenAt <= REMOTE_DEVICE_ONLINE_WINDOW_MS
  if (input.kind === "desktop") {
    if (!recent) return "offline"
    return input.state === "setup_required" ? "needs_setup" : "online"
  }
  if (input.state === "paused") return "paused"
  if (input.state === "setup_required") return "needs_setup"
  if (input.state === "unavailable") return "offline"
  if (input.state === "unknown") return "unknown"
  // Stale reports are not proof that the runner successfully paused the computer.
  if (input.provider === "workbot") return recent ? "online" : "unknown"
  return recent ? "online" : "unknown"
}

const timestampSchema = z.string().datetime({ offset: true })
const labelSchema = z.string().trim().min(1).max(80)
const detailSchema = z.string().trim().max(300)

export const remoteDeviceSchema = z.object({
  id: z.string(),
  kind: z.enum(REMOTE_DEVICE_KINDS),
  provider: z.enum(REMOTE_DEVICE_PROVIDERS),
  source: z.enum(REMOTE_DEVICE_SOURCES),
  platform: z.enum(REMOTE_DEVICE_PLATFORMS).nullable(),
  label: z.string(),
  /** `mine`: the caller's own computer. `shared`: registered for everyone in the organization. */
  access: z.enum(["mine", "shared"]),
  availability: z.enum(REMOTE_DEVICE_AVAILABILITIES),
  state: z.enum(REMOTE_DEVICE_STATES),
  /** One plain sentence from the last report when something needs attention, e.g. "Screen Recording is off". */
  statusDetail: z.string().nullable(),
  lastSeenAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
  appVersion: z.string().nullable(),
  /** The id `remote-session:targets` names this desktop by; null for other kinds and desktops that take no tasks. */
  computerId: z.string().nullable(),
  /** For Workbot's computers: the chat it belongs to (`main` or a side chat id). */
  workbotChat: z.string().nullable(),
  canRename: z.boolean(),
  canRemove: z.boolean(),
}).meta({ ref: "RemoteDevice" })
export type RemoteDevice = z.infer<typeof remoteDeviceSchema>

export const REMOTE_DEVICE_EVENT_LEVELS = ["info", "warning", "error"] as const
export type RemoteDeviceEventLevel = (typeof REMOTE_DEVICE_EVENT_LEVELS)[number]
export const REMOTE_DEVICE_EVENT_ACTORS = ["member", "device", "workbot", "system"] as const
export type RemoteDeviceEventActor = (typeof REMOTE_DEVICE_EVENT_ACTORS)[number]

/** Stable event names; the message is the human sentence. */
export const REMOTE_DEVICE_EVENT_TYPES = [
  "registered", "renamed", "removed", "restored",
  "state_changed", "app_updated", "computer_changed",
  "viewer_opened", "paused", "resumed", "rebuilt", "continued", "failed",
] as const
export type RemoteDeviceEventType = (typeof REMOTE_DEVICE_EVENT_TYPES)[number]

export const remoteDeviceEventSchema = z.object({
  id: z.string(),
  type: z.enum(REMOTE_DEVICE_EVENT_TYPES),
  level: z.enum(REMOTE_DEVICE_EVENT_LEVELS),
  message: z.string(),
  actor: z.enum(REMOTE_DEVICE_EVENT_ACTORS),
  createdAt: timestampSchema,
}).meta({ ref: "RemoteDeviceEvent" })
export type RemoteDeviceEvent = z.infer<typeof remoteDeviceEventSchema>

export const remoteDeviceListResponseSchema = z.object({
  devices: z.array(remoteDeviceSchema),
}).meta({ ref: "RemoteDeviceList" })
export type RemoteDeviceListResponse = z.infer<typeof remoteDeviceListResponseSchema>

export const remoteDeviceDetailResponseSchema = z.object({
  device: remoteDeviceSchema,
  /** Newest first, at most 20. */
  events: z.array(remoteDeviceEventSchema),
}).meta({ ref: "RemoteDeviceDetail" })
export type RemoteDeviceDetailResponse = z.infer<typeof remoteDeviceDetailResponseSchema>

export const remoteDeviceResponseSchema = z.object({ device: remoteDeviceSchema }).meta({ ref: "RemoteDeviceResponse" })
export type RemoteDeviceResponse = z.infer<typeof remoteDeviceResponseSchema>

/** Register a virtual computer by hand. `externalId` is the provider's own id for it (a VM id, a sandbox name). */
export const remoteDeviceRegisterRequestSchema = z.object({
  label: labelSchema,
  provider: z.enum(REMOTE_DEVICE_REGISTERABLE_PROVIDERS),
  platform: z.enum(REMOTE_DEVICE_PLATFORMS),
  externalId: z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:\-]*$/, "Use the id the provider shows: letters, numbers, dots, dashes, underscores or colons."),
  /** Everyone in the organization sees it. Needs the Manage desktop policies permission. */
  shared: z.boolean().default(false),
}).strict().meta({ ref: "RegisterRemoteDeviceRequest" })
export type RemoteDeviceRegisterRequest = z.infer<typeof remoteDeviceRegisterRequestSchema>

export const remoteDeviceUpdateRequestSchema = z.object({ label: labelSchema }).strict().meta({ ref: "UpdateRemoteDeviceRequest" })
export type RemoteDeviceUpdateRequest = z.infer<typeof remoteDeviceUpdateRequestSchema>

/** Readiness as the desktop's computer use reports it (`ComputerStatus.readiness`). */
export const REMOTE_DEVICE_COMPUTER_READINESS = ["ready", "setup-required", "unsupported", "unavailable"] as const
export type RemoteDeviceComputerReadiness = (typeof REMOTE_DEVICE_COMPUTER_READINESS)[number]

const reportedComputerSchema = z.object({
  /** The desktop's adapter id, e.g. `this-mac`, `freestyle-vm`. */
  id: z.string().trim().min(1).max(64),
  label: labelSchema,
  placement: z.enum(["local", "remote"]),
  readiness: z.enum(REMOTE_DEVICE_COMPUTER_READINESS).nullable(),
  detail: detailSchema.nullable(),
  /** For a VM the desktop is configured to reach: who runs it and the provider's id for it. */
  provider: z.enum(["freestyle", "daytona"]).nullable().default(null),
  externalId: z.string().trim().min(1).max(160).nullable().default(null),
}).strict()
export type RemoteDeviceReportedComputer = z.infer<typeof reportedComputerSchema>

/**
 * What a signed-in desktop says about itself, on launch, when something
 * changes and every few minutes. No file paths, window titles or screen
 * content: names, versions and readiness only.
 */
export const remoteDeviceDesktopReportSchema = z.object({
  /** This install's stable id: the id it registers its runner with. */
  installId: z.string().trim().min(8).max(160),
  label: labelSchema,
  platform: z.enum(REMOTE_DEVICE_PLATFORMS),
  appVersion: z.string().trim().min(1).max(80),
  osVersion: z.string().trim().max(80).nullable().default(null),
  arch: z.string().trim().max(32).nullable().default(null),
  computerUse: z.object({
    enabled: z.boolean(),
    remoteEnabled: z.boolean(),
    /** The adapter every chat uses. */
    selectedId: z.string().trim().max(64).nullable(),
    computers: z.array(reportedComputerSchema).max(12),
    permissions: z.object({ accessibility: z.boolean(), screenRecording: z.boolean() }).strict().nullable().default(null),
  }).strict().nullable().default(null),
}).strict().meta({ ref: "RemoteDeviceDesktopReport" })
export type RemoteDeviceDesktopReport = z.infer<typeof remoteDeviceDesktopReportSchema>

export const remoteDeviceDesktopReportResponseSchema = z.object({
  device: remoteDeviceSchema,
  /** When to report again if nothing changes. */
  reportAfterSeconds: z.number().int().positive(),
}).meta({ ref: "RemoteDeviceDesktopReportResponse" })
export type RemoteDeviceDesktopReportResponse = z.infer<typeof remoteDeviceDesktopReportResponseSchema>

/** What Workbot's server tells Den about a chat's cloud computer. */
export const REMOTE_DEVICE_WORKBOT_EVENTS = ["viewer_opened", "paused", "resumed", "rebuilt", "continued", "failed", "removed"] as const
export type RemoteDeviceWorkbotEvent = (typeof REMOTE_DEVICE_WORKBOT_EVENTS)[number]

export const remoteDeviceWorkbotReportSchema = z.object({
  /** The runner conversation the computer belongs to. */
  sessionId: z.string().regex(/^hs_[A-Za-z0-9_-]{8,96}$/),
  /** `main`, or the side chat's id. */
  chat: z.string().trim().min(1).max(96),
  event: z.enum(REMOTE_DEVICE_WORKBOT_EVENTS),
  /** A fixed code for a failure, e.g. `desktop_unavailable`; never error text from the computer. */
  code: z.string().trim().regex(/^[a-z][a-z0-9_]{0,63}$/).nullable().default(null),
  /** For `viewer_opened`: which view, and whether the person took control. */
  view: z.enum(["browser", "computer"]).nullable().default(null),
  control: z.boolean().default(false),
}).strict().meta({ ref: "RemoteDeviceWorkbotReport" })
export type RemoteDeviceWorkbotReport = z.infer<typeof remoteDeviceWorkbotReportSchema>

/** What the latest desktop report said, kept for platform admins. */
export const remoteDeviceDiagnosticsSchema = z.object({
  reportedAt: timestampSchema,
  osVersion: z.string().nullable(),
  arch: z.string().nullable(),
  computerUse: z.object({
    enabled: z.boolean(),
    remoteEnabled: z.boolean(),
    selectedId: z.string().nullable(),
    computers: z.array(z.object({
      id: z.string(),
      label: z.string(),
      placement: z.enum(["local", "remote"]),
      readiness: z.enum(REMOTE_DEVICE_COMPUTER_READINESS).nullable(),
      detail: z.string().nullable(),
      provider: z.string().nullable(),
      externalId: z.string().nullable(),
    })),
    permissions: z.object({ accessibility: z.boolean(), screenRecording: z.boolean() }).nullable(),
  }).nullable(),
})
export type RemoteDeviceDiagnostics = z.infer<typeof remoteDeviceDiagnosticsSchema>

const adminEventSchema = remoteDeviceEventSchema.extend({
  /** Fixed codes and ids recorded with the event; never content. */
  data: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).nullable(),
  actorId: z.string().nullable(),
})
export type AdminRemoteDeviceEvent = z.infer<typeof adminEventSchema>

export const adminRemoteDeviceSchema = remoteDeviceSchema.omit({ access: true, canRename: true, canRemove: true }).extend({
  organization: z.object({ id: z.string(), name: z.string() }),
  /** Null for a computer shared with the whole organization, and when the owner has left. */
  owner: z.object({ memberId: z.string(), name: z.string().nullable(), email: z.string().nullable() }).nullable(),
  shared: z.boolean(),
  externalId: z.string(),
  removedAt: timestampSchema.nullable(),
  /** Warnings and errors in the last 24 hours. */
  recentProblems: z.number().int().nonnegative(),
  lastEvent: adminEventSchema.nullable(),
})
export type AdminRemoteDevice = z.infer<typeof adminRemoteDeviceSchema>

export const ADMIN_REMOTE_DEVICE_PAGE_SIZE = 50

export const adminRemoteDeviceListResponseSchema = z.object({
  devices: z.array(adminRemoteDeviceSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  /** Across the whole deployment, whatever the filters. */
  summary: z.object({
    total: z.number().int().nonnegative(),
    online: z.number().int().nonnegative(),
    withProblems: z.number().int().nonnegative(),
  }),
})
export type AdminRemoteDeviceListResponse = z.infer<typeof adminRemoteDeviceListResponseSchema>

export const adminRemoteDeviceDetailResponseSchema = z.object({
  device: adminRemoteDeviceSchema,
  diagnostics: remoteDeviceDiagnosticsSchema.nullable(),
  /** Newest first, at most 100. */
  events: z.array(adminEventSchema),
  /** The desktop's runner registration, when it has one: what remote sessions and Automations see. */
  runner: z.object({
    computerId: z.string(),
    capabilities: z.array(z.string()),
    appVersion: z.string(),
    lastSeenAt: timestampSchema,
    workspaces: z.number().int().nonnegative().nullable(),
    inventoryUpdatedAt: timestampSchema.nullable(),
  }).nullable(),
  /** For Workbot's computers: Den's content-free index row for the conversation. */
  session: z.object({
    sessionId: z.string(),
    kind: z.string(),
    title: z.string(),
    updatedAt: timestampSchema,
    activeTurnSince: timestampSchema.nullable(),
    deletedAt: timestampSchema.nullable(),
  }).nullable(),
  /** Feature state for the owner (or the organization for a shared computer), so a rollout gap is obvious. */
  features: z.object({
    remoteDevices: z.boolean(),
    computerUse: z.boolean(),
    remoteComputers: z.boolean(),
    browserUse: z.boolean(),
    sandboxGateway: z.boolean(),
  }),
})
export type AdminRemoteDeviceDetailResponse = z.infer<typeof adminRemoteDeviceDetailResponseSchema>

export const REMOTE_DEVICE_AVAILABILITY_LABELS: Record<RemoteDeviceAvailability, string> = {
  online: "Online",
  paused: "Paused",
  needs_setup: "Needs setup",
  offline: "Offline",
  unknown: "Not checked yet",
}

/** What a person calls the computer, from its kind, provider and platform. */
export function remoteDeviceTypeLabel(device: { kind: RemoteDeviceKind; provider: RemoteDeviceProvider; platform: RemoteDevicePlatform | null }): string {
  if (device.kind === "desktop") {
    if (device.platform === "darwin") return "Mac"
    if (device.platform === "win32") return "Windows PC"
    if (device.platform === "linux") return "Linux computer"
    return "Computer"
  }
  if (device.provider === "workbot") return "Workbot's computer"
  if (device.provider === "mac_host" || device.platform === "darwin") return "Mac sandbox"
  if (device.provider === "freestyle") return "Freestyle VM"
  if (device.provider === "daytona") return "Daytona VM"
  return "Virtual computer"
}
