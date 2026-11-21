import type { AuditActor } from "@openwork-ee/den-db/audit-log"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { env } from "../env.js"
import { statusFromError } from "../observability/hono.js"
import { auditRequestOutcome, auditResourceId, currentAuditRequestId, writePlatformAuditEvent, type AuditChangeCapture } from "./request-capture.js"
import { AuditUnavailableError, runAuditedServiceAction } from "./service-capture.js"
import { auditServiceActionDeclaration, type AuditServiceActionName } from "./service-actions.js"

export { AuditUnavailableError }

export type McpAuditPrincipal = Readonly<{ organizationId: string; userId: string; memberId: string; credentialId: string | null }>
export type PlatformAdminAuditActor = Readonly<{ userId: string; credentialId: string | null }>

type FailureClassifier<T> = Readonly<{
  result?: (value: T) => number | null
  error?: (error: unknown) => number | null
}>

class ServiceActionStatus extends Error {
  constructor(readonly status: number) {
    super("service_action_failed")
    this.name = "ServiceActionStatus"
  }
}

const credentialPattern = /^[A-Za-z0-9_.:@/-]{1,200}$/

export function mcpAuditCredentialId(value: string | null | undefined): string | null {
  return typeof value === "string" && credentialPattern.test(value) ? value : null
}

export function mcpAuditPrincipal(input: { organizationId: string; userId: string; memberId: string | null | undefined; credentialId: string | null }): McpAuditPrincipal | null {
  if (!input.memberId) return null
  try {
    return {
      organizationId: normalizeDenTypeId("organization", input.organizationId), userId: normalizeDenTypeId("user", input.userId),
      memberId: normalizeDenTypeId("member", input.memberId), credentialId: mcpAuditCredentialId(input.credentialId),
    }
  } catch {
    return null
  }
}

export function serviceAuditResourceId(value: unknown): string | null {
  return typeof value === "string" && value ? auditResourceId(value) : null
}

async function runClassified<T>(start: (fn: (capture: AuditChangeCapture | null) => Promise<T>) => Promise<T>, fn: (capture: AuditChangeCapture | null) => Promise<T>, classify: FailureClassifier<T> | undefined): Promise<T> {
  const holder: { settled?: { ok: true; value: T } | { ok: false; error: unknown } } = {}
  try {
    return await start(async (capture) => {
      let value: T
      try {
        value = await fn(capture)
      } catch (error) {
        const status = classify?.error?.(error) ?? null
        if (status === null || error instanceof AuditUnavailableError) throw error
        holder.settled = { ok: false, error }
        throw new ServiceActionStatus(status)
      }
      const status = classify?.result?.(value) ?? null
      if (status !== null && status >= 400) {
        holder.settled = { ok: true, value }
        throw new ServiceActionStatus(status)
      }
      return value
    })
  } catch (error) {
    const settled = holder.settled
    if (!(error instanceof ServiceActionStatus) || !settled) throw error
    if (settled.ok) return settled.value
    throw settled.error
  }
}

export function runMcpServiceAction<T>(
  name: AuditServiceActionName,
  principal: McpAuditPrincipal,
  resourceId: string | null,
  fn: (capture: AuditChangeCapture | null) => Promise<T>,
  classify?: FailureClassifier<T>,
): Promise<T> {
  const declaration = auditServiceActionDeclaration(name)
  const actor: AuditActor = { type: "user", id: principal.userId, memberId: principal.memberId, ...(principal.credentialId ? { credentialId: principal.credentialId } : {}) }
  return runClassified((wrapped) => runAuditedServiceAction({
    organizationId: principal.organizationId, actor, origin: declaration.origin, kind: declaration.kind, action: declaration.action, class: declaration.class,
    principalKey: `user:${principal.userId}:member:${principal.memberId}:key:mcp:${principal.credentialId ?? "token"}`,
    resource: { type: declaration.resource.type, id: resourceId },
  }, wrapped), fn, classify)
}

export function runPlatformAdminServiceAction<T>(
  name: AuditServiceActionName,
  admin: PlatformAdminAuditActor,
  organization: Readonly<{ id: string }>,
  fn: (capture: AuditChangeCapture | null) => Promise<T>,
  classify?: FailureClassifier<T>,
): Promise<T> {
  const declaration = auditServiceActionDeclaration(name)
  const userId = normalizeDenTypeId("user", admin.userId)
  const credentialId = mcpAuditCredentialId(admin.credentialId)
  const actor: AuditActor = { type: "user", id: userId, ...(credentialId ? { credentialId } : {}) }
  return runClassified((wrapped) => runAuditedServiceAction({
    organizationId: organization.id, actor, origin: declaration.origin, kind: declaration.kind, action: declaration.action, class: declaration.class,
    principalKey: `user:${userId}:platform_admin:key:mcp:${credentialId ?? "token"}`,
    resource: { type: declaration.resource.type, id: auditResourceId(organization.id) },
  }, wrapped), fn, classify)
}

export async function runPlatformAdminPlatformAction<T>(
  action: string,
  admin: PlatformAdminAuditActor,
  target: Readonly<{ type: string; id: string | null }>,
  fn: () => Promise<T>,
): Promise<T> {
  const record = async (status: number) => {
    if (!env.auditCaptureEnabled) return
    const mapped = auditRequestOutcome("platform", status)
    const credentialId = mcpAuditCredentialId(admin.credentialId)
    await writePlatformAuditEvent(currentAuditRequestId(), {
      method: "SERVICE", route: `service:${action}`, action: `${action}.${mapped.suffix}`, outcome: mapped.outcome, status,
      reasonCode: mapped.reasonCode ?? null, actor: { type: "user", id: normalizeDenTypeId("user", admin.userId), credentialId }, origin: "platform_admin",
      target: { type: target.type, id: target.id },
    })
  }
  let result: T
  try {
    result = await fn()
  } catch (error) {
    await record(statusFromError(error))
    throw error
  }
  await record(200)
  return result
}

export function toolErrorStatus(code: string | null): number {
  if (!code) return 424
  if (code === "insufficient_mcp_scope" || code === "forbidden" || code === "membership_required" || code === "mcp_membership_revoked" || code.endsWith("_access_required")) return 403
  if (code === "invalid_arguments" || code === "invalid_capability_arguments" || code === "invalid_schema") return 400
  if (code === "unknown_capability" || code.startsWith("unknown_") || code.endsWith("_not_found")) return 404
  if (code === "capability_timeout") return 504
  if (code === "script_failed") return 502
  return 424
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : null
}

export function toolResultErrorCode(result: Readonly<{ isError?: boolean; content?: readonly unknown[]; structuredContent?: unknown }>): string | null {
  const structured = recordOf(result.structuredContent)
  if (structured && typeof structured.error === "string") return structured.error
  for (const part of result.content ?? []) {
    const record = recordOf(part)
    if (!record || record.type !== "text" || typeof record.text !== "string") continue
    try {
      const parsed = recordOf(JSON.parse(record.text))
      if (parsed && typeof parsed.error === "string") return parsed.error
    } catch {
      continue
    }
  }
  return null
}

export function toolResultStatus(result: Readonly<{ isError?: boolean; content?: readonly unknown[]; structuredContent?: unknown }>): number | null {
  return result.isError === true ? toolErrorStatus(toolResultErrorCode(result)) : null
}

export function serviceErrorStatus(error: unknown): number | null {
  const record = recordOf(error)
  if (record && typeof record.status === "number") return null
  if (error instanceof Error && error.message.endsWith("_not_found")) return 404
  if (error instanceof Error && /(_incompatible|_required|_invalid)$/.test(error.message)) return 409
  return null
}

export const AUDIT_UNAVAILABLE_TOOL_MESSAGE = "OpenWork could not record this action in the organization's audit log, so it was not performed. Retry shortly."

export function auditUnavailableToolResult() {
  return { isError: true as const, content: [{ type: "text" as const, text: JSON.stringify({ error: "audit_unavailable", message: AUDIT_UNAVAILABLE_TOOL_MESSAGE }) }] }
}
