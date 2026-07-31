import { z } from "zod"

import { contributionIdSchema } from "./contributions.js"
import { httpsUrl } from "./manifest.js"
import { CONNECT_READ_SCOPES, type AppPermissionId } from "./permissions.js"

// The capability broker contract.
//
// Everything privileged an app can do goes through one versioned request/
// response channel. There is no second path: no direct IPC, no server route, no
// injected client object with more reach than this file describes.
//
// Three properties every capability keeps:
//
//   * It names the permission it requires, so denial is decidable before any
//     work starts.
//   * Its response carries no secret values. Credentials are minted, scoped and
//     short-lived, or they are never handed over at all.
//   * Failure is typed. An app can tell "you did not grant this" from "the
//     provider is down" from "you asked too often" without parsing prose.

export const CAPABILITY_PROTOCOL_VERSION = 1 as const

export const CAPABILITY_NAMES = [
  "env.status",
  "ai.realtime.session",
  "ai.inference.run",
  "connect.capabilities",
  "connect.query",
  "threads.start",
  "attachments.create",
  "surface.present",
  "surface.dismiss",
  "status.set",
  "storage.get",
  "storage.set",
  "storage.remove",
  "audio.capture.start",
  "audio.capture.stop",
] as const

export type CapabilityName = (typeof CAPABILITY_NAMES)[number]

/** Permission each capability requires. `null` means the capability is unprivileged. */
export const CAPABILITY_PERMISSION: Readonly<Record<CapabilityName, AppPermissionId | null>> =
  Object.freeze({
    "env.status": null,
    "ai.realtime.session": "ai.realtime",
    "ai.inference.run": "ai.inference.transient",
    "connect.capabilities": "openwork.connect.read",
    "connect.query": "openwork.connect.read",
    "threads.start": "openwork.threads.start",
    "attachments.create": "openwork.attachments.create",
    "surface.present": "desktop.floatingSurface",
    "surface.dismiss": "desktop.floatingSurface",
    "status.set": null,
    "storage.get": "storage.app",
    "storage.set": "storage.app",
    "storage.remove": "storage.app",
    "audio.capture.start": "audio.microphone",
    "audio.capture.stop": "audio.microphone",
  })

/** Capabilities that additionally require a fresh host-issued user-gesture token. */
export const CAPABILITY_REQUIRES_GESTURE: Readonly<Record<CapabilityName, boolean>> = Object.freeze({
  "env.status": false,
  "ai.realtime.session": false,
  "ai.inference.run": false,
  "connect.capabilities": false,
  "connect.query": false,
  "threads.start": true,
  "attachments.create": true,
  "surface.present": false,
  "surface.dismiss": false,
  "status.set": false,
  "storage.get": false,
  "storage.set": false,
  "storage.remove": false,
  "audio.capture.start": false,
  "audio.capture.stop": false,
})

/** A gesture token is minted on a real user input event and dies quickly. */
export const USER_GESTURE_TTL_MS = 10_000

export const capabilityErrorCodeSchema = z.enum([
  "permission_denied",
  "permission_revoked",
  "gesture_required",
  "gesture_expired",
  "gesture_replayed",
  "unsupported_capability",
  "invalid_request",
  "not_ready",
  "quota_exceeded",
  "rate_limited",
  "timeout",
  "workspace_changed",
  "upstream_unavailable",
  "network_host_denied",
  "internal_error",
])
export type CapabilityErrorCode = z.infer<typeof capabilityErrorCodeSchema>

export const capabilityErrorSchema = z
  .object({
    code: capabilityErrorCodeSchema,
    /** Safe for display. Never contains secrets, payloads, or provider bodies. */
    message: z.string().min(1).max(280),
    /** Permission that would unblock the call, when the failure is a permission failure. */
    permission: z.string().max(64).optional(),
  })
  .strict()

export type CapabilityError = z.infer<typeof capabilityErrorSchema>

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

const envStatusRequest = z.object({ capability: z.literal("env.status") }).strict()

const realtimeSessionRequest = z
  .object({
    capability: z.literal("ai.realtime.session"),
    model: z.string().min(1).max(96),
    /** Requested transcription model, subject to host allow-listing. */
    transcription_model: z.string().min(1).max(96).optional(),
  })
  .strict()

const inferenceRunRequest = z
  .object({
    capability: z.literal("ai.inference.run"),
    /** Stable id for the app-side prompt template, used for quota accounting and audit. */
    task: z.string().min(1).max(64),
    input: z.string().min(1).max(32_000),
    /** JSON Schema the response must satisfy. The host validates before returning. */
    response_schema: z.record(z.string(), z.unknown()),
    max_output_tokens: z.int().min(1).max(4096).optional(),
    timeout_ms: z.int().min(1000).max(60_000).optional(),
  })
  .strict()

const connectCapabilitiesRequest = z
  .object({ capability: z.literal("connect.capabilities") })
  .strict()

const connectQueryRequest = z
  .object({
    capability: z.literal("connect.query"),
    scope: z.enum(CONNECT_READ_SCOPES),
    /** Free-text query or provider-specific selector, length-bounded and logged only as a length. */
    query: z.string().min(1).max(512),
    limit: z.int().min(1).max(25).default(10),
    /** ISO-8601 lower bound for time-scoped scopes. */
    since: z.iso.datetime().optional(),
    until: z.iso.datetime().optional(),
  })
  .strict()

const threadStartRequest = z
  .object({
    capability: z.literal("threads.start"),
    gesture_token: z.string().min(16).max(256),
    title: z.string().min(1).max(160),
    /** The agent goal the user accepted, in the app's own words. */
    goal: z.string().min(1).max(1000),
    summary: z.string().min(1).max(4000),
    /** Structured provenance the thread can cite. */
    provenance: z
      .array(
        z
          .object({
            scope: z.enum(CONNECT_READ_SCOPES),
            title: z.string().min(1).max(200),
            url: httpsUrl(2048).optional(),
            occurred_at: z.iso.datetime().optional(),
          })
          .strict(),
      )
      .max(20)
      .default([]),
    /** Opaque app-side session id, carried for correlation. */
    app_session_id: z.string().max(128).optional(),
    /** Attachment produced by a prior `attachments.create` call. */
    attachment_id: z.string().max(128).optional(),
  })
  .strict()

const attachmentCreateRequest = z
  .object({
    capability: z.literal("attachments.create"),
    gesture_token: z.string().min(16).max(256),
    filename: z
      .string()
      .min(1)
      .max(96)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "filename must be a plain relative name"),
    content_type: z.enum(["text/markdown", "text/plain", "application/json"]),
    content: z.string().min(1).max(256_000),
  })
  .strict()

const surfacePresentRequest = z
  .object({
    capability: z.literal("surface.present"),
    surface: contributionIdSchema,
  })
  .strict()

const surfaceDismissRequest = z
  .object({
    capability: z.literal("surface.dismiss"),
    surface: contributionIdSchema,
  })
  .strict()

const statusSetRequest = z
  .object({
    capability: z.literal("status.set"),
    status: contributionIdSchema,
    value: z
      .union([
        z.object({ kind: z.literal("clear") }).strict(),
        z.object({ kind: z.literal("dot"), tone: z.enum(["neutral", "active", "attention"]) }).strict(),
        z.object({ kind: z.literal("badge"), count: z.int().min(0).max(999) }).strict(),
        z.object({ kind: z.literal("text"), text: z.string().min(1).max(24) }).strict(),
      ])
      .describe("status value"),
  })
  .strict()

const storageKey = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "storage key must be alphanumeric with . _ -")

const storageGetRequest = z
  .object({ capability: z.literal("storage.get"), key: storageKey })
  .strict()

const storageSetRequest = z
  .object({
    capability: z.literal("storage.set"),
    key: storageKey,
    /** JSON value, size-checked against the granted `storage.app` quota. */
    value: z.unknown(),
  })
  .strict()

const storageRemoveRequest = z
  .object({ capability: z.literal("storage.remove"), key: storageKey })
  .strict()

const audioCaptureStartRequest = z
  .object({
    capability: z.literal("audio.capture.start"),
    /** Surface that owns the visible listening state; the host refuses silent capture. */
    surface: contributionIdSchema,
  })
  .strict()

const audioCaptureStopRequest = z.object({ capability: z.literal("audio.capture.stop") }).strict()

export const capabilityRequestSchema = z.discriminatedUnion("capability", [
  envStatusRequest,
  realtimeSessionRequest,
  inferenceRunRequest,
  connectCapabilitiesRequest,
  connectQueryRequest,
  threadStartRequest,
  attachmentCreateRequest,
  surfacePresentRequest,
  surfaceDismissRequest,
  statusSetRequest,
  storageGetRequest,
  storageSetRequest,
  storageRemoveRequest,
  audioCaptureStartRequest,
  audioCaptureStopRequest,
])

export type CapabilityRequest = z.infer<typeof capabilityRequestSchema>

export type CapabilityRequestOf<T extends CapabilityName> = Extract<
  CapabilityRequest,
  { capability: T }
>

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** Configuration status only. The value never crosses the broker. */
export const environmentStatusSchema = z
  .object({
    key: z.string().min(1).max(128),
    configured: z.boolean(),
    required: z.boolean(),
  })
  .strict()

export const connectProviderStatusSchema = z
  .object({
    provider: z.string().min(1).max(64),
    scope: z.enum(CONNECT_READ_SCOPES),
    /** `available` only when the connected system itself advertises the operation. */
    status: z.enum(["available", "not_connected", "not_authorized", "unavailable"]),
  })
  .strict()

export const connectRecordSchema = z
  .object({
    scope: z.enum(CONNECT_READ_SCOPES),
    id: z.string().min(1).max(256),
    title: z.string().max(300),
    /** Redacted, length-bounded excerpt. Never a full message body. */
    excerpt: z.string().max(1200),
    url: httpsUrl(2048).optional(),
    occurred_at: z.iso.datetime().optional(),
    author: z.string().max(160).optional(),
  })
  .strict()

export const capabilityResultSchema = z.discriminatedUnion("capability", [
  z
    .object({
      capability: z.literal("env.status"),
      variables: z.array(environmentStatusSchema),
    })
    .strict(),
  z
    .object({
      capability: z.literal("ai.realtime.session"),
      /** Short-lived client secret minted by the host. Not the user's API key. */
      client_secret: z.string().min(1).max(4096),
      expires_at: z.int().min(0),
      model: z.string().min(1).max(96),
    })
    .strict(),
  z
    .object({
      capability: z.literal("ai.inference.run"),
      /** Already validated against the request's `response_schema`. */
      output: z.unknown(),
      truncated: z.boolean(),
    })
    .strict(),
  z
    .object({
      capability: z.literal("connect.capabilities"),
      providers: z.array(connectProviderStatusSchema),
    })
    .strict(),
  z
    .object({
      capability: z.literal("connect.query"),
      records: z.array(connectRecordSchema),
      /** True when results were cut by the host's size or time limit. */
      truncated: z.boolean(),
    })
    .strict(),
  z
    .object({
      capability: z.literal("threads.start"),
      thread_id: z.string().min(1).max(128),
    })
    .strict(),
  z
    .object({
      capability: z.literal("attachments.create"),
      attachment_id: z.string().min(1).max(128),
    })
    .strict(),
  z.object({ capability: z.literal("surface.present") }).strict(),
  z.object({ capability: z.literal("surface.dismiss") }).strict(),
  z.object({ capability: z.literal("status.set") }).strict(),
  z
    .object({ capability: z.literal("storage.get"), value: z.unknown(), present: z.boolean() })
    .strict(),
  z.object({ capability: z.literal("storage.set") }).strict(),
  z.object({ capability: z.literal("storage.remove"), removed: z.boolean() }).strict(),
  z.object({ capability: z.literal("audio.capture.start") }).strict(),
  z.object({ capability: z.literal("audio.capture.stop") }).strict(),
])

export type CapabilityResult = z.infer<typeof capabilityResultSchema>

export type CapabilityResultOf<T extends CapabilityName> = Extract<
  CapabilityResult,
  { capability: T }
>

export const capabilityResponseSchema = z.union([
  z.object({ ok: z.literal(true), result: capabilityResultSchema }).strict(),
  z.object({ ok: z.literal(false), error: capabilityErrorSchema }).strict(),
])

export type CapabilityResponse = z.infer<typeof capabilityResponseSchema>

/** Envelope carried over the preload bridge. `id` correlates a reply to its call. */
export const capabilityEnvelopeSchema = z
  .object({
    protocol_version: z.literal(CAPABILITY_PROTOCOL_VERSION),
    id: z.string().min(1).max(128),
    request: capabilityRequestSchema,
  })
  .strict()

export type CapabilityEnvelope = z.infer<typeof capabilityEnvelopeSchema>

// ---------------------------------------------------------------------------
// Host -> app events
// ---------------------------------------------------------------------------

export const appEventSchema = z.discriminatedUnion("event", [
  z
    .object({
      event: z.literal("lifecycle"),
      phase: z.enum(["activate", "deactivate", "suspend", "resume"]),
    })
    .strict(),
  z.object({ event: z.literal("command"), command: contributionIdSchema }).strict(),
  z
    .object({
      event: z.literal("shortcut"),
      shortcut: z.string().min(1).max(64),
      /** Present when the shortcut is a genuine user gesture the app may spend. */
      gesture_token: z.string().min(16).max(256).optional(),
    })
    .strict(),
  z
    .object({
      event: z.literal("setting_changed"),
      setting: contributionIdSchema,
      value: z.union([z.string(), z.boolean()]),
    })
    .strict(),
  z
    .object({
      event: z.literal("surface_visibility"),
      surface: contributionIdSchema,
      visible: z.boolean(),
    })
    .strict(),
  z
    .object({
      event: z.literal("permission_revoked"),
      permission: z.string().min(1).max(64),
    })
    .strict(),
  z
    .object({
      event: z.literal("workspace_changed"),
      /** Every in-flight request bound to the previous workspace is already cancelled. */
      workspace_id: z.string().max(128).nullable(),
    })
    .strict(),
  z
    .object({
      event: z.literal("environment_changed"),
      variables: z.array(environmentStatusSchema),
    })
    .strict(),
])

export type AppEvent = z.infer<typeof appEventSchema>

export function capabilityRequiresGesture(capability: CapabilityName): boolean {
  return CAPABILITY_REQUIRES_GESTURE[capability]
}

export function permissionForCapability(capability: CapabilityName): AppPermissionId | null {
  return CAPABILITY_PERMISSION[capability]
}
