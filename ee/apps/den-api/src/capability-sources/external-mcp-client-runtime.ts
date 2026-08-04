import {
  abandonExternalMcpAuth as abandonWithCurrentClient,
  callExternalMcpTool as callWithCurrentClient,
  completeExternalMcpAuth as completeWithCurrentClient,
  inspectExternalMcpToolCall as inspectWithCurrentClient,
  listExternalMcpTools as listWithCurrentClient,
} from "./external-mcp-client.js"
import {
  abandonExternalMcpAuth as abandonWithEnterpriseClient,
  completeExternalMcpAuth as completeWithEnterpriseClient,
  connectExternalMcp as connectWithEnterpriseClient,
} from "./enterprise-mcp-client-adapter.js"

export type ExternalMcpClientRuntime = {
  connectExternalMcp: typeof connectWithEnterpriseClient
  completeExternalMcpAuth: typeof completeWithEnterpriseClient
  abandonExternalMcpAuth: typeof abandonWithEnterpriseClient
  listExternalMcpTools: typeof listWithCurrentClient
  callExternalMcpTool: typeof callWithCurrentClient
  inspectExternalMcpToolCall: typeof inspectWithCurrentClient
}

const externalMcpClient: ExternalMcpClientRuntime = {
  connectExternalMcp: connectWithEnterpriseClient,
  completeExternalMcpAuth: completeWithEnterpriseClient,
  abandonExternalMcpAuth: abandonWithEnterpriseClient,
  listExternalMcpTools: listWithCurrentClient,
  callExternalMcpTool: callWithCurrentClient,
  inspectExternalMcpToolCall: inspectWithCurrentClient,
}

export const externalMcpClientRuntimeName = "@openwork/enterprise-mcp-client + pooled MCP SDK capabilities"

export const {
  connectExternalMcp,
  completeExternalMcpAuth,
  abandonExternalMcpAuth,
  listExternalMcpTools,
  callExternalMcpTool,
  inspectExternalMcpToolCall,
} = externalMcpClient

// Version-one states can exist for at most their original ten-minute TTL
// after rollout. They must finish against the verifier format that created
// them.
export const completeLegacyExternalMcpAuth = completeWithCurrentClient
export const abandonLegacyExternalMcpAuth = abandonWithCurrentClient
