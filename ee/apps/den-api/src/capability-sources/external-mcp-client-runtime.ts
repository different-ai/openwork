import {
  abandonExternalMcpAuth as abandonWithCurrentClient,
  completeExternalMcpAuth as completeWithCurrentClient,
} from "./external-mcp-client.js"
import {
  abandonExternalMcpAuth as abandonWithEnterpriseClient,
  callExternalMcpTool as callWithEnterpriseClient,
  callListedExternalMcpTool as callListedWithEnterpriseClient,
  callExternalMcpToolRaw as callRawWithEnterpriseClient,
  completeExternalMcpAuth as completeWithEnterpriseClient,
  connectExternalMcp as connectWithEnterpriseClient,
  describeExternalMcpServer as describeWithEnterpriseClient,
  inspectExternalMcpToolCall as inspectWithEnterpriseClient,
  listExternalMcpResources as listResourcesWithEnterpriseClient,
  listExternalMcpResourceTemplates as listResourceTemplatesWithEnterpriseClient,
  listExternalMcpTools as listWithEnterpriseClient,
  readExternalMcpResource as readResourceWithEnterpriseClient,
} from "./enterprise-mcp-client-adapter.js"

export type ExternalMcpClientRuntime = {
  connectExternalMcp: typeof connectWithEnterpriseClient
  completeExternalMcpAuth: typeof completeWithEnterpriseClient
  abandonExternalMcpAuth: typeof abandonWithEnterpriseClient
  listExternalMcpTools: typeof listWithEnterpriseClient
  callExternalMcpTool: typeof callWithEnterpriseClient
  callListedExternalMcpTool: typeof callListedWithEnterpriseClient
  callExternalMcpToolRaw: typeof callRawWithEnterpriseClient
  describeExternalMcpServer: typeof describeWithEnterpriseClient
  listExternalMcpResources: typeof listResourcesWithEnterpriseClient
  listExternalMcpResourceTemplates: typeof listResourceTemplatesWithEnterpriseClient
  readExternalMcpResource: typeof readResourceWithEnterpriseClient
  inspectExternalMcpToolCall: typeof inspectWithEnterpriseClient
}

const enterpriseMcpClient: ExternalMcpClientRuntime = {
  connectExternalMcp: connectWithEnterpriseClient,
  completeExternalMcpAuth: completeWithEnterpriseClient,
  abandonExternalMcpAuth: abandonWithEnterpriseClient,
  listExternalMcpTools: listWithEnterpriseClient,
  callExternalMcpTool: callWithEnterpriseClient,
  callListedExternalMcpTool: callListedWithEnterpriseClient,
  callExternalMcpToolRaw: callRawWithEnterpriseClient,
  describeExternalMcpServer: describeWithEnterpriseClient,
  listExternalMcpResources: listResourcesWithEnterpriseClient,
  listExternalMcpResourceTemplates: listResourceTemplatesWithEnterpriseClient,
  readExternalMcpResource: readResourceWithEnterpriseClient,
  inspectExternalMcpToolCall: inspectWithEnterpriseClient,
}

export const externalMcpClientRuntimeName = "@openwork/enterprise-mcp-client"

export const {
  connectExternalMcp,
  completeExternalMcpAuth,
  abandonExternalMcpAuth,
  listExternalMcpTools,
  callExternalMcpTool,
  callListedExternalMcpTool,
  callExternalMcpToolRaw,
  describeExternalMcpServer,
  listExternalMcpResources,
  listExternalMcpResourceTemplates,
  readExternalMcpResource,
  inspectExternalMcpToolCall,
} = enterpriseMcpClient

// Version-one states can exist for at most their original ten-minute TTL
// after rollout. They must finish against the verifier format that created
// them.
export const completeLegacyExternalMcpAuth = completeWithCurrentClient
export const abandonLegacyExternalMcpAuth = abandonWithCurrentClient
