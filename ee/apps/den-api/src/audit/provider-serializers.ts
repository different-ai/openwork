import { AuditLogError, canonicalAuditJson, type AuditEventInput } from "@openwork-ee/den-db/audit-log"
import type { GatewayCredentialSetTable, GatewayModelGroupTable, GatewayProviderAccessTable, GatewayProviderCredentialTable, GatewayProviderModelTable, GatewayProviderTable } from "@openwork-ee/den-db/schema"

export const MAX_PROVIDER_SNAPSHOT_BYTES = 96 * 1024
export type ProviderAuditResource = {
  type: string
  id: string
  action: string
  snapshot: Record<string, unknown>
  related: AuditEventInput["resources"]
  materialRevision?: string
  configurationRevision?: string
}
export type ProviderAuditSnapshot = Map<string, ProviderAuditResource>

function invalid(): never { throw new AuditLogError("audit_invalid_input") }
function field(input: unknown, key: string): unknown {
  if (input === undefined || input === null) return undefined
  if (typeof input !== "object" || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) return invalid()
  const property = Object.getOwnPropertyDescriptor(input, key)
  if (!property) return undefined
  if (!("value" in property)) return invalid()
  return property.value
}
function boundedText(value: unknown, max: number): string {
  if (typeof value !== "string") return invalid()
  if (Buffer.byteLength(value, "utf8") > max) throw new AuditLogError("audit_evidence_too_large")
  if (/\b(?:Bearer|Basic)\s|-----BEGIN [A-Z ]*PRIVATE KEY-----|enc:v1:|\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|AIza[A-Za-z0-9_-]{25,})/i.test(value)) return invalid()
  canonicalAuditJson(value, true)
  return value
}
function text(value: unknown, max = 255): string {
  const result = boundedText(value, max)
  if (/[\u0000-\u001f\u007f]/.test(result)) return invalid()
  return result
}
function multilineText(value: unknown, max: number): string {
  const result = boundedText(value, max)
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(result)) return invalid()
  return result
}
function url(value: unknown) {
  const source = text(value, 2048)
  let parsed: URL
  try { parsed = new URL(source) } catch { return invalid() }
  if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) return invalid()
  return source
}
function strings(values: readonly string[]) { return [...new Set(values.map((value) => text(value)))].sort() }
function pickStrings(input: unknown, keys: string[], maximum = 255) {
  const result: Record<string, unknown> = {}
  for (const key of keys) {
    const value = field(input, key)
    if (value !== undefined) result[key] = text(value, maximum)
  }
  return result
}
function pickNumbers(input: unknown, keys: string[]) {
  const result: Record<string, unknown> = {}
  for (const key of keys) {
    const value = field(input, key)
    if (value === undefined) continue
    if (typeof value !== "number" || !Number.isFinite(value)) return invalid()
    result[key] = value
  }
  return result
}
function snapshot(value: Record<string, unknown>) {
  if (Buffer.byteLength(canonicalAuditJson(value, true), "utf8") > MAX_PROVIDER_SNAPSHOT_BYTES) throw new AuditLogError("audit_evidence_too_large")
  return value
}

export function serializeProvider(row: typeof GatewayProviderTable.$inferSelect) {
  const config = pickStrings(row.provider_config, ["id", "name", "npm"])
  const api = field(row.provider_config, "api")
  if (api !== undefined) config.api = url(api)
  const baseURL = field(field(row.provider_config, "options"), "baseURL")
  if (baseURL !== undefined) config.baseURL = url(baseURL)
  const settings = pickStrings(row.settings, ["project", "location", "resourceName", "apiVersion", "region"])
  const upstream = field(row.settings, "upstreamBaseUrl")
  if (upstream !== undefined) settings.upstreamBaseUrl = url(upstream)
  return snapshot({ id: row.id, catalogProviderId: text(row.provider_id), name: text(row.name, 1020), status: row.status, createdByMemberId: row.created_by_org_membership_id, config, settings })
}
export function serializeProviderUniverse(row: typeof GatewayProviderTable.$inferSelect) {
  return snapshot({ id: row.id, mode: row.model_ids.length ? "selected" : "all_supported", modelIds: strings(row.model_ids) })
}
export function serializeProviderModel(row: typeof GatewayProviderModelTable.$inferSelect) {
  const config = pickStrings(row.model_config, ["id", "name", "npm", "family", "release_date", "last_updated", "knowledge", "status"], 1020)
  for (const key of ["attachment", "reasoning", "tool_call", "temperature", "open_weights"]) {
    const value = field(row.model_config, key)
    if (value === undefined) continue
    if (typeof value !== "boolean") return invalid()
    config[key] = value
  }
  for (const [key, fields] of [["limit", ["context", "input", "output"]], ["cost", ["input", "output", "cache_read", "cache_write"]]] satisfies Array<[string, string[]]>) {
    const value = field(row.model_config, key)
    if (value !== undefined) config[key] = pickNumbers(value, fields)
  }
  const provider = field(row.model_config, "provider")
  if (provider !== undefined) {
    const selected = pickStrings(provider, ["id", "npm"])
    const api = field(provider, "api")
    if (api !== undefined) selected.api = url(api)
    config.provider = selected
  }
  const baseURL = field(field(row.model_config, "options"), "baseURL")
  if (baseURL !== undefined) config.baseURL = url(baseURL)
  const modalities = field(row.model_config, "modalities")
  if (modalities !== undefined) {
    const selected: Record<string, unknown> = {}
    for (const key of ["input", "output"]) {
      const value = field(modalities, key)
      if (value === undefined) continue
      if (!Array.isArray(value) || !value.every((item): item is string => typeof item === "string" && ["text", "image", "audio", "video", "pdf"].includes(item))) return invalid()
      selected[key] = strings(value)
    }
    config.modalities = selected
  }
  return snapshot({ id: row.id, upstreamModelId: text(row.model_id), name: text(row.name, 1020), config })
}
export function serializeProviderGroup(row: typeof GatewayModelGroupTable.$inferSelect, modelRowIds: string[]) {
  return snapshot({ id: row.id, name: text(row.name, 1020), description: row.description === null ? null : multilineText(row.description, 40_000), status: row.status, providerModelIds: strings(modelRowIds) })
}
export function serializeProviderSet(row: typeof GatewayCredentialSetTable.$inferSelect) {
  return snapshot({ id: row.id, name: text(row.name, 1020), credentialMode: row.credential_mode, status: row.status, createdByMemberId: row.created_by_org_membership_id, oauthClientId: row.oauth_client_id === null ? null : text(row.oauth_client_id, 1020), oauthClientConfigured: Boolean(row.oauth_client_id && row.oauth_client_secret) })
}
export function serializeProviderCredential(row: typeof GatewayProviderCredentialTable.$inferSelect) {
  return snapshot({ id: row.id, credentialSetId: row.credential_set_id, memberId: row.org_membership_id, subjectType: row.org_membership_id ? "member" : "organization", kind: row.kind, status: row.status, expiresAt: row.expires_at?.toISOString() ?? null })
}
export function serializeProviderGrant(row: typeof GatewayProviderAccessTable.$inferSelect) {
  return snapshot({ id: row.id, modelGroupId: row.model_group_id, credentialSetId: row.credential_set_id, audienceType: row.org_membership_id ? "member" : row.team_id ? "team" : "organization", memberId: row.org_membership_id, teamId: row.team_id })
}

export function diffProviderSnapshots(providerId: string, before: ProviderAuditSnapshot, after: ProviderAuditSnapshot): AuditEventInput[] {
  const events: AuditEventInput[] = []
  for (const key of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const previous = before.get(key)
    const next = after.get(key)
    const resource = next ?? previous
    if (!resource) continue
    const left = previous?.snapshot ?? null
    const right = next?.snapshot ?? null
    const changedFields = [...new Set([...Object.keys(left ?? {}), ...Object.keys(right ?? {})])]
      .filter((field) => canonicalAuditJson(left?.[field] ?? null) !== canonicalAuditJson(right?.[field] ?? null)).sort()
    if (previous && next && previous.materialRevision !== next.materialRevision) changedFields.push("credentialMaterial")
    if (previous && next && previous.configurationRevision !== next.configurationRevision && !changedFields.includes("config")) changedFields.push("configuration")
    if (previous && next && !changedFields.length) continue
    const resources: AuditEventInput["resources"] = [{ type: resource.type, id: resource.id, relationship: "target" }]
    if (resource.type !== "provider") resources.push({ type: "provider", id: providerId, relationship: "parent" })
    for (const related of [...(previous?.related ?? []), ...(next?.related ?? [])]) {
      if (!resources.some((entry) => entry.type === related.type && entry.id === related.id && entry.relationship === related.relationship)) resources.push(related)
    }
    if (resources.length > 256) throw new AuditLogError("audit_evidence_too_large")
    const event: AuditEventInput = { action: `${resource.action}.${!previous ? "created" : !next ? "deleted" : "updated"}`, category: "change", outcome: "succeeded", resources, changes: { before: left, after: right, changedFields } }
    canonicalAuditJson(event, true)
    events.push(event)
  }
  return events
}
