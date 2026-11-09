/**
 * `ai-gateway.byok`: Bring-your-own-key (legacy custom) LLM providers, their
 * models and who can use them.
 *
 * Exported per provider: source (models.dev catalog or custom), provider id,
 * credential mode, models (keyed by model id), access (everyone, teams, people
 * by email) and, for custom providers, the provider config through an
 * allowlist: `id, name, npm, env, doc, api` plus a few named `options` and
 * model fields. Custom configs keep arbitrary fields and can hold inline
 * credentials (`options.apiKey`, `headers`…), so anything outside the
 * allowlist is never exported; an update keeps those stored fields as they are.
 *
 * The shared credential becomes placeholders: `credentials.apiKey` for a
 * provider with one env key, or `credentials.apiKeys.<ENV>` per env key for
 * multi-key providers (Bedrock…). Per-member credentials are never exported.
 * Managed OpenWork providers (`source = openwork`) are not part of this area.
 *
 * Applies through the same handlers as POST/PATCH/DELETE /v1/llm-providers
 * (`createLlmProvider`, `updateLlmProvider`, `deleteLlmProvider`). Catalog
 * providers read the models.dev catalog.
 */
import { and, eq, inArray, ne } from "@openwork-ee/den-db/drizzle"
import { LlmProviderAccessTable, LlmProviderModelTable, LlmProviderTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { z } from "zod"
import { decodeProviderCredential, readProviderEnvNames } from "../../llm/provider-credentials.js"
import { createLlmProvider, deleteLlmProvider, updateLlmProvider, type LlmProviderWriteInput } from "../../routes/org/llm-providers.js"
import { defineConfigArea, type ConfigApplyResult, type ConfigItem } from "../area.js"
import {
  ConfigApplyError,
  audienceRefs,
  configRouteContext,
  expectRouteOk,
  isJsonObject,
  loadMemberEmails,
  loadTeamNames,
  resolvedRefIds,
  resolvedSecret,
  secretPlaceholder,
  specAudienceSchema,
  specObject,
  specSecretSchema,
  stringField,
  type JsonObject,
} from "./route-support.js"

const AREA = "ai-gateway.byok"

/** Custom provider config fields that are exported (and replaced on update). Everything else stays as stored. */
const PROVIDER_FIELDS = ["id", "name", "npm", "env", "doc", "api", "options"] as const
const PROVIDER_OPTION_FIELDS = ["baseURL", "resourceName", "apiVersion", "region", "project", "location", "useDeploymentBasedUrls"] as const
const MODEL_FIELDS = [
  "family", "release_date", "attachment", "reasoning", "temperature", "tool_call", "interleaved", "knowledge",
  "modalities", "limit", "cost", "status", "experimental", "open_weights", "options",
] as const
const MODEL_OPTION_FIELDS = ["reasoningEffort", "reasoningSummary", "textVerbosity", "thinking", "include", "store", "parallelToolCalls"] as const

const jsonValueSchema: z.ZodType<unknown> = z.lazy(() => z.union([
  z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema),
]))

const providerOptionsSchema = z.object(Object.fromEntries(PROVIDER_OPTION_FIELDS.map((field) => [field, jsonValueSchema.optional()]))).strict()
const modelOptionsSchema = z.object(Object.fromEntries(MODEL_OPTION_FIELDS.map((field) => [field, jsonValueSchema.optional()]))).strict()

const providerConfigSchema = z.object({
  id: z.string().trim().min(1).max(255),
  name: z.string().trim().min(1).max(255),
  npm: z.string().trim().min(1).max(255),
  env: z.array(z.string().trim().min(1).max(255)).min(1),
  doc: z.string().trim().min(1).max(2048).optional(),
  api: z.string().trim().min(1).max(2048).optional(),
  options: providerOptionsSchema.optional(),
}).strict()

const modelConfigSchema = z.object({
  ...Object.fromEntries(MODEL_FIELDS.filter((field) => field !== "options").map((field) => [field, jsonValueSchema.optional()])),
  options: modelOptionsSchema.optional(),
}).strict()

const specSchema = z.object({
  source: z.enum(["models_dev", "custom"]),
  /** models.dev provider id, or the custom provider's own id. */
  providerId: z.string().trim().min(1).max(255),
  credentialMode: z.enum(["shared", "per_member"]),
  /** Custom providers only (null for catalog providers). */
  provider: providerConfigSchema.nullable(),
  models: z.array(z.object({
    /** The model id (stable per provider). */
    id: z.string().trim().min(1).max(255),
    name: z.string().trim().min(1).max(255).optional(),
    config: modelConfigSchema.optional(),
  }).strict()).min(1),
  access: specAudienceSchema.extend({ allMembers: z.boolean() }).strict(),
  /** Shared credential (null for per-member providers). */
  credentials: z.union([
    z.object({ apiKey: specSecretSchema }).strict(),
    z.object({ apiKeys: z.record(z.string().min(1).max(255), specSecretSchema) }).strict(),
  ]).nullable(),
}).strict()

function pick(source: JsonObject, fields: readonly string[]): JsonObject {
  const out: JsonObject = {}
  for (const field of fields) if (source[field] !== undefined) out[field] = source[field]
  return out
}

function omit(source: JsonObject, fields: readonly string[]): JsonObject {
  const out: JsonObject = { ...source }
  for (const field of fields) delete out[field]
  return out
}

function exportProviderConfig(config: JsonObject): JsonObject {
  const out = pick(config, PROVIDER_FIELDS.filter((field) => field !== "options"))
  const options = isJsonObject(config.options) ? pick(config.options, PROVIDER_OPTION_FIELDS) : {}
  if (Object.keys(options).length > 0) out.options = options
  return out
}

function exportModelConfig(config: JsonObject): JsonObject {
  const out = pick(config, MODEL_FIELDS.filter((field) => field !== "options"))
  const options = isJsonObject(config.options) ? pick(config.options, MODEL_OPTION_FIELDS) : {}
  if (Object.keys(options).length > 0) out.options = options
  return out
}

/** Stored config with the exported fields replaced by the blob's: unexported fields (possibly secret) are kept. */
function mergeConfig(stored: JsonObject | null, written: JsonObject, fields: readonly string[], optionFields: readonly string[]): JsonObject {
  const base = omit(stored ?? {}, fields.filter((field) => field !== "options"))
  const storedOptions = isJsonObject(base.options) ? omit(base.options, optionFields) : {}
  const writtenOptions = isJsonObject(written.options) ? pick(written.options, optionFields) : {}
  const options = { ...storedOptions, ...writtenOptions }
  const out: JsonObject = { ...base, ...omit(written, ["options"]) }
  if (Object.keys(options).length > 0) out.options = options
  else delete out.options
  return out
}

function credentialsSpec(row: typeof LlmProviderTable.$inferSelect) {
  if (row.credentialMode !== "shared") return null
  const envNames = readProviderEnvNames(row.providerConfig ?? {})
  const decoded = decodeProviderCredential(row.apiKey)
  if (envNames.length <= 1) {
    return { apiKey: secretPlaceholder(AREA, row.id, "credentials.apiKey", Boolean(decoded.apiKey || (decoded.apiKeys && Object.keys(decoded.apiKeys).length > 0))) }
  }
  const apiKeys: JsonObject = {}
  for (const name of envNames) {
    const set = Boolean(decoded.apiKeys?.[name]) || (!decoded.apiKeys && Boolean(decoded.apiKey) && name === envNames[0])
    apiKeys[name] = secretPlaceholder(AREA, row.id, `credentials.apiKeys.${name}`, set)
  }
  return { apiKeys }
}

/** apiKey / apiKeys for the write body. Omitted ones keep the stored value; "" clears it. */
function credentialWrite(value: unknown): { apiKey?: string; apiKeys?: Record<string, string> } {
  if (!isJsonObject(value)) return {}
  if (value.apiKey !== undefined) {
    const secret = resolvedSecret(value.apiKey, "credentials.apiKey")
    if (!secret || secret.decision === "keep") return {}
    return { apiKey: secret.decision === "value" ? secret.value : "" }
  }
  if (!isJsonObject(value.apiKeys)) return {}
  const apiKeys: Record<string, string> = {}
  for (const [name, entry] of Object.entries(value.apiKeys)) {
    const secret = resolvedSecret(entry, `credentials.apiKeys.${name}`)
    if (!secret || secret.decision === "keep") continue
    apiKeys[name] = secret.decision === "value" ? secret.value : ""
  }
  return Object.keys(apiKeys).length > 0 ? { apiKeys } : {}
}

const applySpecSchema = z.object({
  source: z.enum(["models_dev", "custom"]),
  providerId: z.string(),
  credentialMode: z.enum(["shared", "per_member"]),
  provider: z.record(z.string(), z.unknown()).nullable(),
  models: z.array(z.object({ id: z.string(), name: z.string().optional(), config: z.record(z.string(), z.unknown()).optional() })),
  access: z.object({ allMembers: z.boolean() }).passthrough(),
}).passthrough()

export const aiGatewayByokArea = defineConfigArea({
  key: AREA,
  label: "Bring your own keys",
  path: ["AI Gateway", "Bring your own keys"],
  specVersion: 1,
  specSchema,
  dependsOn: ["members.teams", "members.people"],
  deployments: ["cloud", "self_hosted"],
  viewPermission: "llm_providers.view",
  managePermission: "llm_providers.update",
  tables: ["llm_provider", "llm_provider_model", "llm_provider_access"],
  naturalKeys: [],
  similarity: (blob, target) => {
    const reasons: string[] = []
    let score = 0
    if (blob.spec.providerId === target.spec.providerId) { score += 0.5; reasons.push("same provider id") }
    const blobApi = isJsonObject(blob.spec.provider) ? blob.spec.provider.api : undefined
    const targetApi = isJsonObject(target.spec.provider) ? target.spec.provider.api : undefined
    if (typeof blobApi === "string" && blobApi === targetApi) { score += 0.3; reasons.push("same endpoint") }
    if (blob.name.trim().toLowerCase() === target.name.trim().toLowerCase()) { score += 0.2; reasons.push("same name") }
    return { score, reasons }
  },
  secretFields: ["credentials.apiKey", "credentials.apiKeys.*"],
  arrayKeys: { models: "id" },
  transactional: false,
  externalEffects: false,

  async exportItems(ctx) {
    const organizationId = normalizeDenTypeId("organization", ctx.organizationId)
    const rows = await ctx.db
      .select()
      .from(LlmProviderTable)
      .where(and(eq(LlmProviderTable.organizationId, organizationId), ne(LlmProviderTable.source, "openwork")))
    if (rows.length === 0) return []
    const ids = rows.map((row) => row.id)
    const [models, access] = await Promise.all([
      ctx.db.select().from(LlmProviderModelTable).where(inArray(LlmProviderModelTable.llmProviderId, ids)),
      ctx.db.select().from(LlmProviderAccessTable).where(inArray(LlmProviderAccessTable.llmProviderId, ids)),
    ])
    const [teamNames, memberEmails] = await Promise.all([
      loadTeamNames(ctx.db, organizationId, access.flatMap((row) => row.teamId ? [row.teamId] : [])),
      loadMemberEmails(ctx.db, organizationId, access.flatMap((row) => row.orgMembershipId ? [row.orgMembershipId] : [])),
    ])

    const items: ConfigItem[] = rows.map((row) => {
      const custom = row.source === "custom"
      const rowAccess = access.filter((entry) => entry.llmProviderId === row.id)
      const rowModels = models
        .filter((model) => model.llmProviderId === row.id)
        .sort((left, right) => left.modelId.localeCompare(right.modelId))
        .map((model) => custom
          ? { id: model.modelId, name: model.name, config: exportModelConfig(omit(model.modelConfig ?? {}, ["id", "name"])) }
          : { id: model.modelId })
      return {
        id: row.id,
        key: row.externalKey,
        name: row.name,
        spec: {
          source: row.source,
          providerId: row.providerId,
          credentialMode: row.credentialMode,
          provider: custom ? exportProviderConfig(row.providerConfig ?? {}) : null,
          models: rowModels,
          access: {
            allMembers: rowAccess.some((entry) => !entry.orgMembershipId && !entry.teamId),
            ...audienceRefs({
              teamIds: rowAccess.flatMap((entry) => entry.teamId ? [entry.teamId] : []),
              memberIds: rowAccess.flatMap((entry) => entry.orgMembershipId ? [entry.orgMembershipId] : []),
              teamNames,
              memberEmails,
            }),
          },
          credentials: credentialsSpec(row),
        },
      }
    })
    return items.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
  },

  async apply(ctx, op): Promise<ConfigApplyResult> {
    const { c, payload } = await configRouteContext(ctx)

    if (op.kind === "delete") {
      const response = await deleteLlmProvider(c, payload, op.targetId)
      if (response.status === 404) return { localId: op.targetId, warnings: ["The provider was already removed."] }
      await expectRouteOk(response, `Remove "${op.previous.name}"`)
      return { localId: op.targetId }
    }

    const raw = specObject(op.item.spec)
    const parsed = applySpecSchema.safeParse(raw)
    if (!parsed.success) throw new ConfigApplyError("invalid_spec", parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "))
    const spec = parsed.data
    const access = isJsonObject(raw.access) ? raw.access : {}
    const warnings: string[] = []

    let stored: { providerConfig: JsonObject; models: Map<string, JsonObject> } | null = null
    if (op.kind === "update") {
      const providerId = normalizeDenTypeId("llmProvider", op.targetId)
      const [row] = await ctx.db.select().from(LlmProviderTable).where(and(eq(LlmProviderTable.id, providerId), eq(LlmProviderTable.organizationId, payload.organization.id))).limit(1)
      if (!row) throw new ConfigApplyError("llm_provider_not_found", `The provider "${op.previous.name}" no longer exists.`, 404)
      const modelRows = await ctx.db.select().from(LlmProviderModelTable).where(eq(LlmProviderModelTable.llmProviderId, row.id))
      stored = { providerConfig: row.providerConfig ?? {}, models: new Map(modelRows.map((model) => [model.modelId, model.modelConfig ?? {}])) }
      if ((op.item.key ?? null) !== (row.externalKey ?? null)) warnings.push("A provider's key can't change; the existing key was kept.")
    }

    const credentials = spec.credentialMode === "shared" ? credentialWrite(raw.credentials) : {}
    const keyEntered = Boolean(credentials.apiKey) || Object.values(credentials.apiKeys ?? {}).some(Boolean)
    if (op.kind === "create" && spec.credentialMode === "shared" && !keyEntered) {
      warnings.push("Created without its shared key: someone must enter it before the provider works.")
    }

    const input: LlmProviderWriteInput = {
      name: op.item.name,
      source: spec.source,
      credentialMode: spec.credentialMode,
      memberIds: resolvedRefIds(access.members, "access.members").map((id) => normalizeDenTypeId("member", id)),
      teamIds: resolvedRefIds(access.teams, "access.teams").map((id) => normalizeDenTypeId("team", id)),
      allMembers: spec.access.allMembers,
      ...credentials,
      ...(spec.source === "models_dev"
        ? { providerId: spec.providerId, modelIds: spec.models.map((model) => model.id) }
        : {
            customConfig: {
              ...mergeConfig(stored?.providerConfig ?? null, spec.provider ?? {}, PROVIDER_FIELDS, PROVIDER_OPTION_FIELDS),
              models: spec.models.map((model) => ({
                ...mergeConfig(stored?.models.get(model.id) ?? null, model.config ?? {}, MODEL_FIELDS, MODEL_OPTION_FIELDS),
                id: model.id,
                name: model.name ?? model.id,
              })),
            },
          }),
    }

    if (op.kind === "create") {
      const created = await expectRouteOk(await createLlmProvider(
        c, payload, input, op.item.key ?? undefined,
        op.preferredId ? normalizeDenTypeId("llmProvider", op.preferredId) : undefined,
      ), `Create "${op.item.name}"`)
      return { localId: stringField(created, "llmProvider", "id"), ...(warnings.length > 0 ? { warnings } : {}) }
    }
    await expectRouteOk(await updateLlmProvider(c, payload, op.targetId, input), `Update "${op.item.name}"`)
    return { localId: op.targetId, ...(warnings.length > 0 ? { warnings } : {}) }
  },
})
