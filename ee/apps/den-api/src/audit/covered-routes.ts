// Leaf module (no imports) so coverage.ts and routes/existing.ts share one list
// without an import cycle. coverage.ts re-exports these.
export type ProviderCoveredRoute = Readonly<{ method: "POST" | "PATCH" | "DELETE"; path: string; step: string }>

export const providerCoveredRoutes: readonly ProviderCoveredRoute[] = [
  { method: "POST", path: "/v1/inference-providers", step: "create" },
  { method: "PATCH", path: "/v1/inference-providers/:inferenceProviderId", step: "update" },
  { method: "DELETE", path: "/v1/inference-providers/:inferenceProviderId", step: "delete" },
  { method: "POST", path: "/v1/inference-providers/:inferenceProviderId/enable-models", step: "models.enable" },
  { method: "POST", path: "/v1/inference-providers/:inferenceProviderId/model-groups", step: "group.create" },
  { method: "PATCH", path: "/v1/inference-providers/:inferenceProviderId/model-groups/:groupId", step: "group.update" },
  { method: "DELETE", path: "/v1/inference-providers/:inferenceProviderId/model-groups/:groupId", step: "group.delete" },
  { method: "POST", path: "/v1/inference-providers/:inferenceProviderId/credential-sets", step: "set.create" },
  { method: "PATCH", path: "/v1/inference-providers/:inferenceProviderId/credential-sets/:credentialSetId", step: "set.update" },
  { method: "DELETE", path: "/v1/inference-providers/:inferenceProviderId/credential-sets/:credentialSetId", step: "set.delete" },
  { method: "POST", path: "/v1/inference-providers/:inferenceProviderId/access-grants", step: "grant.create" },
  { method: "PATCH", path: "/v1/inference-providers/:inferenceProviderId/access-grants/:grantId", step: "grant.update" },
  { method: "DELETE", path: "/v1/inference-providers/:inferenceProviderId/access-grants/:grantId", step: "grant.delete" },
  { method: "DELETE", path: "/v1/inference-providers/:inferenceProviderId/access/:grantId", step: "grant.delete" },
]

export const auditReadCoveredRoutes = [
  { method: "GET", path: "/v1/audit/event-types", action: "event_types" },
  { method: "GET", path: "/v1/audit/operations", action: "operations" },
  { method: "GET", path: "/v1/audit/operations/:operationId/events", action: "events" },
  { method: "GET", path: "/v1/audit/usage", action: "usage" },
  { method: "GET", path: "/v1/audit/export", action: "export" },
] as const satisfies ReadonlyArray<{ method: "GET"; path: string; action: string }>

export const auditSettingsCoveredRoute = { method: "PATCH", path: "/v1/audit/settings", action: "capture" } as const satisfies { method: "PATCH"; path: string; action: string }
