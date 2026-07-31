import { z } from "zod"

import { appIdSchema, httpsUrl } from "./manifest.js"
import { appPermissionSchema } from "./permissions.js"
import { commitShaSchema, digestSchema, packageProvenanceSchema } from "./package.js"

// Installed-app lifecycle.
//
// Four axes, deliberately independent. Collapsing them into a single enum is
// what produces the bug where installing an app starts its microphone:
//
//   installation  what the host has on disk
//   setup         whether required secrets are configured
//   enablement    whether the user turned it on
//   runtime       what is actually executing right now
//
// An app can be installed, fully set up, and still disabled. It can be enabled
// and stopped. Only `runtime: "running"` means code is executing.

export const installationStateSchema = z.enum([
  /** Package verified and extracted; contributions not registered. */
  "installed",
  /** An update is downloaded and verified but withheld pending permission review. */
  "update_pending_review",
  /** Repeated crashes; the runtime is refused until the user repairs it. */
  "quarantined",
  /** Package files failed verification on load. */
  "corrupt",
])
export type InstallationState = z.infer<typeof installationStateSchema>

export const setupStateSchema = z.enum(["setup_required", "ready"])
export type SetupState = z.infer<typeof setupStateSchema>

export const enablementStateSchema = z.enum(["disabled", "enabled"])
export type EnablementState = z.infer<typeof enablementStateSchema>

export const runtimeStateSchema = z.enum(["stopped", "starting", "running", "stopping", "crashed"])
export type RuntimeState = z.infer<typeof runtimeStateSchema>

export const compatibilityStateSchema = z.enum([
  "compatible",
  "engine_incompatible",
  "app_api_incompatible",
  "platform_unsupported",
])
export type CompatibilityState = z.infer<typeof compatibilityStateSchema>

/**
 * A verified package the host can run or roll back to.
 *
 * `archive_digest` is the pin: it is what the preview candidate recorded, what
 * the downloaded bytes had to match, and what a later integrity check compares
 * against. Two records with the same digest are the same bytes.
 */
export const installedPackageRecordSchema = z
  .object({
    app_version: z.string().min(1).max(64),
    archive_digest: digestSchema,
    manifest_digest: digestSchema,
    source: packageProvenanceSchema,
    /** Directory name under the app's install root; never an absolute path. */
    directory: z.string().min(1).max(128),
    installed_at: z.int().min(0),
    permissions: z.array(appPermissionSchema),
  })
  .strict()

export type InstalledPackageRecord = z.infer<typeof installedPackageRecordSchema>

export const installedAppRecordSchema = z
  .object({
    app_id: appIdSchema,
    installation: installationStateSchema,
    setup: setupStateSchema,
    enablement: enablementStateSchema,
    compatibility: compatibilityStateSchema,
    /** Currently active package. */
    active: installedPackageRecordSchema,
    /** Retained previous package, present only when rollback is available. */
    previous: installedPackageRecordSchema.nullable(),
    /** Verified but unapplied update awaiting permission review. */
    pending: installedPackageRecordSchema.nullable(),
    /** Permissions the user has approved for the active package. */
    granted_permissions: z.array(appPermissionSchema),
    /** Consecutive runtime crashes; reset on a clean start or repair. */
    crash_count: z.int().min(0),
    trusted_at: z.int().min(0),
    updated_at: z.int().min(0),
  })
  .strict()

export type InstalledAppRecord = z.infer<typeof installedAppRecordSchema>

/**
 * Short-lived binding created by preview and consumed by install.
 *
 * Preview resolves a mutable ref to an immutable commit and pins every input
 * the user was shown. Install refuses to re-resolve anything: it takes the
 * candidate or it fails. That is what closes the gap between "the user approved
 * these permissions" and "these bytes were installed".
 */
export const installCandidateSchema = z
  .object({
    candidate_id: z.string().min(16).max(128),
    app_id: appIdSchema,
    app_version: z.string().min(1).max(64),
    repository: z.string().min(1).max(255),
    release_tag: z.string().min(1).max(128),
    commit: commitShaSchema,
    archive_url: httpsUrl(2048),
    archive_digest: digestSchema,
    manifest_digest: digestSchema,
    requested_permissions: z.array(appPermissionSchema),
    created_at: z.int().min(0),
    expires_at: z.int().min(0),
  })
  .strict()

export type InstallCandidate = z.infer<typeof installCandidateSchema>

/** Candidates expire quickly: they exist to span one review, not one session. */
export const INSTALL_CANDIDATE_TTL_MS = 15 * 60 * 1000

/** Crashes within the window before the runtime is quarantined. */
export const CRASH_QUARANTINE_THRESHOLD = 3
export const CRASH_QUARANTINE_WINDOW_MS = 60 * 1000

export const appLifecycleEventSchema = z.enum([
  "preview_created",
  "trust_granted",
  "installed",
  "setup_completed",
  "enabled",
  "disabled",
  "runtime_started",
  "runtime_stopped",
  "runtime_crashed",
  "quarantined",
  "repaired",
  "update_available",
  "update_withheld_pending_review",
  "update_applied",
  "rolled_back",
  "permission_revoked",
  "uninstalled",
  "app_data_deleted",
  "app_data_retained",
  "capability_denied",
])
export type AppLifecycleEvent = z.infer<typeof appLifecycleEventSchema>

/**
 * One audit row. Never carries secret values, transcript bodies, connected
 * record contents, or provider payloads — only what happened, to which app, at
 * what version, and why.
 */
export const appAuditEntrySchema = z
  .object({
    at: z.int().min(0),
    app_id: appIdSchema,
    app_version: z.string().min(1).max(64),
    event: appLifecycleEventSchema,
    /** Permission or capability the event concerns, when applicable. */
    subject: z.string().max(128).optional(),
    /** Stable machine-readable reason, never free-form provider output. */
    reason: z.string().max(160).optional(),
  })
  .strict()

export type AppAuditEntry = z.infer<typeof appAuditEntrySchema>

/**
 * Whether an installed app may currently register contributions and run.
 *
 * Every gate is checked; the first failure is returned so the UI can say
 * exactly which one to fix.
 */
export type ActivationCheck =
  | { active: true }
  | {
      active: false
      blocked_by:
        | "installation"
        | "compatibility"
        | "setup"
        | "enablement"
        | "runtime_crashed"
    }

export function checkActivation(record: InstalledAppRecord): ActivationCheck {
  if (record.installation !== "installed") return { active: false, blocked_by: "installation" }
  if (record.compatibility !== "compatible") return { active: false, blocked_by: "compatibility" }
  if (record.setup !== "ready") return { active: false, blocked_by: "setup" }
  if (record.enablement !== "enabled") return { active: false, blocked_by: "enablement" }
  return { active: true }
}

/** Rollback needs a retained previous package that is still verified. */
export function canRollBack(record: InstalledAppRecord): boolean {
  return record.previous !== null && record.installation !== "corrupt"
}
