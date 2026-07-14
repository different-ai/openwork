import { env } from "../env.js"
import type { ExternalMcpOAuthRuntime } from "./generic-oauth.js"
import {
  abandonExternalMcpAuth as abandonWithCurrentClient,
  callExternalMcpTool as callWithCurrentClient,
  completeExternalMcpAuth as completeWithCurrentClient,
  connectExternalMcp as connectWithCurrentClient,
  listExternalMcpTools as listWithCurrentClient,
} from "./external-mcp-client.js"
import {
  abandonExternalMcpAuth as abandonWithEnterpriseClient,
  callExternalMcpTool as callWithEnterpriseClient,
  completeExternalMcpAuth as completeWithEnterpriseClient,
  connectExternalMcp as connectWithEnterpriseClient,
  listExternalMcpTools as listWithEnterpriseClient,
} from "./enterprise-mcp-client-adapter.js"

export type ExternalMcpClientRuntime = {
  connectExternalMcp: typeof connectWithCurrentClient
  completeExternalMcpAuth: typeof completeWithCurrentClient
  abandonExternalMcpAuth: typeof abandonWithCurrentClient
  listExternalMcpTools: typeof listWithCurrentClient
  callExternalMcpTool: typeof callWithCurrentClient
}

const currentDenMcpClient: ExternalMcpClientRuntime = {
  connectExternalMcp: connectWithCurrentClient,
  completeExternalMcpAuth: completeWithCurrentClient,
  abandonExternalMcpAuth: abandonWithCurrentClient,
  listExternalMcpTools: listWithCurrentClient,
  callExternalMcpTool: callWithCurrentClient,
}

const enterpriseMcpClient: ExternalMcpClientRuntime = {
  connectExternalMcp: connectWithEnterpriseClient,
  completeExternalMcpAuth: completeWithEnterpriseClient,
  abandonExternalMcpAuth: abandonWithEnterpriseClient,
  listExternalMcpTools: listWithEnterpriseClient,
  callExternalMcpTool: callWithEnterpriseClient,
}

export function selectExternalMcpClientRuntime(input: {
  enterpriseMcpClientEnabled: boolean
  current: ExternalMcpClientRuntime
  enterprise: ExternalMcpClientRuntime
}): ExternalMcpClientRuntime {
  return input.enterpriseMcpClientEnabled ? input.enterprise : input.current
}

export function externalMcpClientRuntimeForId(runtimeId: ExternalMcpOAuthRuntime): ExternalMcpClientRuntime {
  return runtimeId === "enterprise" ? enterpriseMcpClient : currentDenMcpClient
}

export const selectedExternalMcpClientRuntimeId: ExternalMcpOAuthRuntime = env.enterpriseMcpClientEnabled
  ? "enterprise"
  : "current"

export function externalMcpClientRuntimeIdForOAuthState(
  pinnedRuntimeId: ExternalMcpOAuthRuntime | undefined,
  selectedRuntimeId: ExternalMcpOAuthRuntime = selectedExternalMcpClientRuntimeId,
): ExternalMcpOAuthRuntime {
  return pinnedRuntimeId ?? selectedRuntimeId
}

export const externalMcpClientRuntimeName = env.enterpriseMcpClientEnabled
  ? "@openwork/enterprise-mcp-client"
  : "current Den MCP client"

export const selectedExternalMcpClientRuntime = selectExternalMcpClientRuntime({
  enterpriseMcpClientEnabled: env.enterpriseMcpClientEnabled,
  current: currentDenMcpClient,
  enterprise: enterpriseMcpClient,
})

export const {
  connectExternalMcp,
  completeExternalMcpAuth,
  abandonExternalMcpAuth,
  listExternalMcpTools,
  callExternalMcpTool,
} = selectedExternalMcpClientRuntime
