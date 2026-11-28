import { z } from "zod"
import { remoteSessionAccessModeSchema } from "@openwork/types/automations"

/**
 * Remote devices: Den's access-controlled registry of the computers a
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
/** A turn Den was never told ended stops counting as Workbot working after this long. */
export const REMOTE_DEVICE_WORKING_MAX_MS = 24 * 60 * 60_000
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
  if (input.provider === "workbot") return recent ? "online" : "unknown"
  return recent ? "online" : "unknown"
}

const timestampSchema = z.string().datetime({ offset: true })
const labelSchema = z.string().trim().min(1).max(80)
const detailSchema = z.string().trim().max(300)

/**
 * What the owner's other devices, Workbot and agents working for them may do
 * on a signed-in desktop right now: `off` nothing, `created` start tasks there
 * and follow the ones they started, `all` also open sessions started there.
 * The owner chooses on the computer; the organization sets the most that may
 * be chosen.
 */
export const REMOTE_DEVICE_ACCESS_REASONS = ["organization", "not_chosen", "update_required"] as const
export type RemoteDeviceAccessReason = (typeof REMOTE_DEVICE_ACCESS_REASONS)[number]

export const remoteDeviceAccessSchema = z.object({
  effective: remoteSessionAccessModeSchema,
  chosen: z.boolean(),
  reason: z.enum(REMOTE_DEVICE_ACCESS_REASONS).nullable(),
}).meta({ ref: "RemoteDeviceAccess" })
export type RemoteDeviceAccess = z.infer<typeof remoteDeviceAccessSchema>

export const remoteDeviceSchema = z.object({
  id: z.string(),
  kind: z.enum(REMOTE_DEVICE_KINDS),
  provider: z.enum(REMOTE_DEVICE_PROVIDERS),
  source: z.enum(REMOTE_DEVICE_SOURCES),
  platform: z.enum(REMOTE_DEVICE_PLATFORMS).nullable(),
  label: z.string(),
  access: z.enum(["mine", "shared"]),
  availability: z.enum(REMOTE_DEVICE_AVAILABILITIES),
  state: z.enum(REMOTE_DEVICE_STATES),
  statusDetail: z.string().nullable(),
  lastSeenAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
  appVersion: z.string().nullable(),
  computerId: z.string().nullable(),
  workbotChat: z.string().nullable(),
  workingSince: timestampSchema.nullable().default(null),
  canRename: z.boolean(),
  canRemove: z.boolean(),
  disconnectedAt: timestampSchema.nullable().default(null),
  canDisconnect: z.boolean().default(false),
  remoteAccess: remoteDeviceAccessSchema.nullable().default(null),
}).meta({ ref: "RemoteDevice" })
export type RemoteDevice = z.infer<typeof remoteDeviceSchema>

export const REMOTE_DEVICE_EVENT_LEVELS = ["info", "warning", "error"] as const
export type RemoteDeviceEventLevel = (typeof REMOTE_DEVICE_EVENT_LEVELS)[number]
export const REMOTE_DEVICE_EVENT_ACTORS = ["member", "device", "workbot", "system"] as const
export type RemoteDeviceEventActor = (typeof REMOTE_DEVICE_EVENT_ACTORS)[number]

/** Stable event names; the message is the human sentence. */
export const REMOTE_DEVICE_EVENT_TYPES = [
  "registered", "renamed", "removed", "restored", "disconnected",
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
  shared: z.boolean().default(false),
}).strict().meta({ ref: "RegisterRemoteDeviceRequest" })
export type RemoteDeviceRegisterRequest = z.infer<typeof remoteDeviceRegisterRequestSchema>

export const remoteDeviceUpdateRequestSchema = z.object({ label: labelSchema }).strict().meta({ ref: "UpdateRemoteDeviceRequest" })
export type RemoteDeviceUpdateRequest = z.infer<typeof remoteDeviceUpdateRequestSchema>

/** Readiness as the desktop's computer use reports it (`ComputerStatus.readiness`). */
export const REMOTE_DEVICE_COMPUTER_READINESS = ["ready", "setup-required", "unsupported", "unavailable"] as const
export type RemoteDeviceComputerReadiness = (typeof REMOTE_DEVICE_COMPUTER_READINESS)[number]

const reportedComputerSchema = z.object({
  id: z.string().trim().min(1).max(64),
  label: labelSchema,
  placement: z.enum(["local", "remote"]),
  readiness: z.enum(REMOTE_DEVICE_COMPUTER_READINESS).nullable(),
  detail: detailSchema.nullable(),
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
  installId: z.string().trim().min(8).max(160),
  machineKey: z.string().length(64).regex(/^[a-f0-9]+$/).optional(),
  label: labelSchema,
  platform: z.enum(REMOTE_DEVICE_PLATFORMS),
  appVersion: z.string().trim().min(1).max(80),
  osVersion: z.string().trim().max(80).nullable().default(null),
  arch: z.string().trim().max(32).nullable().default(null),
  computerUse: z.object({
    enabled: z.boolean(),
    remoteEnabled: z.boolean(),
    selectedId: z.string().trim().max(64).nullable(),
    computers: z.array(reportedComputerSchema).max(12),
    permissions: z.object({ accessibility: z.boolean(), screenRecording: z.boolean() }).strict().nullable().default(null),
  }).strict().nullable().default(null),
}).strict().meta({ ref: "RemoteDeviceDesktopReport" })
export type RemoteDeviceDesktopReport = z.infer<typeof remoteDeviceDesktopReportSchema>

export const remoteDeviceDesktopReportResponseSchema = z.object({
  device: remoteDeviceSchema,
  reportAfterSeconds: z.number().int().positive(),
}).meta({ ref: "RemoteDeviceDesktopReportResponse" })
export type RemoteDeviceDesktopReportResponse = z.infer<typeof remoteDeviceDesktopReportResponseSchema>

/** What Workbot's server tells Den about a chat's cloud computer. */
export const REMOTE_DEVICE_WORKBOT_EVENTS = ["viewer_opened", "paused", "resumed", "rebuilt", "continued", "failed", "removed"] as const
export type RemoteDeviceWorkbotEvent = (typeof REMOTE_DEVICE_WORKBOT_EVENTS)[number]

export const remoteDeviceWorkbotReportSchema = z.object({
  sessionId: z.string().regex(/^hs_[A-Za-z0-9_-]{8,96}$/),
  chat: z.string().trim().min(1).max(96),
  event: z.enum(REMOTE_DEVICE_WORKBOT_EVENTS),
  code: z.string().trim().regex(/^[a-z][a-z0-9_]{0,63}$/).nullable().default(null),
  view: z.enum(["browser", "computer"]).nullable().default(null),
  control: z.boolean().default(false),
}).strict().meta({ ref: "RemoteDeviceWorkbotReport" })
export type RemoteDeviceWorkbotReport = z.infer<typeof remoteDeviceWorkbotReportSchema>

/** What the latest desktop report said, kept for authorized organization inventory readers. */
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

const organizationComputerEventSchema = remoteDeviceEventSchema.extend({
  data: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).nullable(),
  actorId: z.string().nullable(),
})
export type OrganizationComputerEvent = z.infer<typeof organizationComputerEventSchema>

export const organizationComputerSchema = remoteDeviceSchema.omit({ access: true, canRename: true }).extend({
  canRemove: z.boolean().default(false),
  organization: z.object({ id: z.string(), name: z.string() }),
  owner: z.object({
    memberId: z.string(),
    name: z.string().nullable(),
    email: z.string().nullable(),
    former: z.boolean().default(false),
  }).nullable(),
  shared: z.boolean(),
  externalId: z.string(),
  removedAt: timestampSchema.nullable(),
  recentProblems: z.number().int().nonnegative(),
  lastEvent: organizationComputerEventSchema.nullable(),
})
export type OrganizationComputerRecord = z.infer<typeof organizationComputerSchema>

export const ORGANIZATION_COMPUTER_PAGE_SIZE = 50

/**
 * Disconnect a signed-in desktop from the organization
 * (`POST /v1/remote-devices/:deviceId/disconnect` for its owner,
 * `POST /v1/org/computers/:deviceId/disconnect` with `computers.disconnect`).
 *
 * Den stops accepting that install as the member's computer at once: no remote
 * tasks, no session access, no reports. Where Den knows the sign-in the
 * desktop uses, and it is not the caller's own, that sign-in is ended too, so
 * the app on that computer is signed out. Signing in on the computer again
 * connects it again; nothing else does.
 */
export const remoteDeviceDisconnectResponseSchema = z.object({
  device: remoteDeviceSchema,
  signedOut: z.boolean(),
}).meta({ ref: "RemoteDeviceDisconnectResponse" })
export type RemoteDeviceDisconnectResponse = z.infer<typeof remoteDeviceDisconnectResponseSchema>

export const organizationComputerDisconnectResponseSchema = z.object({
  device: organizationComputerSchema,
  signedOut: z.boolean(),
}).meta({ ref: "OrganizationComputerDisconnectResponse" })
export type OrganizationComputerDisconnectResponse = z.infer<typeof organizationComputerDisconnectResponseSchema>

/**
 * What a disconnected desktop is told, with HTTP 403, when it asks for a
 * runner token, calls a runner route or reports itself. The app stops
 * retrying and tells its user to sign in again.
 */
export const COMPUTER_DISCONNECTED_ERROR = "computer_disconnected"

/** Computers a team list leaves out unless asked: desktops nobody has heard from for this long. */
export const ORGANIZATION_COMPUTER_STALE_MS = 30 * 24 * 60 * 60_000

export const organizationComputerDetailResponseSchema = z.object({
  device: organizationComputerSchema,
  diagnostics: remoteDeviceDiagnosticsSchema.nullable(),
  events: z.array(organizationComputerEventSchema),
  runner: z.object({
    computerId: z.string(),
    capabilities: z.array(z.string()),
    appVersion: z.string(),
    lastSeenAt: timestampSchema,
    workspaces: z.number().int().nonnegative().nullable(),
    inventoryUpdatedAt: timestampSchema.nullable(),
  }).nullable(),
  session: z.object({
    sessionId: z.string(),
    kind: z.string(),
    updatedAt: timestampSchema,
    activeTurnSince: timestampSchema.nullable(),
    deletedAt: timestampSchema.nullable(),
  }).nullable(),
  features: z.object({
    remoteDevices: z.boolean(),
    computerUse: z.boolean(),
    remoteComputers: z.boolean(),
    browserUse: z.boolean(),
    sandboxGateway: z.boolean(),
  }),
})
export type OrganizationComputerDetailResponse = z.infer<typeof organizationComputerDetailResponseSchema>

/** Registered OpenWork worker hosts; status is reported, not inferred online/OS. */
export const organizationComputerInstanceSchema = z.object({
  id: z.string(),
  name: z.string(),
  destination: z.enum(["local", "cloud"]),
  status: z.enum(["provisioning", "healthy", "failed", "stopped"]),
  owner: z.object({ memberId: z.string().nullable(), name: z.string().nullable(), email: z.string().nullable() }).nullable(),
  version: z.string().nullable(),
  provider: z.string().nullable(),
  region: z.string().nullable(),
  lastSeenAt: timestampSchema.nullable(),
  lastActiveAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
})
export type OrganizationComputerInstance = z.infer<typeof organizationComputerInstanceSchema>
export type OrganizationRegisteredInstance = OrganizationComputerInstance
export const organizationComputerInstanceDetailResponseSchema = z.object({ instance: organizationComputerInstanceSchema })

/** Current organization's team inventory; each inventory category is paged independently. */
export const organizationComputerListResponseSchema = z.object({
  devices: z.array(organizationComputerSchema),
  total: z.number().int().nonnegative(),
  online: z.number().int().nonnegative().optional(),
  staleHidden: z.number().int().nonnegative().default(0),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  instances: z.array(organizationComputerInstanceSchema),
  instancesTotal: z.number().int().nonnegative(),
  instancePage: z.number().int().positive(),
  instancePageSize: z.number().int().positive(),
})
export type OrganizationComputerListResponse = z.infer<typeof organizationComputerListResponseSchema>

export const REMOTE_DEVICE_AVAILABILITY_LABELS: Record<RemoteDeviceAvailability, string> = {
  online: "Online",
  paused: "Paused",
  needs_setup: "Needs setup",
  offline: "Offline",
  unknown: "Not checked yet",
}
export const REMOTE_DEVICE_DISCONNECTED_LABEL = "Disconnected"

/**
 * The version a list shows: release and channel, without the build. The full
 * string stays available where detail is shown.
 * `0.18.66-alpha.4137+053df1c` -> `0.18.66 alpha`.
 */
export function shortAppVersion(version: string | null | undefined): string | null {
  const full = version?.trim()
  if (!full) return null
  const [core = "", ...rest] = full.split("+")[0]?.split("-") ?? []
  const channel = rest.join("-").split(".")[0]?.trim()
  if (!/^\d+(\.\d+)*$/.test(core)) return full
  return channel && /^[a-z]+$/i.test(channel) ? `${core} ${channel}` : core
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
