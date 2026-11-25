import { z } from "zod"
import {
  DEFAULT_REMOTE_SESSION_ACCESS_MODE,
  remoteSessionAccessModeSchema,
  remoteSessionPendingSummarySchema,
  remoteSessionWaitingForSchema,
  type RemoteSessionAccessMode,
} from "@openwork/types/automations"

/** Organization metadata key holding the ceiling. */
export const ORGANIZATION_REMOTE_SESSION_SETTINGS_KEY = "remoteSessions"

export const organizationRemoteSessionSettingsSchema = z.object({
  access: remoteSessionAccessModeSchema,
}).meta({ ref: "OrganizationRemoteSessionSettings" })
export type OrganizationRemoteSessionSettings = z.infer<typeof organizationRemoteSessionSettingsSchema>

export const DEFAULT_ORGANIZATION_REMOTE_SESSION_SETTINGS: OrganizationRemoteSessionSettings = {
  access: DEFAULT_REMOTE_SESSION_ACCESS_MODE,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function metadataRecord(metadata: unknown): Record<string, unknown> | null {
  if (isRecord(metadata)) return metadata
  if (typeof metadata !== "string") return null
  try {
    const parsed: unknown = JSON.parse(metadata)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Anything missing or unreadable is the narrow default, never the wide one. */
export function readOrganizationRemoteSessionSettings(metadata: unknown): OrganizationRemoteSessionSettings {
  const stored = metadataRecord(metadata)?.[ORGANIZATION_REMOTE_SESSION_SETTINGS_KEY]
  const value = isRecord(stored) ? stored.access : undefined
  const access: RemoteSessionAccessMode = value === "all" || value === "off" ? value : "created"
  return { access }
}

export function withOrganizationRemoteSessionSettings(
  metadata: Record<string, unknown> | null | undefined,
  settings: OrganizationRemoteSessionSettings,
): Record<string, unknown> {
  return { ...(metadata ?? {}), [ORGANIZATION_REMOTE_SESSION_SETTINGS_KEY]: { access: settings.access } }
}

/** `GET` and `PATCH /v1/org/remote-session-settings`. */
export const organizationRemoteSessionSettingsResponseSchema = z.object({
  settings: organizationRemoteSessionSettingsSchema,
  canEdit: z.boolean(),
  allowsAll: z.boolean().default(true),
  optIn: z.boolean().default(false),
}).meta({ ref: "OrganizationRemoteSessionSettingsResponse" })
export type OrganizationRemoteSessionSettingsResponse = z.infer<typeof organizationRemoteSessionSettingsResponseSchema>

const idSchema = z.string().trim().min(1).max(240)
const timestampSchema = z.string().datetime({ offset: true })

/** One of the member's own computers that can run or reach sessions. */
export const memberSessionComputerSchema = z.object({
  computerId: z.string().max(160),
  label: z.string().max(240),
  platform: z.enum(["darwin", "win32", "linux"]).nullable(),
  online: z.boolean(),
  lastSeenAt: timestampSchema.nullable(),
  supportsAccess: z.boolean(),
  access: remoteSessionAccessModeSchema,
  chosen: z.boolean().default(true),
  effectiveAccess: remoteSessionAccessModeSchema,
  sessionsUpdatedAt: timestampSchema.nullable(),
}).meta({ ref: "MemberSessionComputer" })
export type MemberSessionComputer = z.infer<typeof memberSessionComputerSchema>

/**
 * How the caller can act on a session right now.
 * - `reachable`: read it, send a follow-up, stop it, answer what it waits on.
 * - `connecting`: a start or attach is queued for the computer.
 * - `attachable`: started on the computer; attach first, then it is reachable.
 */
export const memberSessionReachSchema = z.enum(["reachable", "connecting", "attachable"])
export type MemberSessionReach = z.infer<typeof memberSessionReachSchema>

/** `unknown`: the computer listed the session but has not reported how it is doing. */
export const memberSessionStateSchema = z.enum(["starting", "running", "waiting", "idle", "error", "unknown"])
export type MemberSessionState = z.infer<typeof memberSessionStateSchema>

export const memberSessionSchema = z.object({
  key: z.string().max(700),
  computerId: z.string().max(160).nullable(),
  computerLabel: z.string().max(240).nullable(),
  workspaceId: idSchema.nullable(),
  workspaceName: z.string().max(120).nullable(),
  sessionId: idSchema.nullable(),
  title: z.string().max(240).nullable(),
  origin: z.enum(["remote", "local"]),
  reach: memberSessionReachSchema,
  commandId: z.string().max(160).nullable(),
  state: memberSessionStateSchema,
  waitingFor: remoteSessionWaitingForSchema.nullable(),
  pending: remoteSessionPendingSummarySchema.nullable(),
  latestStep: z.string().max(240).nullable(),
  updatedAt: timestampSchema.nullable(),
}).meta({ ref: "MemberSession" })
export type MemberSession = z.infer<typeof memberSessionSchema>

export const MEMBER_SESSION_LIST_LIMIT = 200

/** `GET /v1/sessions`: the member's own sessions across their computers, newest first. */
export const memberSessionListResponseSchema = z.object({
  ceiling: remoteSessionAccessModeSchema,
  optIn: z.boolean().default(false),
  computers: z.array(memberSessionComputerSchema),
  sessions: z.array(memberSessionSchema).max(MEMBER_SESSION_LIST_LIMIT),
}).meta({ ref: "MemberSessionListResponse" })
export type MemberSessionListResponse = z.infer<typeof memberSessionListResponseSchema>

/** `POST /v1/remote-sessions/attach` and `remote-session:attach`. */
export const remoteSessionAttachRequestSchema = z.object({
  computerId: z.string().trim().min(1).max(160),
  workspaceId: idSchema,
  sessionId: idSchema,
})
export type RemoteSessionAttachRequest = z.infer<typeof remoteSessionAttachRequestSchema>

export const remoteSessionAttachResponseSchema = z.object({
  target: z.literal("desktop"),
  state: z.enum(["queued", "attached"]),
  commandId: z.string().max(160),
  computerId: z.string().max(160),
  workspaceId: idSchema,
  sessionId: idSchema,
  expiresAt: timestampSchema.nullable(),
}).meta({ ref: "RemoteSessionAttachResponse" })
export type RemoteSessionAttachResponse = z.infer<typeof remoteSessionAttachResponseSchema>

/**
 * Why an attach was refused. Every code is final for the same request except
 * `desktop_offline`, which clears when the computer reconnects.
 */
export const REMOTE_SESSION_ATTACH_ERROR_CODES = [
  "feature_disabled",
  "unknown_computer",
  "desktop_offline",
  "desktop_update_required",
  "session_access_denied",
  "session_unavailable",
] as const
export type RemoteSessionAttachErrorCode = (typeof REMOTE_SESSION_ATTACH_ERROR_CODES)[number]

/**
 * What a caller is told, with HTTP 409 and not retryable, when the computer
 * takes nothing from other devices: its owner chose `off`, has not chosen yet
 * under the organization's opt-in, or the organization's ceiling is `off`.
 */
export const REMOTE_ACCESS_OFF_ERROR = "remote_access_off"
