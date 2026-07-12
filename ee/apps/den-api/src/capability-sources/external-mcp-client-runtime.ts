import { env } from "../env.js"
import {
  callExternalMcpTool as callWithCurrentClient,
  completeExternalMcpAuth as completeWithCurrentClient,
  connectExternalMcp as connectWithCurrentClient,
  listExternalMcpTools as listWithCurrentClient,
} from "./external-mcp-client.js"
import {
  callExternalMcpTool as callWithEnterpriseClient,
  completeExternalMcpAuth as completeWithEnterpriseClient,
  connectExternalMcp as connectWithEnterpriseClient,
  listExternalMcpTools as listWithEnterpriseClient,
} from "./enterprise-mcp-client-adapter.js"

export type ExternalMcpClientRuntime = {
  connectExternalMcp: typeof connectWithCurrentClient
  completeExternalMcpAuth: typeof completeWithCurrentClient
  listExternalMcpTools: typeof listWithCurrentClient
  callExternalMcpTool: typeof callWithCurrentClient
}

const currentDenMcpClient: ExternalMcpClientRuntime = {
  connectExternalMcp: connectWithCurrentClient,
  completeExternalMcpAuth: completeWithCurrentClient,
  listExternalMcpTools: listWithCurrentClient,
  callExternalMcpTool: callWithCurrentClient,
}

const enterpriseMcpClient: ExternalMcpClientRuntime = {
  connectExternalMcp: connectWithEnterpriseClient,
  completeExternalMcpAuth: completeWithEnterpriseClient,
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

export const externalMcpClientRuntimeName = env.enterpriseMcpClientEnabled
  ? "@openwork/enterprise-mcp-client"
  : "current Den MCP client"

const selectedRuntime = selectExternalMcpClientRuntime({
  enterpriseMcpClientEnabled: env.enterpriseMcpClientEnabled,
  current: currentDenMcpClient,
  enterprise: enterpriseMcpClient,
})

export const {
  connectExternalMcp,
  completeExternalMcpAuth,
  listExternalMcpTools,
  callExternalMcpTool,
} = selectedRuntime
