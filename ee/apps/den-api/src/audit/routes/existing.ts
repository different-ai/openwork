import { auditReadCoveredRoutes, auditSettingsCoveredRoute, providerCoveredRoutes } from "../covered-routes.js"
import type { AuditRouteDeclaration, AuditRouteMethod } from "./types.js"

// Routes whose dedicated emitters predate generic request capture. The generic
// layer records nothing for these classes; the emitters below own their events.
const providerIdParam = (path: string) => path.includes(":inferenceProviderId") ? "inferenceProviderId" : null

export const existingAuditRoutes: readonly AuditRouteDeclaration[] = [
  ...providerCoveredRoutes.map(({ method, path, step }) => ({
    method, path, class: "domain_provider", action: `provider.configuration.${step}`, kind: "provider.configuration",
    resource: { type: "provider", idParam: providerIdParam(path) }, attribution: "org_context",
    changeEvidence: "audit/provider.ts:providerAuditMutation",
    notes: "Provider emitter records change snapshots, committed and failed/denied attempts (recordProviderAttempt).",
  } satisfies AuditRouteDeclaration)),
  ...auditReadCoveredRoutes.map(({ method, path, action }) => ({
    method, path, class: "domain_audit", action: `audit.${action}`, kind: "audit.access",
    resource: path.includes(":operationId") ? { type: "audit_operation", idParam: "operationId" } : { type: "audit_collection", idParam: null },
    attribution: "org_context", notes: "routes/org/audit.ts:serveAudit records requested before and served before release; fails closed with 503.",
  } satisfies AuditRouteDeclaration)),
  {
    method: auditSettingsCoveredRoute.method, path: auditSettingsCoveredRoute.path, class: "domain_audit", action: `audit.${auditSettingsCoveredRoute.action}`, kind: "audit.policy",
    resource: { type: "audit_policy", idParam: null }, attribution: "org_context",
    changeEvidence: "routes/org/audit.ts:updateAuditCapture -> den-db setAuditCaptureState",
    notes: "Policy change and lifecycle evidence commit atomically; matching no-ops record nothing.",
  },
]

// The better-auth catch-all (routes/auth/index.ts) only dispatches: the concrete
// endpoint declarations "/api/auth" + endpoint.path (./auth.ts) are resolved from
// the request path and record; an unknown endpoint is a 404 (access log only).
const betterAuthCatchAllMethods: readonly AuditRouteMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"]
export const betterAuthDispatchRoutes: readonly AuditRouteDeclaration[] = betterAuthCatchAllMethods.map((method) => ({
  method, path: "/api/auth/*", class: "proxy", action: "auth.endpoint.dispatch", kind: "platform.auth", resource: { type: "auth_endpoint", idParam: null }, attribution: "none",
  notes: "Dispatches to better-auth endpoints, each declared with its own class; the generic layer resolves the concrete endpoint declaration.",
}))
