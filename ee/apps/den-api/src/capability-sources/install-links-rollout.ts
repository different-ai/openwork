/**
 * [INPUT]: 依赖组织安装链接 rollout 配置与调用者上下文
 * [OUTPUT]: 对外提供组织安装链接能力是否启用的策略判定
 * [POS]: capability-sources 的安装分发发布控制点，避免路由复制 rollout 规则
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
/**
 * Kill switch for organization install links.
 *
 * Install links are default-on for every org. Platform admins can explicitly
 * disable workspace-admin minting with `metadata.capabilities.installLinks: false`.
 * A literal `true` keeps the org enabled; absent and non-boolean values fall
 * through to the default-on posture.
 *
 * DEN_INSTALL_LINKS_GATING_ENABLED is deprecated and inert. env.ts still accepts
 * it, and callers still pass `options.gatingEnabled`, so existing deployment
 * configs and call sites continue to work while this helper ignores the
 * deployment-level gate.
 */

type MetadataInput = Record<string, unknown> | string | null | undefined

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function parseMetadata(input: MetadataInput): Record<string, unknown> {
  if (!input) {
    return {}
  }

  if (typeof input === "string") {
    try {
      const parsed: unknown = JSON.parse(input)
      return isRecord(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }

  return isRecord(input) ? input : {}
}

export function organizationInstallLinksEnabled(
  metadata: MetadataInput,
  options: { gatingEnabled: boolean },
): boolean {
  const parsed = parseMetadata(metadata)
  const capabilities = isRecord(parsed.capabilities) ? parsed.capabilities : {}

  if (capabilities.installLinks === true) {
    return true
  }
  if (capabilities.installLinks === false) {
    return false
  }
  return true
}
