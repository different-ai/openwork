import { z } from "zod"

import { contributionsOfType, type AppContribution } from "./contributions.js"
import { parseJsonStrict } from "./json.js"
import {
  APP_API_VERSION,
  MANIFEST_VERSION,
  appManifestSchema,
  resolveDistributionAsset,
  type AppManifest,
} from "./manifest.js"
import { APP_PERMISSION_IDS, type AppPermission, type AppPermissionId } from "./permissions.js"
import { compareSemVer, formatWindow, parseSemVer, satisfiesWindow } from "./semver.js"

// The canonical validator.
//
// One implementation, used by the CLI, CI, server preview, installation, and
// update. A second validator would drift, and a drifted validator is how an app
// gets installed with authority the review screen never showed.
//
// Two layers:
//   1. `appManifestSchema` — shape, types, enums, bounds, unknown-key rejection.
//   2. cross-field rules below — the invariants a per-field schema cannot see,
//      like "this sidebar item points at a surface that exists" and "you
//      disclosed a third-party host you have no permission to reach".
//
// Everything fails closed. There is no "unknown field, probably fine" path.

export type DiagnosticSeverity = "error" | "warning"

export type Diagnostic = {
  severity: DiagnosticSeverity
  /** Stable machine-readable code; safe to switch on and to show in CI output. */
  code: string
  /** Dotted path into the manifest, or "" for document-level problems. */
  path: string
  message: string
  hint?: string
}

export type ManifestValidation =
  | { ok: true; manifest: AppManifest; diagnostics: Diagnostic[] }
  | { ok: false; diagnostics: Diagnostic[] }

function error(code: string, path: string, message: string, hint?: string): Diagnostic {
  return hint === undefined
    ? { severity: "error", code, path, message }
    : { severity: "error", code, path, message, hint }
}

function warning(code: string, path: string, message: string, hint?: string): Diagnostic {
  return hint === undefined
    ? { severity: "warning", code, path, message }
    : { severity: "warning", code, path, message, hint }
}

function formatZodIssues(issues: readonly z.core.$ZodIssue[]): Diagnostic[] {
  return issues.flatMap((issue): Diagnostic[] => {
    const path = issue.path.map(String).join(".")
    if (issue.code === "unrecognized_keys") {
      return [
        error(
          "manifest.unknown_field",
          path,
          `unknown field${issue.keys.length > 1 ? "s" : ""}: ${issue.keys.join(", ")}`,
          "Unknown fields are rejected so a typo cannot silently drop a declaration.",
        ),
      ]
    }
    // A plain union reports every branch's failure. Reporting all of them buries
    // the real problem, so surface the closest branch — the one that got
    // furthest before failing.
    if (issue.code === "invalid_union" && issue.errors.length > 0) {
      const closest = issue.errors.reduce((best, branch) =>
        branch.length < best.length ? branch : best,
      )
      const nested = formatZodIssues(closest)
      if (nested.length > 0) {
        return nested.map((diagnostic) => ({
          ...diagnostic,
          path: [path, diagnostic.path].filter(Boolean).join("."),
        }))
      }
    }
    return [error("manifest.invalid_field", path, issue.message)]
  })
}

/**
 * Validate a manifest document.
 *
 * `input` may be the raw file text (parsed strictly, duplicate keys rejected) or
 * an already-parsed value.
 */
export function validateManifest(input: string | unknown): ManifestValidation {
  let value: unknown = input
  if (typeof input === "string") {
    const parsed = parseJsonStrict(input)
    if (!parsed.ok) {
      return {
        ok: false,
        diagnostics: [
          error(
            "manifest.invalid_json",
            "",
            `openwork.app.json is not valid JSON: ${parsed.error} (offset ${parsed.offset})`,
          ),
        ],
      }
    }
    value = parsed.value
  }

  // Report an unsupported manifest_version on its own: every other message
  // would be noise about fields that may not exist in that version.
  if (value !== null && typeof value === "object" && "manifest_version" in value) {
    const declared = (value as { manifest_version: unknown }).manifest_version
    if (declared !== MANIFEST_VERSION) {
      return {
        ok: false,
        diagnostics: [
          error(
            "manifest.unsupported_version",
            "manifest_version",
            `unsupported manifest_version ${JSON.stringify(declared)}; this OpenWork supports ${MANIFEST_VERSION}`,
            "Upgrade OpenWork, or publish a package targeting manifest_version 1.",
          ),
        ],
      }
    }
  }

  const parsed = appManifestSchema.safeParse(value)
  if (!parsed.success) return { ok: false, diagnostics: formatZodIssues(parsed.error.issues) }

  const diagnostics = crossCheckManifest(parsed.data)
  if (diagnostics.some((entry) => entry.severity === "error")) return { ok: false, diagnostics }
  return { ok: true, manifest: parsed.data, diagnostics }
}

function permissionIds(permissions: readonly AppPermission[]): Set<AppPermissionId> {
  return new Set(permissions.map((permission) => permission.id))
}

function contributionIds(contributions: readonly AppContribution[]): Map<string, AppContribution> {
  const map = new Map<string, AppContribution>()
  for (const contribution of contributions) map.set(contribution.id, contribution)
  return map
}

/** Invariants across fields. Exported so packaging tools can reuse the exact rules. */
export function crossCheckManifest(manifest: AppManifest): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  const { contributions, permissions, entrypoints } = manifest

  // --- duplicate ids -------------------------------------------------------
  const seenContribution = new Set<string>()
  contributions.forEach((contribution, index) => {
    if (seenContribution.has(contribution.id)) {
      diagnostics.push(
        error(
          "contribution.duplicate_id",
          `contributions.${index}.id`,
          `duplicate contribution id "${contribution.id}"`,
          "Contribution ids are unique across every type, because the registry keys them as <appId>/<contributionId>.",
        ),
      )
    }
    seenContribution.add(contribution.id)
  })

  const seenPermission = new Set<string>()
  permissions.forEach((permission, index) => {
    if (seenPermission.has(permission.id)) {
      diagnostics.push(
        error(
          "permission.duplicate",
          `permissions.${index}.id`,
          `permission "${permission.id}" is declared more than once`,
          "Merge the declarations; parameters from separate entries are not combined.",
        ),
      )
    }
    seenPermission.add(permission.id)
  })

  const byId = contributionIds(contributions)
  const granted = permissionIds(permissions)
  const surfaces = contributionsOfType(contributions, "surface")
  const sidebarItems = contributionsOfType(contributions, "right_sidebar_item")
  const commands = contributionsOfType(contributions, "command")
  const shortcuts = contributionsOfType(contributions, "shortcut")
  const backgrounds = contributionsOfType(contributions, "background")
  const statuses = contributionsOfType(contributions, "status")

  // --- entrypoints ---------------------------------------------------------
  const declaredSurfaceKeys = new Set(Object.keys(entrypoints.surfaces))
  const referencedSurfaceKeys = new Set<string>()

  for (const surface of surfaces) {
    const index = contributions.indexOf(surface)
    if (!declaredSurfaceKeys.has(surface.entrypoint)) {
      diagnostics.push(
        error(
          "contribution.missing_entrypoint",
          `contributions.${index}.entrypoint`,
          `surface "${surface.id}" points at entrypoint "${surface.entrypoint}", which is not declared in entrypoints.surfaces`,
        ),
      )
    }
    referencedSurfaceKeys.add(surface.entrypoint)
    if (surface.presentation === "floating" && !granted.has("desktop.floatingSurface")) {
      diagnostics.push(
        error(
          "contribution.permission_missing",
          `contributions.${index}.presentation`,
          `surface "${surface.id}" is floating but the app does not request desktop.floatingSurface`,
        ),
      )
    }
    if (surface.min_size) {
      if (
        surface.min_size.width > surface.default_size.width ||
        surface.min_size.height > surface.default_size.height
      ) {
        diagnostics.push(
          error(
            "contribution.invalid_size",
            `contributions.${index}.min_size`,
            `surface "${surface.id}" has a min_size larger than its default_size`,
          ),
        )
      }
    }
  }

  for (const key of declaredSurfaceKeys) {
    if (!referencedSurfaceKeys.has(key)) {
      diagnostics.push(
        error(
          "entrypoint.unreferenced",
          `entrypoints.surfaces.${key}`,
          `entrypoint "${key}" is not used by any surface contribution`,
          "Every shipped entrypoint must be reachable through a declared contribution.",
        ),
      )
    }
  }

  if (backgrounds.length > 1) {
    diagnostics.push(
      error("contribution.multiple_background", "contributions", "at most one background contribution is allowed"),
    )
  }
  if (backgrounds.length === 1 && entrypoints.background === undefined) {
    diagnostics.push(
      error(
        "entrypoint.missing_background",
        "entrypoints.background",
        "a background contribution is declared but entrypoints.background is missing",
      ),
    )
  }
  if (backgrounds.length === 0 && entrypoints.background !== undefined) {
    diagnostics.push(
      error(
        "entrypoint.unreferenced",
        "entrypoints.background",
        "entrypoints.background is declared but no background contribution uses it",
      ),
    )
  }
  if (backgrounds.length === 1 && !granted.has("runtime.background.continuous")) {
    diagnostics.push(
      warning(
        "contribution.background_without_permission",
        "contributions",
        "a background entrypoint is declared without runtime.background.continuous",
        "It will only run while a surface is open. Request the permission for continuous operation.",
      ),
    )
  }

  // --- cross-references ----------------------------------------------------
  const surfaceIds = new Set(surfaces.map((surface) => surface.id))
  for (const item of sidebarItems) {
    const index = contributions.indexOf(item)
    if (!surfaceIds.has(item.surface)) {
      diagnostics.push(
        error(
          "contribution.dangling_reference",
          `contributions.${index}.surface`,
          `right_sidebar_item "${item.id}" activates surface "${item.surface}", which is not declared`,
        ),
      )
    }
  }

  const commandIds = new Set(commands.map((command) => command.id))
  const shortcutPermission = permissions.find(
    (permission): permission is Extract<AppPermission, { id: "desktop.globalShortcut" }> =>
      permission.id === "desktop.globalShortcut",
  )
  const grantedShortcutIds = new Set(shortcutPermission?.shortcuts.map((entry) => entry.id) ?? [])

  for (const shortcut of shortcuts) {
    const index = contributions.indexOf(shortcut)
    if (!commandIds.has(shortcut.command)) {
      diagnostics.push(
        error(
          "contribution.dangling_reference",
          `contributions.${index}.command`,
          `shortcut "${shortcut.id}" invokes command "${shortcut.command}", which is not declared`,
        ),
      )
    }
    if (shortcut.global && !grantedShortcutIds.has(shortcut.id)) {
      diagnostics.push(
        error(
          "contribution.permission_missing",
          `contributions.${index}.global`,
          `global shortcut "${shortcut.id}" is not listed in the desktop.globalShortcut permission`,
          "List every global shortcut id in the permission so the trust screen can show it.",
        ),
      )
    }
  }
  for (const id of grantedShortcutIds) {
    const contribution = byId.get(id)
    if (contribution?.type !== "shortcut") {
      diagnostics.push(
        error(
          "permission.dangling_shortcut",
          "permissions",
          `desktop.globalShortcut lists "${id}", which is not a declared shortcut contribution`,
        ),
      )
    }
  }

  const sidebarIds = new Set(sidebarItems.map((item) => item.id))
  for (const status of statuses) {
    const index = contributions.indexOf(status)
    if (!sidebarIds.has(status.target)) {
      diagnostics.push(
        error(
          "contribution.dangling_reference",
          `contributions.${index}.target`,
          `status "${status.id}" targets "${status.target}", which is not a right_sidebar_item`,
        ),
      )
    }
  }

  // --- permission coherence ------------------------------------------------
  const networkPermission = permissions.find(
    (permission): permission is Extract<AppPermission, { id: "network.host" }> =>
      permission.id === "network.host",
  )
  const allowedHosts = new Set(networkPermission?.hosts ?? [])

  if (granted.has("ai.realtime") && allowedHosts.size === 0) {
    diagnostics.push(
      error(
        "permission.unreachable_capability",
        "permissions",
        "ai.realtime is requested without a network.host permission",
        "A realtime session needs its endpoint host listed so the sandbox can allow it.",
      ),
    )
  }

  for (const [index, party] of manifest.privacy.third_parties.entries()) {
    if (!allowedHosts.has(party.host)) {
      diagnostics.push(
        error(
          "privacy.undeclared_host",
          `privacy.third_parties.${index}.host`,
          `privacy disclosure names "${party.host}" but network.host does not allow it`,
          "Disclosure and enforcement must agree; add the host to network.host or remove the disclosure.",
        ),
      )
    }
  }

  const handled = new Set(manifest.privacy.data_handled)
  if (granted.has("audio.microphone") && !handled.has("microphone-audio")) {
    diagnostics.push(
      error(
        "privacy.incomplete_disclosure",
        "privacy.data_handled",
        "audio.microphone is requested but privacy.data_handled omits microphone-audio",
      ),
    )
  }
  if (granted.has("openwork.connect.read") && !handled.has("connected-source-content")) {
    diagnostics.push(
      error(
        "privacy.incomplete_disclosure",
        "privacy.data_handled",
        "openwork.connect.read is requested but privacy.data_handled omits connected-source-content",
      ),
    )
  }
  if (handled.has("none") && manifest.privacy.data_handled.length > 1) {
    diagnostics.push(
      error(
        "privacy.contradictory_disclosure",
        "privacy.data_handled",
        '"none" cannot be combined with other data categories',
      ),
    )
  }
  if (granted.has("openwork.attachments.create") && !granted.has("openwork.threads.start")) {
    diagnostics.push(
      warning(
        "permission.unused_capability",
        "permissions",
        "openwork.attachments.create without openwork.threads.start has no surface to deliver an attachment to",
      ),
    )
  }

  // --- distribution --------------------------------------------------------
  if (manifest.distribution.repository !== manifest.repository) {
    diagnostics.push(
      error(
        "distribution.repository_mismatch",
        "distribution.repository",
        "distribution.repository must match the app's repository",
        "v1 installs only from the app's own repository releases.",
      ),
    )
  }
  const asset = resolveDistributionAsset(manifest)
  if (asset.includes("{") || asset.includes("}")) {
    diagnostics.push(
      error(
        "distribution.invalid_asset",
        "distribution.asset",
        `asset name still contains a placeholder after substitution: ${asset}`,
        "{version} is the only supported placeholder.",
      ),
    )
  }

  // --- engines -------------------------------------------------------------
  for (const key of ["openwork", "app_api"] as const) {
    const window = manifest.engines[key]
    if (window.max_exclusive === undefined) continue
    const min = parseSemVer(window.min)
    const max = parseSemVer(window.max_exclusive)
    if (min && max && compareSemVer(min, max) >= 0) {
      diagnostics.push(
        error(
          "engine.empty_range",
          `engines.${key}`,
          `engines.${key} has an empty range (${formatWindow(window)})`,
        ),
      )
    }
  }

  // --- platforms -----------------------------------------------------------
  const seenOs = new Set<string>()
  manifest.platforms.forEach((platform, index) => {
    if (seenOs.has(platform.os)) {
      diagnostics.push(
        error("platform.duplicate", `platforms.${index}.os`, `platform "${platform.os}" is listed twice`),
      )
    }
    seenOs.add(platform.os)
    if (new Set(platform.arch).size !== platform.arch.length) {
      diagnostics.push(
        error("platform.duplicate_arch", `platforms.${index}.arch`, "duplicate architecture entry"),
      )
    }
  })

  // --- environment ---------------------------------------------------------
  const envKeys = new Set<string>()
  for (const [group, list] of [
    ["required", manifest.environment.required],
    ["optional", manifest.environment.optional],
  ] as const) {
    list.forEach((requirement, index) => {
      if (envKeys.has(requirement.key)) {
        diagnostics.push(
          error(
            "environment.duplicate_key",
            `environment.${group}.${index}.key`,
            `environment key "${requirement.key}" is declared more than once`,
          ),
        )
      }
      envKeys.add(requirement.key)
    })
  }

  return diagnostics
}

// ---------------------------------------------------------------------------
// Host compatibility
// ---------------------------------------------------------------------------

export type HostEnvironment = {
  openworkVersion: string
  appApiVersion?: string
  os: "darwin" | "linux" | "win32"
  arch: "x64" | "arm64"
}

export type CompatibilityResult =
  | { compatible: true }
  | {
      compatible: false
      reason: "engine_incompatible" | "app_api_incompatible" | "platform_unsupported"
      diagnostic: Diagnostic
    }

/** Decide whether this host generation can run this manifest at all. */
export function checkCompatibility(
  manifest: AppManifest,
  host: HostEnvironment,
): CompatibilityResult {
  const engine = satisfiesWindow(host.openworkVersion, manifest.engines.openwork)
  if (!engine.satisfied) {
    return {
      compatible: false,
      reason: "engine_incompatible",
      diagnostic: error(
        "compatibility.engine",
        "engines.openwork",
        `this app needs OpenWork ${formatWindow(manifest.engines.openwork)}; this build is ${host.openworkVersion}`,
        engine.reason === "below_min" ? "Update OpenWork." : "This app needs an update for this OpenWork version.",
      ),
    }
  }

  const appApi = satisfiesWindow(host.appApiVersion ?? APP_API_VERSION, manifest.engines.app_api)
  if (!appApi.satisfied) {
    return {
      compatible: false,
      reason: "app_api_incompatible",
      diagnostic: error(
        "compatibility.app_api",
        "engines.app_api",
        `this app needs App API ${formatWindow(manifest.engines.app_api)}; this build provides ${host.appApiVersion ?? APP_API_VERSION}`,
      ),
    }
  }

  const platform = manifest.platforms.find((entry) => entry.os === host.os)
  if (!platform || !platform.arch.includes(host.arch)) {
    return {
      compatible: false,
      reason: "platform_unsupported",
      diagnostic: error(
        "compatibility.platform",
        "platforms",
        `this app does not support ${host.os}/${host.arch}`,
      ),
    }
  }

  return { compatible: true }
}

/** Permission ids a manifest requests that this host generation does not implement. */
export function unsupportedPermissions(manifest: AppManifest): string[] {
  const known = new Set<string>(APP_PERMISSION_IDS)
  return manifest.permissions.map((permission) => permission.id).filter((id) => !known.has(id))
}

export function errorsOnly(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return diagnostics.filter((entry) => entry.severity === "error")
}

export function formatDiagnostic(diagnostic: Diagnostic): string {
  const location = diagnostic.path ? ` at ${diagnostic.path}` : ""
  const hint = diagnostic.hint ? `\n    ${diagnostic.hint}` : ""
  return `${diagnostic.severity}: ${diagnostic.message}${location} [${diagnostic.code}]${hint}`
}
