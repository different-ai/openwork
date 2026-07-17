import { z } from "zod"
import { getToolDescription, type McpToolOperation } from "../mcp/catalog.js"
import {
  providerScopesSatisfy,
  type NativeOAuthProviderConfig,
} from "./provider-registry.js"

type NativeProviderToolRequirement = {
  providerId: string
  method: string
  path: string
  anyOfFeatures: readonly string[]
}

/**
 * Capability availability belongs next to Den's native-provider runtime, not
 * in the dashboard. Each entry mirrors the feature guard in the corresponding
 * capability route. The catalog itself still comes from Den's generated
 * OpenAPI document, so adding a route without classifying it fails closed.
 */
const NATIVE_PROVIDER_TOOL_REQUIREMENTS: readonly NativeProviderToolRequirement[] = [
  { providerId: "google-workspace", method: "GET", path: "/v1/capabilities/google-workspace/gmail-messages", anyOfFeatures: ["gmailRead"] },
  { providerId: "google-workspace", method: "GET", path: "/v1/capabilities/google-workspace/gmail-message/{messageId}", anyOfFeatures: ["gmailRead"] },
  { providerId: "google-workspace", method: "GET", path: "/v1/capabilities/google-workspace/gmail-attachment/{messageId}/{attachmentId}", anyOfFeatures: ["gmailRead"] },
  { providerId: "google-workspace", method: "GET", path: "/v1/capabilities/google-workspace/calendar-events", anyOfFeatures: ["calendarRead", "calendarWrite"] },
  { providerId: "google-workspace", method: "POST", path: "/v1/capabilities/google-workspace/calendar-events", anyOfFeatures: ["calendarWrite"] },
  { providerId: "google-workspace", method: "PATCH", path: "/v1/capabilities/google-workspace/calendar-event/{eventId}", anyOfFeatures: ["calendarWrite"] },
  { providerId: "google-workspace", method: "GET", path: "/v1/capabilities/google-workspace/drive-files", anyOfFeatures: ["driveFile", "driveRead", "driveFull"] },
  { providerId: "google-workspace", method: "POST", path: "/v1/capabilities/google-workspace/drive-files", anyOfFeatures: ["driveFile", "driveFull"] },
  { providerId: "google-workspace", method: "GET", path: "/v1/capabilities/google-workspace/drive-file/{fileId}", anyOfFeatures: ["driveFile", "driveRead", "driveFull"] },
  { providerId: "google-workspace", method: "POST", path: "/v1/capabilities/google-workspace/drive-file-share/{fileId}", anyOfFeatures: ["driveFile", "driveFull"] },
  { providerId: "google-workspace", method: "POST", path: "/v1/capabilities/google-workspace/gmail-drafts", anyOfFeatures: ["gmailDraft"] },
  { providerId: "microsoft-365", method: "GET", path: "/v1/capabilities/microsoft-365/mail-messages", anyOfFeatures: ["mailRead"] },
  { providerId: "microsoft-365", method: "GET", path: "/v1/capabilities/microsoft-365/mail-message/{messageId}", anyOfFeatures: ["mailRead"] },
  { providerId: "microsoft-365", method: "GET", path: "/v1/capabilities/microsoft-365/calendar-events", anyOfFeatures: ["calendarRead"] },
  { providerId: "microsoft-365", method: "GET", path: "/v1/capabilities/microsoft-365/drive-files", anyOfFeatures: ["filesRead", "filesWrite", "filesReadAll", "filesFull"] },
  { providerId: "microsoft-365", method: "GET", path: "/v1/capabilities/microsoft-365/drive-file/{itemId}", anyOfFeatures: ["filesRead", "filesWrite", "filesReadAll", "filesFull"] },
  { providerId: "microsoft-365", method: "POST", path: "/v1/capabilities/microsoft-365/mail-drafts", anyOfFeatures: ["mailDraft"] },
  { providerId: "microsoft-365", method: "POST", path: "/v1/capabilities/microsoft-365/calendar-events", anyOfFeatures: ["calendarWrite"] },
  { providerId: "microsoft-365", method: "PUT", path: "/v1/capabilities/microsoft-365/drive-files", anyOfFeatures: ["filesWrite", "filesFull"] },
  { providerId: "microsoft-365", method: "GET", path: "/v1/capabilities/microsoft-365/teams-chats", anyOfFeatures: ["teamsChatRead", "teamsChatSend"] },
  { providerId: "microsoft-365", method: "GET", path: "/v1/capabilities/microsoft-365/teams-chats/{chatId}/messages", anyOfFeatures: ["teamsChatRead", "teamsChatSend"] },
  { providerId: "microsoft-365", method: "POST", path: "/v1/capabilities/microsoft-365/teams-chats/{chatId}/messages", anyOfFeatures: ["teamsChatSend"] },
]

export type NativeProviderToolAvailability = "available" | "connection_required" | "reconnect_required"

export type NativeProviderToolCatalogEntry = {
  name: string
  title?: string
  description?: string
  inputSchema: Record<string, unknown>
  annotations: {
    readOnlyHint: boolean
    destructiveHint: boolean
    idempotentHint: boolean
    openWorldHint: true
  }
  availability: NativeProviderToolAvailability
  availabilityReason?: string
}

function requirementKey(input: { providerId: string; method: string; path: string }): string {
  return `${input.providerId}:${input.method.toUpperCase()}:${input.path}`
}

function featureHasGrantedScopes(
  provider: NativeOAuthProviderConfig,
  feature: string,
  grantedScopes: readonly string[] | null,
): boolean {
  // Older provider grants did not always persist a scope list. The capability
  // routes deliberately preserve access in that case, so the catalog does too.
  if (!grantedScopes || grantedScopes.length === 0) return true
  const requiredScopes = provider.optionalFeatures?.[feature] ?? []
  return requiredScopes.every((scope) => providerScopesSatisfy(provider, grantedScopes, scope))
}

export function buildNativeProviderToolCatalog(input: {
  provider: NativeOAuthProviderConfig
  operations: readonly McpToolOperation[]
  selectedFeatures: readonly string[]
  grantedScopes: readonly string[] | null
  connected: boolean
}): NativeProviderToolCatalogEntry[] {
  const requirements = new Map(
    NATIVE_PROVIDER_TOOL_REQUIREMENTS
      .filter((entry) => entry.providerId === input.provider.providerId)
      .map((entry) => [requirementKey(entry), entry]),
  )
  const prefix = `/v1/capabilities/${input.provider.providerId}/`
  const tools: NativeProviderToolCatalogEntry[] = []

  for (const operation of input.operations) {
    if (!operation.path.startsWith(prefix)) continue
    const requirement = requirements.get(requirementKey({
      providerId: input.provider.providerId,
      method: operation.method,
      path: operation.path,
    }))
    if (!requirement) {
      throw new Error(`Native provider capability is missing a tool requirement: ${operation.method} ${operation.path}`)
    }

    const enabledFeatures = requirement.anyOfFeatures.filter((feature) => input.selectedFeatures.includes(feature))
    if (enabledFeatures.length === 0) continue

    const granted = enabledFeatures.some((feature) => featureHasGrantedScopes(input.provider, feature, input.grantedScopes))
    const availability: NativeProviderToolAvailability = !input.connected
      ? "connection_required"
      : granted
        ? "available"
        : "reconnect_required"

    tools.push({
      name: operation.name,
      ...(operation.operation.summary ? { title: operation.operation.summary } : {}),
      description: getToolDescription(operation),
      inputSchema: z.toJSONSchema(operation.inputSchema),
      annotations: {
        readOnlyHint: operation.method === "GET",
        destructiveHint: operation.method === "DELETE",
        idempotentHint: operation.method === "GET" || operation.method === "PUT",
        openWorldHint: true,
      },
      availability,
      ...(!input.connected
        ? { availabilityReason: "Connect your account to use this tool." }
        : !granted
          ? { availabilityReason: "Reconnect to grant the permissions required for this tool." }
          : {}),
    })
  }

  return tools
}
