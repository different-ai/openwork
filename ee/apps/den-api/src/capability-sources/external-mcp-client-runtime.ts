import { env } from "../env.js"
import {
  abandonExternalMcpAuth as abandonWithCurrentClient,
  callExternalMcpTool as callWithCurrentClient,
  completeExternalMcpAuth as completeWithCurrentClient,
  connectExternalMcp as connectWithCurrentClient,
  inspectExternalMcpToolCall as inspectWithCurrentClient,
  listExternalMcpTools as listWithCurrentClient,
} from "./external-mcp-client.js"
import {
  abandonExternalMcpAuth as abandonWithEnterpriseClient,
  callExternalMcpTool as callWithEnterpriseClient,
  completeExternalMcpAuth as completeWithEnterpriseClient,
  connectExternalMcp as connectWithEnterpriseClient,
  inspectExternalMcpToolCall as inspectWithEnterpriseClient,
  listExternalMcpTools as listWithEnterpriseClient,
} from "./enterprise-mcp-client-adapter.js"
import type { ExternalMcpConnectionRow } from "./external-mcp-connections.js"
import { resolveExternalMcpEngine } from "./external-mcp-engine.js"

export type ExternalMcpClientRuntime = {
  connectExternalMcp: typeof connectWithCurrentClient
  completeExternalMcpAuth: (
    ...input: [...Parameters<typeof completeWithCurrentClient>, signedState?: string]
  ) => ReturnType<typeof completeWithCurrentClient>
  abandonExternalMcpAuth: typeof abandonWithEnterpriseClient
  listExternalMcpTools: typeof listWithCurrentClient
  callExternalMcpTool: typeof callWithCurrentClient
  inspectExternalMcpToolCall: typeof inspectWithCurrentClient
}

const currentDenMcpClient: ExternalMcpClientRuntime = {
  connectExternalMcp: connectWithCurrentClient,
  completeExternalMcpAuth: (connection, code, redirectUri, member, diagnosticReferenceId) => (
    completeWithCurrentClient(connection, code, redirectUri, member, diagnosticReferenceId)
  ),
  abandonExternalMcpAuth: abandonWithCurrentClient,
  listExternalMcpTools: listWithCurrentClient,
  callExternalMcpTool: callWithCurrentClient,
  inspectExternalMcpToolCall: inspectWithCurrentClient,
}

const enterpriseMcpClient: ExternalMcpClientRuntime = {
  connectExternalMcp: connectWithEnterpriseClient,
  completeExternalMcpAuth: completeWithEnterpriseClient,
  abandonExternalMcpAuth: abandonWithEnterpriseClient,
  listExternalMcpTools: listWithEnterpriseClient,
  callExternalMcpTool: callWithEnterpriseClient,
  inspectExternalMcpToolCall: inspectWithEnterpriseClient,
}

export function selectExternalMcpClientRuntime(input: {
  enterpriseMcpClientEnabled: boolean
  current: ExternalMcpClientRuntime
  enterprise: ExternalMcpClientRuntime
}): ExternalMcpClientRuntime {
  return input.enterpriseMcpClientEnabled ? input.enterprise : input.current
}

export const externalMcpClientRuntimeName = `per-organization (default: ${env.enterpriseMcpClientEnabled ? "@openwork/enterprise-mcp-client" : "current Den MCP client"})`

async function resolveExternalMcpClientRuntime(
  organizationId: ExternalMcpConnectionRow["organizationId"],
): Promise<ExternalMcpClientRuntime> {
  return selectExternalMcpClientRuntime({
    enterpriseMcpClientEnabled: await resolveExternalMcpEngine(organizationId) === "enterprise",
    current: currentDenMcpClient,
    enterprise: enterpriseMcpClient,
  })
}

export async function connectExternalMcp(
  ...input: Parameters<ExternalMcpClientRuntime["connectExternalMcp"]>
): Promise<Awaited<ReturnType<ExternalMcpClientRuntime["connectExternalMcp"]>>> {
  const runtime = await resolveExternalMcpClientRuntime(input[0].organizationId)
  return runtime.connectExternalMcp(...input)
}

export async function completeExternalMcpAuth(
  ...input: Parameters<ExternalMcpClientRuntime["completeExternalMcpAuth"]>
): Promise<Awaited<ReturnType<ExternalMcpClientRuntime["completeExternalMcpAuth"]>>> {
  const runtime = await resolveExternalMcpClientRuntime(input[0].organizationId)
  return runtime.completeExternalMcpAuth(...input)
}

export async function abandonExternalMcpAuth(
  ...input: Parameters<ExternalMcpClientRuntime["abandonExternalMcpAuth"]>
): Promise<Awaited<ReturnType<ExternalMcpClientRuntime["abandonExternalMcpAuth"]>>> {
  const runtime = await resolveExternalMcpClientRuntime(input[0].organizationId)
  return runtime.abandonExternalMcpAuth(...input)
}

export async function listExternalMcpTools(
  ...input: Parameters<ExternalMcpClientRuntime["listExternalMcpTools"]>
): Promise<Awaited<ReturnType<ExternalMcpClientRuntime["listExternalMcpTools"]>>> {
  const runtime = await resolveExternalMcpClientRuntime(input[0].organizationId)
  return runtime.listExternalMcpTools(...input)
}

export async function callExternalMcpTool(
  ...input: Parameters<ExternalMcpClientRuntime["callExternalMcpTool"]>
): Promise<Awaited<ReturnType<ExternalMcpClientRuntime["callExternalMcpTool"]>>> {
  const runtime = await resolveExternalMcpClientRuntime(input[0].connection.organizationId)
  return runtime.callExternalMcpTool(...input)
}

export async function inspectExternalMcpToolCall(
  ...input: Parameters<ExternalMcpClientRuntime["inspectExternalMcpToolCall"]>
): Promise<Awaited<ReturnType<ExternalMcpClientRuntime["inspectExternalMcpToolCall"]>>> {
  const runtime = await resolveExternalMcpClientRuntime(input[0].connection.organizationId)
  return runtime.inspectExternalMcpToolCall(...input)
}

// Version-one states can exist for at most their original ten-minute TTL
// after rollout. They must finish against the verifier format that created
// them, independent of the emergency runtime flag.
export const completeLegacyExternalMcpAuth = currentDenMcpClient.completeExternalMcpAuth
export const abandonLegacyExternalMcpAuth = currentDenMcpClient.abandonExternalMcpAuth
