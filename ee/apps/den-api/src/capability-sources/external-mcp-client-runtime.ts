import {
  abandonExternalMcpAuth as abandonWithCurrentClient,
  completeExternalMcpAuth as completeWithCurrentClient,
} from "./external-mcp-client.js"
import {
  abandonExternalMcpAuth as abandonWithEnterpriseClient,
  callExternalMcpTool as callWithEnterpriseClient,
  completeExternalMcpAuth as completeWithEnterpriseClient,
  connectExternalMcp as connectWithEnterpriseClient,
  inspectExternalMcpToolCall as inspectWithEnterpriseClient,
  listExternalMcpTools as listWithEnterpriseClient,
} from "./enterprise-mcp-client-adapter.js"

export type ExternalMcpClientRuntime = {
  connectExternalMcp: typeof connectWithEnterpriseClient
  completeExternalMcpAuth: typeof completeWithEnterpriseClient
  abandonExternalMcpAuth: typeof abandonWithEnterpriseClient
  listExternalMcpTools: typeof listWithEnterpriseClient
  callExternalMcpTool: typeof callWithEnterpriseClient
  inspectExternalMcpToolCall: typeof inspectWithEnterpriseClient
}

const enterpriseMcpClient: ExternalMcpClientRuntime = {
  connectExternalMcp: connectWithEnterpriseClient,
  completeExternalMcpAuth: completeWithEnterpriseClient,
  abandonExternalMcpAuth: abandonWithEnterpriseClient,
  listExternalMcpTools: listWithEnterpriseClient,
  callExternalMcpTool: callWithEnterpriseClient,
  inspectExternalMcpToolCall: inspectWithEnterpriseClient,
}

export const externalMcpClientRuntimeName = "@openwork/enterprise-mcp-client"

export const {
  connectExternalMcp,
  completeExternalMcpAuth,
  abandonExternalMcpAuth,
  listExternalMcpTools,
  callExternalMcpTool,
  inspectExternalMcpToolCall,
} = enterpriseMcpClient

// Version-one states can exist for at most their original ten-minute TTL
// after rollout. They must finish against the verifier format that created
// them.
export const completeLegacyExternalMcpAuth = completeWithCurrentClient
export const abandonLegacyExternalMcpAuth = abandonWithCurrentClient
