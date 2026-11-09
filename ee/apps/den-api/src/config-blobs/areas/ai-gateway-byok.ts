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
import { denTypeIdPrefixes, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { ConfigApplyStep, ConfigFieldChange } from "@openwork/types/den/config-blobs"
import { z } from "zod"
import { sameCustomOrigin } from "../../llm/gateway-custom-provider.js"
import { decodeProviderCredential, readProviderEnvNames } from "../../llm/provider-credentials.js"
import { createLlmProvider, deleteLlmProvider, updateLlmProvider, type LlmProviderWriteInput } from "../../routes/org/llm-providers.js"
import { defineConfigArea, type ConfigApplyOp, type ConfigApplyResult, type ConfigAreaContext, type ConfigItem } from "../area.js"
import {
  ConfigApplyError,
  ConfigStepLog,
  applyWithSteps,
  audienceRefs,
  audienceSteps,
  configRouteContext,
  expectRouteOk,
  idDiff,
  isJsonObject,
  loadMemberEmails,
  loadTeamNames,
  resolvedRefIds,
  opTouched,
  resolvedSecret,
  secretEffects,
  secretIsSet,
  secretPlaceholder,
  specAudienceSchema,
  specObject,
  specSecretSchema,
  stringField,
  touches,
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

/** Where a custom provider sends its key: `api` and `options.baseURL`. */
function providerEndpoints(config: JsonObject): Array<string | null> {
  const options = isJsonObject(config.options) ? config.options : {}
  return [config.api, options.baseURL].map((value) => (typeof value === "string" && value.trim() ? value.trim() : null))
}

/** Whether every endpoint stays on its origin (as `sameCustomOrigin` for Gateway custom providers). */
function sameProviderOrigins(stored: JsonObject, next: JsonObject): boolean {
  const before = providerEndpoints(stored)
  const after = providerEndpoints(next)
  return before.every((value, index) => {
    const other = after[index] ?? null
    if (value === null || other === null) return value === other
    return sameCustomOrigin(value, other)
  })
}

/** Inline credentials a custom config may hold outside the exported allowlist. */
const INLINE_SECRET_OPTION = /key|token|secret|auth|password|header|cookie/i

/** Stored config without inline credentials: kept fields must never follow the provider to another host. */
function withoutInlineSecrets(config: JsonObject): JsonObject {
  const out = omit(config, ["headers"])
  if (isJsonObject(out.options)) {
    out.options = Object.fromEntries(Object.entries(out.options).filter(([key]) => !INLINE_SECRET_OPTION.test(key)))
  }
  return out
}

/** Secret decisions under `credentials` that keep the stored value (or have no decision). */
function keptCredentials(value: unknown): string[] {
  if (!isJsonObject(value)) return []
  if (value.apiKey !== undefined) {
    const secret = resolvedSecret(value.apiKey, "credentials.apiKey")
    return !secret || secret.decision === "keep" ? ["credentials.apiKey"] : []
  }
  if (!isJsonObject(value.apiKeys)) return []
  return Object.entries(value.apiKeys).flatMap(([name, entry]) => {
    const secret = resolvedSecret(entry, `credentials.apiKeys.${name}`)
    return !secret || secret.decision === "keep" ? [`credentials.apiKeys.${name}`] : []
  })
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
  idPrefix: denTypeIdPrefixes.llmProvider,
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

  // The apply's own rule, earlier: a saved key never follows a custom provider to another host.
  async preflight(_ctx, op, info) {
    if (op.kind !== "update" || op.item.spec.source !== "custom" || op.item.spec.credentialMode !== "shared") return null
    const before = isJsonObject(op.previous.spec.provider) ? op.previous.spec.provider : null
    const after = isJsonObject(op.item.spec.provider) ? op.item.spec.provider : null
    if (!before || !after || !touches(op.changes, "provider") || sameProviderOrigins(before, mergeConfig(before, after, PROVIDER_FIELDS, PROVIDER_OPTION_FIELDS))) return null
    const kept = info.secrets.filter((secret) => secret.field.startsWith("credentials.") && secret.decision === "keep").map((secret) => secret.field)
    if (kept.length === 0) return null
    return { block: `"${op.item.name}" moves to another address: enter its API key again for that address (${kept.join(", ")}) instead of keeping the saved one.` }
  },

  irreversible: (op) => {
    if (op.kind === "delete") {
      const out = [`Members' own keys for "${op.previous.name}" are deleted; they enter them again after a restore.`]
      if (op.previous.spec.credentialMode === "shared") out.push(`The stored API key of "${op.previous.name}" is deleted; it must be re-entered to restore it.`)
      return out
    }
    if (op.kind !== "update") return []
    const out: string[] = []
    if (touches(op.changes, "credentialMode")) out.push(`Members' own keys for "${op.previous.name}" are deleted (its credential mode changes).`)
    const previousCredentials = isJsonObject(op.previous.spec.credentials) ? op.previous.spec.credentials : {}
    const credentials = isJsonObject(op.item.spec.credentials) ? op.item.spec.credentials : {}
    if (credentials.apiKey !== undefined) out.push(...secretEffects(credentials.apiKey, `API key of "${op.previous.name}"`, previousCredentials.apiKey))
    if (isJsonObject(credentials.apiKeys)) {
      const previousKeys = isJsonObject(previousCredentials.apiKeys) ? previousCredentials.apiKeys : {}
      for (const [name, value] of Object.entries(credentials.apiKeys)) out.push(...secretEffects(value, `${name} key of "${op.previous.name}"`, previousKeys[name]))
    }
    const before = isJsonObject(op.previous.spec.provider) ? op.previous.spec.provider : null
    const after = isJsonObject(op.item.spec.provider) ? op.item.spec.provider : null
    if (before && after && touches(op.changes, "provider") && !sameProviderOrigins(before, after)) {
      out.push(`"${op.previous.name}" moves to another address: credentials saved inline in its config are removed.`)
    }
    return out
  },

  async exportItems(ctx) {
    return readProviders(ctx, null)
  },

  async readItems(ctx, ids) {
    return readProviders(ctx, ids)
  },

  async apply(ctx, op): Promise<ConfigApplyResult> {
    return applyWithSteps((log) => applyProvider(ctx, op, log))
  },
})

async function applyProvider(ctx: ConfigAreaContext, op: ConfigApplyOp, log: ConfigStepLog): Promise<Omit<ConfigApplyResult, "steps">> {
  const { c, payload } = await configRouteContext(ctx)

  if (op.kind === "delete") {
    const response = await deleteLlmProvider(c, payload, op.targetId)
    if (response.status === 404) return { localId: op.targetId, warnings: ["The provider was already removed."] }
    await log.run({ action: "delete", target: "provider", detail: op.previous.name }, () => expectRouteOk(response, `Remove "${op.previous.name}"`))
    return { localId: op.targetId }
  }

  const raw = specObject(op.item.spec)
  const parsed = applySpecSchema.safeParse(raw)
  if (!parsed.success) throw new ConfigApplyError("invalid_spec", parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "))
  const spec = parsed.data
  const access = isJsonObject(raw.access) ? raw.access : {}
  const warnings: string[] = []

  let stored: { providerConfig: JsonObject; models: Map<string, JsonObject> } | null = null
  let storedAccess: Array<typeof LlmProviderAccessTable.$inferSelect> = []
  let modelsCleaned = false
  if (op.kind === "update") {
    const providerId = normalizeDenTypeId("llmProvider", op.targetId)
    const [row] = await ctx.db.select().from(LlmProviderTable).where(and(eq(LlmProviderTable.id, providerId), eq(LlmProviderTable.organizationId, payload.organization.id))).limit(1)
    if (!row) throw new ConfigApplyError("llm_provider_not_found", `The provider "${op.previous.name}" no longer exists.`, 404)
    const modelRows = await ctx.db.select().from(LlmProviderModelTable).where(eq(LlmProviderModelTable.llmProviderId, row.id))
    stored = { providerConfig: row.providerConfig ?? {}, models: new Map(modelRows.map((model) => [model.modelId, model.modelConfig ?? {}])) }
    storedAccess = await ctx.db.select().from(LlmProviderAccessTable).where(eq(LlmProviderAccessTable.llmProviderId, row.id))
    if ((op.item.key ?? null) !== (row.externalKey ?? null) && touches(op.changes, "key")) warnings.push("A provider's key can't change; the existing key was kept.")
  }

  // A custom provider moving to another host: its saved key (and inline credentials) must not follow it there.
  if (stored && spec.source === "custom" && !sameProviderOrigins(stored.providerConfig, mergeConfig(stored.providerConfig, spec.provider ?? {}, PROVIDER_FIELDS, PROVIDER_OPTION_FIELDS))) {
    const kept = spec.credentialMode === "shared" ? keptCredentials(raw.credentials) : []
    if (kept.length > 0) {
      throw new ConfigApplyError("needs_input", `"${op.item.name}" moves to another address; enter its API key again for that address (${kept.join(", ")}) instead of keeping the saved one.`)
    }
    const cleaned = {
      providerConfig: withoutInlineSecrets(stored.providerConfig),
      models: new Map([...stored.models].map(([id, config]) => [id, withoutInlineSecrets(config)])),
    }
    const dropped = JSON.stringify(cleaned.providerConfig) !== JSON.stringify(stored.providerConfig)
      || [...stored.models].some(([id, config]) => JSON.stringify(cleaned.models.get(id)) !== JSON.stringify(config))
    if (dropped) warnings.push("The provider moved to another address: inline credentials saved in its config were removed.")
    // Cleaned model configs must be written even when the plan changes no model.
    modelsCleaned = [...stored.models].some(([id, config]) => JSON.stringify(cleaned.models.get(id)) !== JSON.stringify(config))
    stored = cleaned
  }

  const credentials = spec.credentialMode === "shared" ? credentialWrite(raw.credentials) : {}
  const keyEntered = Boolean(credentials.apiKey) || Object.values(credentials.apiKeys ?? {}).some(Boolean)
  if (op.kind === "create" && spec.credentialMode === "shared" && !keyEntered) {
    warnings.push("Created without its shared key: someone must enter it before the provider works.")
  }

  const memberIds = resolvedRefIds(access.members, "access.members").map((id) => normalizeDenTypeId("member", id))
  const teamIds = resolvedRefIds(access.teams, "access.teams").map((id) => normalizeDenTypeId("team", id))
  const input: LlmProviderWriteInput = {
    name: op.item.name,
    source: spec.source,
    credentialMode: spec.credentialMode,
    memberIds,
    teamIds,
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
    const localId = await log.run({ action: "create", target: "provider", detail: op.item.name }, async () => {
      const created = await expectRouteOk(await createLlmProvider(
        c, payload, input, op.item.key ?? undefined,
        op.preferredId ? normalizeDenTypeId("llmProvider", op.preferredId) : undefined,
      ), `Create "${op.item.name}"`)
      return stringField(created, "llmProvider", "id")
    })
    return { localId, warnings }
  }

  // Update: updateLlmProvider replaces the provider row (one row, written when anything in the
  // item changes); its models and access are written only when the plan changes them, as a diff.
  const touched = opTouched(op)
  const writeModels = touches(touched, "models") || modelsCleaned
  const writeAccess = touches(touched, "access")
  const steps: ConfigApplyStep[] = [
    ...(touches(touched, "name") ? [{ action: "set" as const, target: "name", detail: op.item.name }] : []),
    ...(touches(touched, "source") || touches(touched, "providerId") ? [{ action: "set" as const, target: "providerId", detail: `${spec.source}/${spec.providerId}` }] : []),
    ...(touches(touched, "provider") ? [{ action: "update" as const, target: "provider", detail: changedPaths(touched, "provider") }] : []),
    ...(touches(touched, "credentialMode") ? [{ action: "set" as const, target: "credentialMode", detail: spec.credentialMode }] : []),
    ...(spec.credentialMode === "shared" ? credentialSteps(raw.credentials, op.previous.spec.credentials) : []),
    ...(writeModels ? modelSteps(op.previous.spec.models, spec.models) : []),
    ...(modelsCleaned ? [{ action: "update" as const, target: "models", detail: "inline credentials removed" }] : []),
    ...(writeAccess ? await accessSteps(ctx, storedAccess, { allMembers: spec.access.allMembers, memberIds, teamIds }) : []),
  ]
  const [first, ...rest] = steps
  // Nothing this adapter writes changed (e.g. only the key, which never changes).
  if (!first) return { localId: op.targetId, warnings }
  await log.run(first, async () => {
    await expectRouteOk(await updateLlmProvider(c, payload, op.targetId, input, { models: writeModels, access: writeAccess }), `Update "${op.item.name}"`)
  })
  log.add(...rest)
  return { localId: op.targetId, warnings }
}

/** "options.baseURL, api" under `prefix`. */
function changedPaths(changes: readonly ConfigFieldChange[], prefix: string): string | undefined {
  const paths = [...new Set(changes.filter((change) => change.path.startsWith(`${prefix}.`)).map((change) => change.path.slice(prefix.length + 1)))]
  return paths.length > 0 ? paths.join(", ") : undefined
}

/** One step per key written: a new value, or a stored key cleared ("unset" of a key not stored writes nothing). */
function credentialSteps(value: unknown, previous: unknown): ConfigApplyStep[] {
  const write = credentialWrite(value)
  const before = isJsonObject(previous) ? previous : {}
  const beforeKeys = isJsonObject(before.apiKeys) ? before.apiKeys : {}
  if (write.apiKey !== undefined) return write.apiKey || secretIsSet(before.apiKey) ? [{ action: write.apiKey ? "set" : "delete", target: "credentials.apiKey" }] : []
  return Object.entries(write.apiKeys ?? {})
    .filter(([name, key]) => key || secretIsSet(beforeKeys[name]))
    .map(([name, key]): ConfigApplyStep => ({ action: key ? "set" : "delete", target: `credentials.apiKeys.${name}` }))
}

function modelIdsOf(value: unknown): Map<string, string> {
  const out = new Map<string, string>()
  if (!Array.isArray(value)) return out
  for (const model of value) if (isJsonObject(model) && typeof model.id === "string") out.set(model.id, JSON.stringify(model))
  return out
}

/** One step per model added, removed or changed. */
function modelSteps(previous: unknown, next: Array<{ id: string }>): ConfigApplyStep[] {
  const before = modelIdsOf(previous)
  const after = modelIdsOf(next)
  return [
    ...[...after.keys()].filter((id) => !before.has(id)).map((id): ConfigApplyStep => ({ action: "add", target: `models[${id}]` })),
    ...[...before.keys()].filter((id) => !after.has(id)).map((id): ConfigApplyStep => ({ action: "remove", target: `models[${id}]` })),
    ...[...after.entries()].filter(([id, json]) => before.has(id) && before.get(id) !== json).map(([id]): ConfigApplyStep => ({ action: "update", target: `models[${id}]` })),
  ]
}

async function accessSteps(ctx: ConfigAreaContext, stored: Array<typeof LlmProviderAccessTable.$inferSelect>, next: { allMembers: boolean; memberIds: string[]; teamIds: string[] }): Promise<ConfigApplyStep[]> {
  const allMembersNow = stored.some((row) => !row.orgMembershipId && !row.teamId)
  return [
    ...(allMembersNow !== next.allMembers ? [{ action: "set" as const, target: "access.allMembers", detail: String(next.allMembers) }] : []),
    ...await audienceSteps(ctx.db, ctx.organizationId, "access", {
      teams: idDiff(stored.flatMap((row) => row.teamId ? [row.teamId] : []), next.allMembers ? [] : next.teamIds),
      members: idDiff(stored.flatMap((row) => row.orgMembershipId ? [row.orgMembershipId] : []), next.memberIds),
    }),
  ]
}

async function readProviders(ctx: ConfigAreaContext, ids: readonly string[] | null): Promise<ConfigItem[]> {
  const organizationId = normalizeDenTypeId("organization", ctx.organizationId)
  const providerIds = ids?.flatMap((id) => {
    try {
      return [normalizeDenTypeId("llmProvider", id)]
    } catch {
      return []
    }
  }) ?? null
  if (providerIds && providerIds.length === 0) return []
  const rows = await ctx.db
    .select()
    .from(LlmProviderTable)
    .where(and(eq(LlmProviderTable.organizationId, organizationId), ne(LlmProviderTable.source, "openwork"), providerIds ? inArray(LlmProviderTable.id, providerIds) : undefined))
  if (rows.length === 0) return []
  const rowIds = rows.map((row) => row.id)
  const [models, access] = await Promise.all([
    ctx.db.select().from(LlmProviderModelTable).where(inArray(LlmProviderModelTable.llmProviderId, rowIds)),
    ctx.db.select().from(LlmProviderAccessTable).where(inArray(LlmProviderAccessTable.llmProviderId, rowIds)),
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
}
