const BLOCKED_TAGS = new Set(["Admin", "Authentication", "System", "Webhooks"])
const SAFE_INCLUDED_TAGS = new Set([
  "Users",
  "Organizations",
  "Invitations",
  "API Keys",
  "Members",
  "Roles",
  "Teams",
  "Templates",
  "LLM Providers",
  "Skills",
  "Skill Hubs",
  "Workers",
  "Worker Runtime",
  "Worker Activity",
  "Config Objects",
  "Plugins",
  "Marketplaces",
  "Connectors",
  "GitHub",
])

const BLOCKED_OPERATION_IDS = new Set([
  "postApiKeys",
  "postV1ApiKeys",
  "deleteApiKeysByApiKeyId",
  "deleteV1ApiKeysByApiKeyId",
  "deleteOrg",
  "deleteV1Org",
  "deleteV1OrgsByOrgId",
  "postWorkersByWorkerIdTokens",
  "postV1WorkersByWorkerIdTokens",
])

export type OpenApiOperation = {
  operationId?: string
  summary?: string
  description?: string
  tags?: string[]
  parameters?: unknown[]
  requestBody?: unknown
  security?: unknown
  [key: string]: unknown
}

export function isMcpOperationAllowed(input: {
  method: string
  path: string
  operation: OpenApiOperation
}) {
  const explicit = input.operation["x-mcp"]
  if (explicit === false || explicit === "false") {
    return false
  }

  const operationId = input.operation.operationId
  if (!operationId || BLOCKED_OPERATION_IDS.has(operationId)) {
    return false
  }

  if (input.path.startsWith("/api/auth") || input.path.includes("/webhooks") || input.path.includes("/admin")) {
    return false
  }

  const tags = input.operation.tags ?? []
  if (tags.some((tag) => BLOCKED_TAGS.has(tag))) {
    return false
  }

  if (explicit === true || explicit === "true") {
    return true
  }

  return tags.some((tag) => SAFE_INCLUDED_TAGS.has(tag))
}

export function requiredScopeForMethod(method: string) {
  return method.toUpperCase() === "GET" ? "mcp:read" : "mcp:write"
}
