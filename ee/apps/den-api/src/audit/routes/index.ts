import { authAuditRoutes } from "./auth.js"
import { contentAuditRoutes } from "./content.js"
import { betterAuthDispatchRoutes, existingAuditRoutes } from "./existing.js"
import { integrationsAuditRoutes } from "./integrations.js"
import { orgAuditRoutes } from "./org.js"
import { platformAuditRoutes } from "./platform.js"
import type { AuditRouteDeclaration } from "./types.js"

export * from "./types.js"

export const BETTER_AUTH_BASE_PATH = "/api/auth"

/** Declaration slices by owning module; the coverage script reports per slice. */
export const auditRouteSlices: Readonly<Record<string, readonly AuditRouteDeclaration[]>> = {
  integrations: integrationsAuditRoutes,
  content: contentAuditRoutes,
  org: orgAuditRoutes,
  platform: platformAuditRoutes,
  auth: authAuditRoutes,
  existing: [...existingAuditRoutes, ...betterAuthDispatchRoutes],
}

export const auditRouteDeclarations: readonly AuditRouteDeclaration[] = Object.values(auditRouteSlices).flat()

export function auditRouteKey(method: string, path: string) {
  return `${method.toUpperCase()} ${path}`
}

const declarationsByKey = new Map<string, AuditRouteDeclaration>()
for (const declaration of auditRouteDeclarations) {
  const key = auditRouteKey(declaration.method, declaration.path)
  // First declaration wins at runtime; the coverage script rejects duplicates.
  if (!declarationsByKey.has(key)) declarationsByKey.set(key, declaration)
}

/** Keys declared more than once (a coverage-script failure). */
export function duplicateAuditRouteKeys(): string[] {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const declaration of auditRouteDeclarations) {
    const key = auditRouteKey(declaration.method, declaration.path)
    if (seen.has(key)) duplicates.add(key)
    seen.add(key)
  }
  return [...duplicates].sort()
}

/** Exact registered `${METHOD} ${template}`; HEAD falls back to GET (Hono dispatch) and any method to ALL. */
export function findAuditRouteDeclaration(method: string, path: string): AuditRouteDeclaration | null {
  const upper = method.toUpperCase()
  return declarationsByKey.get(auditRouteKey(upper, path))
    ?? (upper === "HEAD" ? declarationsByKey.get(auditRouteKey("GET", path)) : undefined)
    ?? declarationsByKey.get(auditRouteKey("ALL", path))
    ?? null
}

type CompiledBetterAuthDeclaration = { declaration: AuditRouteDeclaration; segments: string[]; params: number }

function splitPath(path: string) {
  return path.split("/").filter((segment) => segment.length > 0)
}

const betterAuthDeclarations: CompiledBetterAuthDeclaration[] = auditRouteDeclarations
  .filter((declaration) => declaration.path.startsWith(`${BETTER_AUTH_BASE_PATH}/`) && !declaration.path.includes("*"))
  .map((declaration) => {
    const segments = splitPath(declaration.path)
    return { declaration, segments, params: segments.filter((segment) => segment.startsWith(":")).length }
  })
  // Static segments win over parameters, then registration order.
  .sort((left, right) => left.params - right.params)

/**
 * Resolves a concrete better-auth request path (served by the `/api/auth/*`
 * catch-all) to the endpoint declaration "/api/auth" + endpoint.path, binding
 * `:param` segments. Never returns query strings.
 */
export function findBetterAuthDeclaration(method: string, concretePath: string): { declaration: AuditRouteDeclaration; params: Record<string, string> } | null {
  if (!concretePath.startsWith(`${BETTER_AUTH_BASE_PATH}/`)) return null
  const upper = method.toUpperCase()
  const segments = splitPath(concretePath)
  const methods = upper === "HEAD" ? ["HEAD", "GET", "ALL"] : [upper, "ALL"]
  for (const candidateMethod of methods) {
    for (const candidate of betterAuthDeclarations) {
      if (candidate.declaration.method !== candidateMethod || candidate.segments.length !== segments.length) continue
      const params: Record<string, string> = {}
      let matched = true
      for (let index = 0; index < segments.length; index++) {
        const expected = candidate.segments[index] ?? ""
        const actual = segments[index] ?? ""
        if (expected.startsWith(":")) {
          let decoded: string
          try { decoded = decodeURIComponent(actual) } catch { decoded = actual }
          params[expected.slice(1)] = decoded
        } else if (expected !== actual) {
          matched = false
          break
        }
      }
      if (matched) return { declaration: candidate.declaration, params }
    }
  }
  return null
}
