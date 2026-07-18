/**
 * [INPUT]: 依赖 Entra tenant 配置、Provider extra 元数据与端点模板
 * [OUTPUT]: 对外提供 tenant 规范化、读取与 OAuth URL 模板替换
 * [POS]: capability-sources 的多租户 OAuth 小型策略模块，被 Microsoft Provider 配置复用
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
const ENTRA_TENANT_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ENTRA_VERIFIED_DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i
const RESERVED_ENTRA_AUTHORITIES = new Set(["common", "organizations", "consumers"])

export function normalizeEntraTenantId(value: unknown): string | null {
  if (typeof value !== "string") return null
  const normalized = value.trim().toLowerCase()
  if (!normalized) return null
  if (RESERVED_ENTRA_AUTHORITIES.has(normalized)) return null
  if (ENTRA_TENANT_GUID.test(normalized) || ENTRA_VERIFIED_DOMAIN.test(normalized)) {
    return normalized
  }
  return null
}

export function readProviderTenantId(extra: Record<string, unknown> | null, key: string): string | null {
  return normalizeEntraTenantId(extra?.[key])
}

export function resolveTenantEndpointTemplate(template: string, tenantId: string): string {
  if (!template.includes("{tenantId}")) {
    throw new Error("Tenant-scoped OAuth endpoint must include the {tenantId} placeholder.")
  }
  return template.split("{tenantId}").join(encodeURIComponent(tenantId))
}
