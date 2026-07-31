import { z } from "zod"

import { appContributionSchema, packagePathSchema } from "./contributions.js"
import { APP_PERMISSION_IDS, appPermissionSchema } from "./permissions.js"
import { isSemVer } from "./semver.js"

// The `openwork.app.json` standard.
//
// This file is the whole public surface an app author writes by hand, so every
// field is spelled the way it appears in JSON: snake_case, no abbreviations,
// no host-internal vocabulary. Unknown keys are rejected rather than ignored —
// a typo in a permission block must fail loudly, not silently drop authority.

/** Current manifest version. Bump only for a breaking change to this shape. */
export const MANIFEST_VERSION = 1 as const

/** App API version this host generation implements. */
export const APP_API_VERSION = "1.0.0" as const

const semver = z.string().refine(isSemVer, "must be a valid SemVer 2.0.0 version")

/**
 * App ids are reverse-DNS with at least two segments. The required dot is
 * structural, not stylistic: built-in OpenWork extension ids never contain a
 * dot, so no installed app can shadow one.
 */
export const appIdSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/,
    "app id must be reverse-DNS, lowercase, with at least two dot-separated segments",
  )

export const githubRepositoryUrlSchema = z
  .string()
  .max(255)
  .regex(
    /^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/,
    "repository must be an https github.com owner/name URL with no trailing path",
  )

/**
 * An `https:` URL, and nothing else.
 *
 * `z.url()` accepts every scheme the WHATWG parser understands — including
 * `javascript:`, `data:` and `file:` — and tolerates leading whitespace. Every
 * URL in a manifest is attacker-controlled and ends up rendered as a link on the
 * trust screen or handed to the OS opener, so the manifest does not get to
 * choose the scheme.
 */
export function httpsUrl(maxLength: number) {
  return z
    .string()
    .max(maxLength)
    // Both checks are deliberate. `z.toJSONSchema` drops refinements but keeps a
    // pattern, so the regex is what the published schema can still enforce for a
    // third-party editor; the refine is the authoritative check here, catching
    // URLs the pattern admits but the parser rejects.
    .regex(/^https:\/\/[^\s]+$/, "must be an https:// URL")
    .refine(
      (value) => {
        try {
          return new URL(value).protocol === "https:"
        } catch {
          return false
        }
      },
      { message: "must be an https:// URL" },
    )
}

const versionWindowSchema = z
  .object({
    min: semver,
    max_exclusive: semver.optional(),
  })
  .strict()

/**
 * Environment variable keys the host may hold on the app's behalf. The app is
 * told whether each is configured; it never receives a value.
 */
const environmentRequirementSchema = z
  .object({
    key: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Z][A-Z0-9_]*$/, "environment key must be SCREAMING_SNAKE_CASE")
      .refine(
        (key) => !key.startsWith("OPENWORK_") && !key.startsWith("OPENCODE_"),
        "OPENWORK_ and OPENCODE_ keys are reserved for host internals",
      ),
    label: z.string().min(1).max(64),
    description: z.string().min(1).max(280).optional(),
    docs_url: httpsUrl(255).optional(),
  })
  .strict()

const privacyRetentionSchema = z
  .object({
    /**
     * `none` keeps nothing past the call, `session` keeps data only while the
     * app runs, `persistent` writes to app storage and must say for how long.
     */
    policy: z.enum(["none", "session", "persistent"]),
    description: z.string().min(1).max(500),
  })
  .strict()

const privacySchema = z
  .object({
    summary: z.string().min(1).max(500),
    data_handled: z
      .array(
        z.enum([
          "microphone-audio",
          "transcripts",
          "connected-source-content",
          "thread-content",
          "usage-telemetry",
          "none",
        ]),
      )
      .min(1),
    retention: privacyRetentionSchema,
    third_parties: z
      .array(
        z
          .object({
            name: z.string().min(1).max(64),
            host: z.string().min(1).max(253),
            purpose: z.string().min(1).max(280),
          })
          .strict(),
      )
      .max(8)
      .default([]),
  })
  .strict()

const distributionSchema = z
  .object({
    type: z.literal("github-release"),
    repository: githubRepositoryUrlSchema,
    /**
     * Release asset name. `{version}` is the only supported placeholder and is
     * substituted with the manifest `version`.
     */
    asset: z
      .string()
      .min(1)
      .max(160)
      .regex(
        /^[A-Za-z0-9._{}-]+\.owapp$/,
        "asset must be a plain .owapp filename, optionally containing {version}",
      ),
  })
  .strict()

const entrypointsSchema = z
  .object({
    /** Module executed in the background runtime. Requires a `background` contribution. */
    background: packagePathSchema.optional(),
    /** Surface key to HTML document path. Keys are referenced by `surface` contributions. */
    surfaces: z
      .record(
        z.string().min(1).max(64).regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/, "surface key must be lowercase"),
        packagePathSchema,
      )
      .default({}),
  })
  .strict()

const publisherSchema = z
  .object({
    name: z.string().min(1).max(96),
    url: httpsUrl(255).optional(),
    /**
     * Publisher identity is unverified in v1. It is displayed as a claim from
     * the repository, never as an attested identity.
     */
    contact: z.email().max(160).optional(),
  })
  .strict()

const iconsSchema = z
  .object({
    default: packagePathSchema,
    light: packagePathSchema.optional(),
    dark: packagePathSchema.optional(),
  })
  .strict()

const platformSchema = z
  .object({
    os: z.enum(["darwin", "linux", "win32"]),
    arch: z.array(z.enum(["x64", "arm64"])).min(1),
  })
  .strict()

export const appManifestSchema = z
  .object({
    manifest_version: z.literal(MANIFEST_VERSION),
    id: appIdSchema,
    name: z.string().min(1).max(64),
    description: z.string().min(1).max(500),
    version: semver,
    publisher: publisherSchema,
    repository: githubRepositoryUrlSchema,
    /** SPDX identifier. Not validated against the full SPDX list; shown verbatim for review. */
    license: z.string().min(1).max(64),
    icons: iconsSchema,
    engines: z
      .object({
        openwork: versionWindowSchema,
        app_api: versionWindowSchema,
      })
      .strict(),
    platforms: z.array(platformSchema).min(1).max(3),
    distribution: distributionSchema,
    entrypoints: entrypointsSchema,
    contributions: z.array(appContributionSchema).max(64).default([]),
    // Bounded well above the vocabulary size so a duplicate is reported by the
    // dedicated `permission.duplicate` rule, which explains itself, rather than
    // by an array-length error that does not.
    permissions: z.array(appPermissionSchema).max(APP_PERMISSION_IDS.length * 2).default([]),
    environment: z
      .object({
        required: z.array(environmentRequirementSchema).max(16).default([]),
        optional: z.array(environmentRequirementSchema).max(16).default([]),
      })
      .strict()
      .default({ required: [], optional: [] }),
    privacy: privacySchema,
    update: z
      .object({
        /** v1 supports GitHub releases only; the field exists so channels can be added later. */
        channel: z.literal("github-release"),
        /** False means the host will refuse rollback and say so on the update screen. */
        rollback_supported: z.boolean(),
      })
      .strict(),
  })
  .strict()

export type AppManifest = z.infer<typeof appManifestSchema>
export type AppManifestInput = z.input<typeof appManifestSchema>

/** Resolve `distribution.asset` for a concrete version. */
export function resolveDistributionAsset(manifest: AppManifest): string {
  return manifest.distribution.asset.replaceAll("{version}", manifest.version)
}
