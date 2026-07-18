/**
 * [INPUT]: 依赖新旧 OAuth client 身份、关联账户枚举与撤销回调
 * [OUTPUT]: 对外提供 client 身份变化判定和变更前账户撤销事务
 * [POS]: capability-sources 的凭证轮换护栏，阻止旧 token 跨 OAuth client 继续使用
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import type { DenTypeId } from "@openwork-ee/utils/typeid"

export function oauthClientIdentityChanged(input: {
  hadExistingClient: boolean
  previousClientId: string | null
  nextClientId: string
  previousTenantId: string | null
  nextTenantId: string | null
}): boolean {
  if (!input.hadExistingClient) return false
  return input.previousClientId !== input.nextClientId || input.previousTenantId !== input.nextTenantId
}

export async function revokeAccountsBeforeOAuthClientIdentityChange(input: {
  hadExistingClient: boolean
  previousClientId: string | null
  nextClientId: string
  previousTenantId: string | null
  nextTenantId: string | null
  organizationId: DenTypeId<"organization">
  providerId: string
  revoke: (target: { organizationId: DenTypeId<"organization">; providerId: string }) => Promise<void>
}): Promise<boolean> {
  if (!oauthClientIdentityChanged(input)) return false
  await input.revoke({ organizationId: input.organizationId, providerId: input.providerId })
  return true
}
