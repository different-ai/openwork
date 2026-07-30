import { z } from "zod"
import {
  openworkAffordanceArgumentSchema,
  openworkAffordanceEffectsSchema,
} from "./openwork-affordance.js"

export const UI_ARTIFACT_PROJECT_SCHEMA_VERSION = 2
export const UI_ARTIFACT_PROJECT_API_VERSION = 1
export const UI_ARTIFACT_MAX_MANIFEST_BYTES = 32_000
export const UI_ARTIFACT_MAX_SOURCE_BYTES = 256_000
export const UI_ARTIFACT_MAX_STYLES_BYTES = 128_000
export const UI_ARTIFACT_MAX_DATA_BYTES = 128_000
export const UI_ARTIFACT_MAX_DATA_SCHEMA_BYTES = 64_000
export const UI_ARTIFACT_MAX_STATE_BYTES = 64_000
export const UI_ARTIFACT_MAX_INTENT_PAYLOAD_BYTES = 32_000
export const UI_ARTIFACT_MAX_INTENT_PROMPT_BYTES = 12_000
export const UI_ARTIFACT_MAX_BUNDLE_BYTES = 512_000
export const UI_ARTIFACT_MAX_BUILDER_SKILL_BYTES = 16_000
export const UI_ARTIFACT_BUILDER_SKILL_NAME = "openwork-react-artifact-builder"
export const UI_ARTIFACT_SHAPES = ["metric", "summary", "collection"] as const
export const UI_ARTIFACT_SHAPE_SPECS = {
  metric: {
    frameHeight: 160,
    maxWidth: 480,
    maxVisibleItems: 4,
    maxActions: 1,
  },
  summary: {
    frameHeight: 240,
    maxWidth: 640,
    maxVisibleItems: 4,
    maxActions: 2,
  },
  collection: {
    frameHeight: 360,
    maxWidth: 720,
    maxVisibleItems: 5,
    maxActions: 2,
  },
} as const

export const UI_ARTIFACT_PROJECT_FILES = [
  "artifact.json",
  "src/App.tsx",
  "styles.css",
  "data.json",
  "data.schema.json",
] as const

const compactTextSchema = z.string().trim().min(1).max(160)
const descriptionSchema = z.string().trim().min(1).max(2_000)
const isoDateTimeSchema = z.string().datetime({ offset: true })
const artifactSlugSchema = z.string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Artifact slugs must use lowercase kebab-case")
const artifactInstanceIdSchema = z.string()
  .trim()
  .min(1)
  .max(96)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "Instance ids may contain letters, numbers, underscores, and hyphens")
// Revisions are raw lowercase SHA-256 hex so they remain safe as directory
// names on every Electron-supported platform, including Windows.
const sha256DigestSchema = z.string().regex(/^[a-f0-9]{64}$/)

function serializedByteLength(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

function boundedJsonSchema(maxBytes: number) {
  return z.json().refine(
    (value) => serializedByteLength(value) <= maxBytes,
    `JSON value must be at most ${maxBytes} bytes`,
  )
}

export const uiArtifactProjectFileSchema = z.enum(UI_ARTIFACT_PROJECT_FILES)
export type UiArtifactProjectFile = z.infer<typeof uiArtifactProjectFileSchema>

export const uiArtifactProjectRevisionSchema = sha256DigestSchema
export type UiArtifactProjectRevision = z.infer<typeof uiArtifactProjectRevisionSchema>

export const uiArtifactSettingsRevisionSchema = sha256DigestSchema
export type UiArtifactSettingsRevision = z.infer<typeof uiArtifactSettingsRevisionSchema>

export const uiArtifactSettingsSchema = z.object({
  protocol: z.literal("openwork.ui-artifact-settings"),
  schemaVersion: z.literal(UI_ARTIFACT_PROJECT_SCHEMA_VERSION),
  builderSkillEnabled: z.boolean(),
  projectOverrides: z.record(artifactSlugSchema, z.boolean()).refine(
    (value) => Object.keys(value).length <= 512,
    "At most 512 project overrides are supported",
  ),
  settingsRevision: uiArtifactSettingsRevisionSchema,
  updatedAt: isoDateTimeSchema.nullable(),
}).strict()
export type UiArtifactSettings = z.infer<typeof uiArtifactSettingsSchema>

export const uiArtifactSettingsUpdateSchema = z.object({
  expectedRevision: uiArtifactSettingsRevisionSchema,
  builderSkillEnabled: z.boolean().optional(),
  project: z.object({
    slug: artifactSlugSchema,
    enabled: z.boolean(),
  }).strict().optional(),
}).strict().refine(
  (value) => value.builderSkillEnabled !== undefined || value.project !== undefined,
  "A builder skill or project setting update is required",
)
export type UiArtifactSettingsUpdate = z.infer<typeof uiArtifactSettingsUpdateSchema>

export const uiArtifactAgentSkillSchema = z.object({
  protocol: z.literal("openwork.ui-artifact-agent-skill"),
  schemaVersion: z.literal(UI_ARTIFACT_PROJECT_SCHEMA_VERSION),
  name: z.literal(UI_ARTIFACT_BUILDER_SKILL_NAME),
  description: z.string().min(1).max(500).refine((value) => value.trim().length > 0),
  content: z.string().min(1).max(UI_ARTIFACT_MAX_BUILDER_SKILL_BYTES)
    .refine((value) => value.trim().length > 0),
  settingsRevision: uiArtifactSettingsRevisionSchema,
}).strict()
export type UiArtifactAgentSkill = z.infer<typeof uiArtifactAgentSkillSchema>

export const uiArtifactShapeSchema = z.enum(UI_ARTIFACT_SHAPES)
export type UiArtifactShape = z.infer<typeof uiArtifactShapeSchema>

export const uiArtifactPresentationV2Schema = z.object({
  placement: z.enum(["inline", "both"]),
  shape: uiArtifactShapeSchema,
}).strict()
export type UiArtifactPresentationV2 = z.infer<typeof uiArtifactPresentationV2Schema>

export const uiArtifactIntentDeclarationSchema = z.object({
  id: z.string().trim().min(1).max(96).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  title: compactTextSchema,
  description: descriptionSchema,
  arguments: z.array(openworkAffordanceArgumentSchema.strict()).max(24),
  effects: openworkAffordanceEffectsSchema.strict(),
  confirmation: z.enum(["never", "destructive", "always"]),
}).strict()
export type UiArtifactIntentDeclaration = z.infer<typeof uiArtifactIntentDeclarationSchema>

export const uiArtifactProjectManifestSchema = z.object({
  protocol: z.literal("openwork.ui-artifact-project"),
  schemaVersion: z.literal(UI_ARTIFACT_PROJECT_SCHEMA_VERSION),
  apiVersion: z.literal(UI_ARTIFACT_PROJECT_API_VERSION),
  slug: artifactSlugSchema,
  title: compactTextSchema,
  description: descriptionSchema.optional(),
  runtime: z.object({
    kind: z.literal("react"),
    entry: z.literal("src/App.tsx"),
    styles: z.literal("styles.css").optional(),
  }).strict(),
  data: z.object({
    value: z.literal("data.json"),
    schema: z.literal("data.schema.json"),
  }).strict(),
  presentation: uiArtifactPresentationV2Schema,
  intents: z.array(uiArtifactIntentDeclarationSchema).max(32),
}).strict().superRefine((value, context) => {
  const actionLimit = UI_ARTIFACT_SHAPE_SPECS[value.presentation.shape].maxActions
  if (value.intents.length > actionLimit) {
    context.addIssue({
      code: "custom",
      message: `${value.presentation.shape} artifacts may declare at most ${actionLimit} intent${actionLimit === 1 ? "" : "s"}`,
      path: ["intents"],
    })
  }
})
export type UiArtifactProjectManifest = z.infer<typeof uiArtifactProjectManifestSchema>

export const uiArtifactProjectFilesSchema = z.object({
  "artifact.json": z.string().max(UI_ARTIFACT_MAX_MANIFEST_BYTES),
  "src/App.tsx": z.string().max(UI_ARTIFACT_MAX_SOURCE_BYTES),
  "styles.css": z.string().max(UI_ARTIFACT_MAX_STYLES_BYTES),
  "data.json": z.string().max(UI_ARTIFACT_MAX_DATA_BYTES),
  "data.schema.json": z.string().max(UI_ARTIFACT_MAX_DATA_SCHEMA_BYTES),
}).strict()
export type UiArtifactProjectFiles = z.infer<typeof uiArtifactProjectFilesSchema>

export const uiArtifactProjectSummarySchema = z.object({
  protocol: z.literal("openwork.ui-artifact-project-summary"),
  schemaVersion: z.literal(UI_ARTIFACT_PROJECT_SCHEMA_VERSION),
  slug: artifactSlugSchema,
  title: compactTextSchema,
  description: descriptionSchema.optional(),
  enabled: z.boolean(),
  presentation: uiArtifactPresentationV2Schema,
  projectRevision: uiArtifactProjectRevisionSchema,
  updatedAt: isoDateTimeSchema,
  latestBuild: z.object({
    projectRevision: uiArtifactProjectRevisionSchema,
    buildDigest: sha256DigestSchema,
    createdAt: isoDateTimeSchema,
  }).strict().nullable(),
}).strict()
export type UiArtifactProjectSummary = z.infer<typeof uiArtifactProjectSummarySchema>

export const uiArtifactProjectSnapshotSchema = z.object({
  protocol: z.literal("openwork.ui-artifact-project-snapshot"),
  schemaVersion: z.literal(UI_ARTIFACT_PROJECT_SCHEMA_VERSION),
  enabled: z.boolean(),
  manifest: uiArtifactProjectManifestSchema,
  files: uiArtifactProjectFilesSchema,
  data: boundedJsonSchema(UI_ARTIFACT_MAX_DATA_BYTES),
  dataSchema: z.record(z.string(), z.json()).refine(
    (value) => serializedByteLength(value) <= UI_ARTIFACT_MAX_DATA_SCHEMA_BYTES,
    `JSON schema must be at most ${UI_ARTIFACT_MAX_DATA_SCHEMA_BYTES} bytes`,
  ),
  projectRevision: uiArtifactProjectRevisionSchema,
  updatedAt: isoDateTimeSchema,
}).strict()
export type UiArtifactProjectSnapshot = z.infer<typeof uiArtifactProjectSnapshotSchema>

export const uiArtifactProjectFileUpdateSchema = z.object({
  file: uiArtifactProjectFileSchema,
  content: z.string().max(UI_ARTIFACT_MAX_SOURCE_BYTES),
  expectedRevision: uiArtifactProjectRevisionSchema.nullable(),
}).strict()
export type UiArtifactProjectFileUpdate = z.infer<typeof uiArtifactProjectFileUpdateSchema>

export const uiArtifactProjectUpdateSchema = z.object({
  files: uiArtifactProjectFilesSchema,
  expectedRevision: uiArtifactProjectRevisionSchema.nullable(),
}).strict()
export type UiArtifactProjectUpdate = z.infer<typeof uiArtifactProjectUpdateSchema>

export const uiArtifactCompilerDiagnosticSchema = z.object({
  category: z.enum(["error", "warning"]),
  code: z.number().int().nonnegative(),
  message: z.string().trim().min(1).max(2_000),
  line: z.number().int().positive().optional(),
  column: z.number().int().positive().optional(),
}).strict()
export type UiArtifactCompilerDiagnostic = z.infer<typeof uiArtifactCompilerDiagnosticSchema>

export const uiArtifactBuildSchema = z.object({
  protocol: z.literal("openwork.ui-artifact-build"),
  schemaVersion: z.literal(UI_ARTIFACT_PROJECT_SCHEMA_VERSION),
  slug: artifactSlugSchema,
  projectRevision: uiArtifactProjectRevisionSchema,
  buildDigest: sha256DigestSchema,
  status: z.literal("ready"),
  compiler: z.object({
    name: z.literal("typescript"),
    version: compactTextSchema,
    jsx: z.literal("react"),
    module: z.literal("esnext"),
  }).strict(),
  bundleBytes: z.number().int().nonnegative().max(UI_ARTIFACT_MAX_BUNDLE_BYTES),
  createdAt: isoDateTimeSchema,
}).strict()
export type UiArtifactBuild = z.infer<typeof uiArtifactBuildSchema>

export const uiArtifactBuildRequestSchema = z.object({
  expectedProjectRevision: uiArtifactProjectRevisionSchema.optional(),
}).strict()
export type UiArtifactBuildRequest = z.infer<typeof uiArtifactBuildRequestSchema>

export const uiArtifactPinnedBuildSchema = z.object({
  protocol: z.literal("openwork.ui-artifact-pinned-build"),
  schemaVersion: z.literal(UI_ARTIFACT_PROJECT_SCHEMA_VERSION),
  build: uiArtifactBuildSchema,
  manifest: uiArtifactProjectManifestSchema,
  bundle: z.string().max(UI_ARTIFACT_MAX_BUNDLE_BYTES),
  styles: z.string().max(UI_ARTIFACT_MAX_STYLES_BYTES),
  data: boundedJsonSchema(UI_ARTIFACT_MAX_DATA_BYTES),
  dataSchema: z.record(z.string(), z.json()).refine(
    (value) => serializedByteLength(value) <= UI_ARTIFACT_MAX_DATA_SCHEMA_BYTES,
    `JSON schema must be at most ${UI_ARTIFACT_MAX_DATA_SCHEMA_BYTES} bytes`,
  ),
}).strict()
export type UiArtifactPinnedBuild = z.infer<typeof uiArtifactPinnedBuildSchema>

export const uiArtifactInstanceStateSchema = z.object({
  protocol: z.literal("openwork.ui-artifact-instance-state"),
  schemaVersion: z.literal(UI_ARTIFACT_PROJECT_SCHEMA_VERSION),
  workspaceId: compactTextSchema,
  slug: artifactSlugSchema,
  instanceId: artifactInstanceIdSchema,
  projectRevision: uiArtifactProjectRevisionSchema,
  stateRevision: sha256DigestSchema,
  state: boundedJsonSchema(UI_ARTIFACT_MAX_STATE_BYTES),
  updatedAt: isoDateTimeSchema,
}).strict()
export type UiArtifactInstanceState = z.infer<typeof uiArtifactInstanceStateSchema>

export const uiArtifactStateUpdateSchema = z.object({
  state: boundedJsonSchema(UI_ARTIFACT_MAX_STATE_BYTES),
  expectedRevision: sha256DigestSchema,
}).strict()
export type UiArtifactStateUpdate = z.infer<typeof uiArtifactStateUpdateSchema>

export const uiArtifactAttachmentSchema = z.object({
  protocol: z.literal("openwork.ui-artifact-attachment"),
  schemaVersion: z.literal(UI_ARTIFACT_PROJECT_SCHEMA_VERSION),
  workspaceId: compactTextSchema,
  slug: artifactSlugSchema,
  title: compactTextSchema,
  description: descriptionSchema.optional(),
  projectRevision: uiArtifactProjectRevisionSchema,
  buildDigest: sha256DigestSchema,
  instanceId: artifactInstanceIdSchema,
  presentation: uiArtifactPresentationV2Schema,
  buildPath: z.string().startsWith("/workspace/").max(512),
  stateRevision: sha256DigestSchema,
}).strict()
export type UiArtifactAttachment = z.infer<typeof uiArtifactAttachmentSchema>

export const uiArtifactPublishRequestSchema = z.object({
  instanceId: artifactInstanceIdSchema.optional(),
  initialState: boundedJsonSchema(UI_ARTIFACT_MAX_STATE_BYTES).optional(),
  expectedProjectRevision: uiArtifactProjectRevisionSchema.optional(),
  provenance: z.object({
    createdBy: z.enum(["user", "agent"]),
    agent: compactTextSchema.optional(),
    sessionId: compactTextSchema.optional(),
    messageId: compactTextSchema.optional(),
  }).strict().optional(),
}).strict()
export type UiArtifactPublishRequest = z.infer<typeof uiArtifactPublishRequestSchema>

export const uiArtifactPublishReceiptSchema = z.object({
  protocol: z.literal("openwork.ui-artifact-publish-receipt"),
  schemaVersion: z.literal(UI_ARTIFACT_PROJECT_SCHEMA_VERSION),
  attachment: uiArtifactAttachmentSchema,
  build: uiArtifactBuildSchema,
  publishedAt: isoDateTimeSchema,
}).strict()
export type UiArtifactPublishReceipt = z.infer<typeof uiArtifactPublishReceiptSchema>

export const uiArtifactIntentRequestSchema = z.object({
  intentId: z.string().trim().min(1).max(96),
  payload: z.record(z.string(), z.json()).refine(
    (value) => serializedByteLength(value) <= UI_ARTIFACT_MAX_INTENT_PAYLOAD_BYTES,
    `Intent payload must be at most ${UI_ARTIFACT_MAX_INTENT_PAYLOAD_BYTES} bytes`,
  ),
  expectedStateRevision: sha256DigestSchema.optional(),
}).strict()
export type UiArtifactIntentRequest = z.infer<typeof uiArtifactIntentRequestSchema>

export const uiArtifactIntentResultSchema = z.discriminatedUnion("ok", [
  z.object({
    protocol: z.literal("openwork.ui-artifact-intent-result"),
    schemaVersion: z.literal(UI_ARTIFACT_PROJECT_SCHEMA_VERSION),
    ok: z.literal(true),
    intentId: compactTextSchema,
    requiresConfirmation: z.boolean(),
    effects: openworkAffordanceEffectsSchema.strict(),
    prompt: z.string().trim().min(1).max(UI_ARTIFACT_MAX_INTENT_PROMPT_BYTES),
    stateRevision: sha256DigestSchema,
  }).strict(),
  z.object({
    protocol: z.literal("openwork.ui-artifact-intent-result"),
    schemaVersion: z.literal(UI_ARTIFACT_PROJECT_SCHEMA_VERSION),
    ok: z.literal(false),
    intentId: compactTextSchema,
    code: z.enum(["unknown-intent", "invalid-payload", "state-conflict", "unavailable"]),
    message: z.string().trim().min(1).max(1_000),
    stateRevision: sha256DigestSchema.optional(),
  }).strict(),
])
export type UiArtifactIntentResult = z.infer<typeof uiArtifactIntentResultSchema>

const bridgeBaseSchema = z.object({
  protocol: z.literal("openwork.ui-artifact-bridge"),
  schemaVersion: z.literal(UI_ARTIFACT_PROJECT_SCHEMA_VERSION),
  instanceId: artifactInstanceIdSchema,
  nonce: z.string().trim().min(16).max(128),
  seq: z.number().int().nonnegative(),
})

export const uiArtifactHostBridgeEnvelopeSchema = z.discriminatedUnion("type", [
  bridgeBaseSchema.extend({
    type: z.literal("host.initialize"),
    payload: z.object({
      attachment: uiArtifactAttachmentSchema,
      build: uiArtifactPinnedBuildSchema,
      data: boundedJsonSchema(UI_ARTIFACT_MAX_DATA_BYTES),
      state: uiArtifactInstanceStateSchema,
    }).strict(),
  }).strict(),
  bridgeBaseSchema.extend({
    type: z.literal("host.state"),
    payload: uiArtifactInstanceStateSchema,
  }).strict(),
  bridgeBaseSchema.extend({
    type: z.literal("host.intent-result"),
    payload: uiArtifactIntentResultSchema,
  }).strict(),
])
export type UiArtifactHostBridgeEnvelope = z.infer<typeof uiArtifactHostBridgeEnvelopeSchema>

export const uiArtifactFrameBridgeEnvelopeSchema = z.discriminatedUnion("type", [
  bridgeBaseSchema.extend({
    type: z.literal("artifact.ready"),
    payload: z.object({}).strict(),
  }).strict(),
  bridgeBaseSchema.extend({
    type: z.literal("artifact.state-update"),
    payload: uiArtifactStateUpdateSchema,
  }).strict(),
  bridgeBaseSchema.extend({
    type: z.literal("artifact.intent"),
    payload: uiArtifactIntentRequestSchema,
  }).strict(),
  bridgeBaseSchema.extend({
    type: z.literal("artifact.error"),
    payload: z.object({
      message: z.string().trim().min(1).max(1_000),
    }).strict(),
  }).strict(),
])
export type UiArtifactFrameBridgeEnvelope = z.infer<typeof uiArtifactFrameBridgeEnvelopeSchema>
