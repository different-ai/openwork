import { z } from "zod"
import {
  OPEN_WORK_EXTENSION_MANIFEST_LIMITS,
  OPEN_WORK_EXTENSION_MANIFEST_SCHEMA_VERSION,
} from "./limits.js"

const stableIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const environmentVariablePattern = /^[A-Za-z_][A-Za-z0-9_]*$/

function boundedNonBlankString(maximum: number, label: string) {
  return z.string()
    .min(1)
    .max(maximum)
    .refine((value) => value.trim().length > 0, `${label} cannot be blank.`)
}

function addDuplicateStringIssues(
  values: readonly string[],
  context: z.RefinementCtx,
  label: string,
): void {
  const firstIndexByValue = new Map<string, number>()
  for (const [index, value] of values.entries()) {
    const firstIndex = firstIndexByValue.get(value)
    if (firstIndex !== undefined) {
      context.addIssue({
        code: "custom",
        message: `Duplicate ${label} "${value}"; first declared at index ${firstIndex}.`,
        path: [index],
      })
      continue
    }
    firstIndexByValue.set(value, index)
  }
}

export const openWorkExtensionStableIdSchema = z.string()
  .min(1)
  .max(OPEN_WORK_EXTENSION_MANIFEST_LIMITS.identifierLength)
  .regex(
    stableIdPattern,
    "Extension identifiers must start with an ASCII letter or digit and contain only letters, digits, dots, underscores, colons, or hyphens.",
  )

export const reloadReasonSchema = z.enum([
  "plugins",
  "skills",
  "mcp",
  "config",
  "agents",
  "commands",
])

export const openWorkExtensionSourceFormatSchema = z.enum([
  "openwork-builtin",
  "openwork-extension-manifest",
  "claude-plugin",
  "opencode-plugin",
  "mcp-directory",
  "manual",
])

export const openWorkExtensionSourceOriginSchema = z.enum([
  "builtin",
  "den",
  "workspace",
  "local",
])

export const openWorkExtensionSourceSchema = z.object({
  format: openWorkExtensionSourceFormatSchema,
  trusted: z.boolean(),
  origin: openWorkExtensionSourceOriginSchema.optional(),
  reference: boundedNonBlankString(
    OPEN_WORK_EXTENSION_MANIFEST_LIMITS.sourceReferenceLength,
    "Source reference",
  ).optional(),
}).readonly()

export const openWorkExtensionResourceTypeSchema = z.enum([
  "skill",
  "agent",
  "command",
  "tool",
  "mcp",
  "opencode-plugin",
  "provider",
  "hook",
  "context",
  "secret",
  "file",
  "local-service",
  "native-binary",
])

export const openWorkExtensionLocalCommandRefSchema = z.enum([
  "openwork.computerUseMcp",
  "openwork.uiMcp",
])

export const openWorkExtensionCommandSchema = z.array(
  boundedNonBlankString(
    OPEN_WORK_EXTENSION_MANIFEST_LIMITS.commandArgumentLength,
    "Command argument",
  ),
).min(1).max(OPEN_WORK_EXTENSION_MANIFEST_LIMITS.commandArgumentCount).readonly()

export const openWorkExtensionResourceSchema = z.object({
  type: openWorkExtensionResourceTypeSchema,
  id: openWorkExtensionStableIdSchema,
  label: boundedNonBlankString(OPEN_WORK_EXTENSION_MANIFEST_LIMITS.labelLength, "Resource label").optional(),
  description: boundedNonBlankString(
    OPEN_WORK_EXTENSION_MANIFEST_LIMITS.descriptionLength,
    "Resource description",
  ).optional(),
  path: boundedNonBlankString(OPEN_WORK_EXTENSION_MANIFEST_LIMITS.referenceLength, "Resource path").optional(),
  command: openWorkExtensionCommandSchema.optional(),
  envKey: z.string()
    .min(1)
    .max(OPEN_WORK_EXTENSION_MANIFEST_LIMITS.identifierLength)
    .regex(environmentVariablePattern, "Environment keys must use portable variable-name syntax.")
    .optional(),
  packageName: boundedNonBlankString(
    OPEN_WORK_EXTENSION_MANIFEST_LIMITS.referenceLength,
    "Package name",
  ).optional(),
  providerId: openWorkExtensionStableIdSchema.optional(),
  mcpServerName: openWorkExtensionStableIdSchema.optional(),
  localCommandRef: openWorkExtensionLocalCommandRefSchema.optional(),
  required: z.boolean().optional(),
}).readonly()

export const openWorkExtensionResourceListSchema = z.array(openWorkExtensionResourceSchema)
  .max(OPEN_WORK_EXTENSION_MANIFEST_LIMITS.resourceCount)
  .superRefine((resources, context) => {
    const firstIndexById = new Map<string, number>()
    for (const [index, resource] of resources.entries()) {
      const firstIndex = firstIndexById.get(resource.id)
      if (firstIndex !== undefined) {
        context.addIssue({
          code: "custom",
          message: `Duplicate resource id "${resource.id}"; first declared at index ${firstIndex}.`,
          path: [index, "id"],
        })
        continue
      }
      firstIndexById.set(resource.id, index)
    }
  })
  .readonly()

export const openWorkExtensionContributionTypeSchema = z.enum([
  "settings-panel",
  "setup-instructions",
  "composer-prompt",
  "session-side-panel",
  "session-rail-item",
  "control-actions",
  "server-route",
  "native-capability",
  "test-action",
])

export const openWorkExtensionContributionLocationSchema = z.enum([
  "settings-detail",
  "composer",
  "session-right-pane",
  "session-rail",
  "server",
  "native",
])

export const openWorkExtensionContributionSchema = z.object({
  type: openWorkExtensionContributionTypeSchema,
  ref: boundedNonBlankString(
    OPEN_WORK_EXTENSION_MANIFEST_LIMITS.referenceLength,
    "Contribution reference",
  ).optional(),
  label: boundedNonBlankString(
    OPEN_WORK_EXTENSION_MANIFEST_LIMITS.labelLength,
    "Contribution label",
  ).optional(),
  description: boundedNonBlankString(
    OPEN_WORK_EXTENSION_MANIFEST_LIMITS.descriptionLength,
    "Contribution description",
  ).optional(),
  prompt: boundedNonBlankString(
    OPEN_WORK_EXTENSION_MANIFEST_LIMITS.promptLength,
    "Contribution prompt",
  ).optional(),
  location: openWorkExtensionContributionLocationSchema.optional(),
}).readonly()

export const openWorkExtensionContributionListSchema = z.array(openWorkExtensionContributionSchema)
  .max(OPEN_WORK_EXTENSION_MANIFEST_LIMITS.contributionCount)
  .readonly()

export const openWorkExtensionRequiredEnvironmentListSchema = z.array(
  z.string()
    .min(1)
    .max(OPEN_WORK_EXTENSION_MANIFEST_LIMITS.identifierLength)
    .regex(environmentVariablePattern, "Environment keys must use portable variable-name syntax."),
)
  .max(OPEN_WORK_EXTENSION_MANIFEST_LIMITS.requiredEnvironmentVariableCount)
  .superRefine((values, context) => addDuplicateStringIssues(values, context, "required environment key"))
  .readonly()

export const openWorkExtensionSetupSchema = z.object({
  instructions: boundedNonBlankString(
    OPEN_WORK_EXTENSION_MANIFEST_LIMITS.instructionsLength,
    "Setup instructions",
  ).optional(),
  primaryCta: boundedNonBlankString(OPEN_WORK_EXTENSION_MANIFEST_LIMITS.labelLength, "Primary CTA").optional(),
  secondaryCta: boundedNonBlankString(OPEN_WORK_EXTENSION_MANIFEST_LIMITS.labelLength, "Secondary CTA").optional(),
  requiredEnv: openWorkExtensionRequiredEnvironmentListSchema.optional(),
  testActionRef: boundedNonBlankString(
    OPEN_WORK_EXTENSION_MANIFEST_LIMITS.referenceLength,
    "Test action reference",
  ).optional(),
}).readonly()

export const openWorkExtensionReloadReasonListSchema = z.array(reloadReasonSchema)
  .max(OPEN_WORK_EXTENSION_MANIFEST_LIMITS.reloadReasonCount)
  .superRefine((values, context) => addDuplicateStringIssues(values, context, "reload reason"))
  .readonly()

export const openWorkExtensionDetectionListSchema = z.array(
  boundedNonBlankString(
    OPEN_WORK_EXTENSION_MANIFEST_LIMITS.referenceLength,
    "Lifecycle detection reference",
  ),
)
  .max(OPEN_WORK_EXTENSION_MANIFEST_LIMITS.detectionCount)
  .superRefine((values, context) => addDuplicateStringIssues(values, context, "detection reference"))
  .readonly()

export const openWorkExtensionLifecycleSchema = z.object({
  reload: openWorkExtensionReloadReasonListSchema.optional(),
  detection: openWorkExtensionDetectionListSchema.optional(),
}).readonly()

export const enablementConditionTypeSchema = z.enum([
  "mcp-connected",
  "plugin-loaded",
  "provider-connected",
  "env-set",
  "permission-granted",
  "toggle-enabled",
])

export const enablementConditionSchema = z.object({
  type: enablementConditionTypeSchema,
  ref: boundedNonBlankString(
    OPEN_WORK_EXTENSION_MANIFEST_LIMITS.referenceLength,
    "Enablement reference",
  ),
  label: boundedNonBlankString(
    OPEN_WORK_EXTENSION_MANIFEST_LIMITS.labelLength,
    "Enablement label",
  ),
}).readonly()

export const enablementConditionListSchema = z.array(enablementConditionSchema)
  .max(OPEN_WORK_EXTENSION_MANIFEST_LIMITS.enablementConditionCount)
  .superRefine((conditions, context) => {
    const firstIndexByIdentity = new Map<string, number>()
    for (const [index, condition] of conditions.entries()) {
      const identity = `${condition.type}\u0000${condition.ref}`
      const firstIndex = firstIndexByIdentity.get(identity)
      if (firstIndex !== undefined) {
        context.addIssue({
          code: "custom",
          message: `Duplicate enablement condition "${condition.type}:${condition.ref}"; first declared at index ${firstIndex}.`,
          path: [index, "ref"],
        })
        continue
      }
      firstIndexByIdentity.set(identity, index)
    }
  })
  .readonly()

export const enablementResultSchema = z.object({
  condition: enablementConditionSchema,
  met: z.boolean(),
}).readonly()

export const openWorkExtensionPlatformSchema = z.enum([
  "darwin",
  "linux",
  "windows",
  "web",
])

export const openWorkExtensionPlatformListSchema = z.array(openWorkExtensionPlatformSchema)
  .max(OPEN_WORK_EXTENSION_MANIFEST_LIMITS.platformCount)
  .superRefine((values, context) => addDuplicateStringIssues(values, context, "platform"))
  .readonly()

export const openWorkExtensionIconSchema = z.object({
  src: boundedNonBlankString(OPEN_WORK_EXTENSION_MANIFEST_LIMITS.referenceLength, "Icon source").optional(),
  simpleIconSlug: boundedNonBlankString(
    OPEN_WORK_EXTENSION_MANIFEST_LIMITS.identifierLength,
    "Simple Icons slug",
  ).optional(),
}).readonly()

export const openWorkExtensionComposerSchema = z.object({
  prompt: boundedNonBlankString(
    OPEN_WORK_EXTENSION_MANIFEST_LIMITS.promptLength,
    "Composer prompt",
  ),
}).readonly()

export const openWorkExtensionManifestV1Schema = z.object({
  schemaVersion: z.literal(OPEN_WORK_EXTENSION_MANIFEST_SCHEMA_VERSION),
  id: openWorkExtensionStableIdSchema,
  name: boundedNonBlankString(OPEN_WORK_EXTENSION_MANIFEST_LIMITS.nameLength, "Extension name"),
  description: boundedNonBlankString(
    OPEN_WORK_EXTENSION_MANIFEST_LIMITS.descriptionLength,
    "Extension description",
  ),
  preview: z.boolean().optional(),
  source: openWorkExtensionSourceSchema,
  icon: openWorkExtensionIconSchema.optional(),
  composer: openWorkExtensionComposerSchema.optional(),
  setup: openWorkExtensionSetupSchema.optional(),
  resources: openWorkExtensionResourceListSchema,
  contributions: openWorkExtensionContributionListSchema.optional(),
  lifecycle: openWorkExtensionLifecycleSchema.optional(),
  enablement: enablementConditionListSchema.optional(),
  defaultEnabled: z.boolean().optional(),
  defaultHidden: z.boolean().optional(),
  platform: openWorkExtensionPlatformListSchema.optional(),
}).readonly()

/** The current manifest schema alias. New versions must get a distinct export. */
export const openWorkExtensionManifestSchema = openWorkExtensionManifestV1Schema

export const openWorkExtensionManifestCatalogV1Schema = z.array(openWorkExtensionManifestV1Schema)
  .max(OPEN_WORK_EXTENSION_MANIFEST_LIMITS.manifestCount)
  .superRefine((manifests, context) => {
    const firstIndexById = new Map<string, number>()
    for (const [index, manifest] of manifests.entries()) {
      const firstIndex = firstIndexById.get(manifest.id)
      if (firstIndex !== undefined) {
        context.addIssue({
          code: "custom",
          message: `Duplicate extension manifest id "${manifest.id}"; first declared at index ${firstIndex}.`,
          path: [index, "id"],
        })
        continue
      }
      firstIndexById.set(manifest.id, index)
    }
  })
  .readonly()

export type ReloadReason = z.infer<typeof reloadReasonSchema>
export type OpenWorkExtensionSourceFormat = z.infer<typeof openWorkExtensionSourceFormatSchema>
export type OpenWorkExtensionSourceOrigin = z.infer<typeof openWorkExtensionSourceOriginSchema>
export type OpenWorkExtensionSource = z.infer<typeof openWorkExtensionSourceSchema>
export type OpenWorkExtensionResourceType = z.infer<typeof openWorkExtensionResourceTypeSchema>
export type OpenWorkExtensionLocalCommandRef = z.infer<typeof openWorkExtensionLocalCommandRefSchema>
export type OpenWorkExtensionResource = z.infer<typeof openWorkExtensionResourceSchema>
export type OpenWorkExtensionContributionType = z.infer<typeof openWorkExtensionContributionTypeSchema>
export type OpenWorkExtensionContributionLocation = z.infer<typeof openWorkExtensionContributionLocationSchema>
export type OpenWorkExtensionContribution = z.infer<typeof openWorkExtensionContributionSchema>
export type OpenWorkExtensionSetup = z.infer<typeof openWorkExtensionSetupSchema>
export type OpenWorkExtensionLifecycle = z.infer<typeof openWorkExtensionLifecycleSchema>
export type EnablementConditionType = z.infer<typeof enablementConditionTypeSchema>
export type EnablementCondition = z.infer<typeof enablementConditionSchema>
export type EnablementResult = z.infer<typeof enablementResultSchema>
export type OpenWorkExtensionPlatform = z.infer<typeof openWorkExtensionPlatformSchema>
export type OpenWorkExtensionIcon = z.infer<typeof openWorkExtensionIconSchema>
export type OpenWorkExtensionComposer = z.infer<typeof openWorkExtensionComposerSchema>
export type OpenWorkExtensionManifestV1 = z.infer<typeof openWorkExtensionManifestV1Schema>
export type OpenWorkExtensionManifest = OpenWorkExtensionManifestV1
export type OpenWorkExtensionManifestCatalogV1 = z.infer<typeof openWorkExtensionManifestCatalogV1Schema>
