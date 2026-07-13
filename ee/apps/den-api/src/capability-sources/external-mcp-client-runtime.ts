import { env } from "../env.js"
import {
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
  completeExternalMcpAuth: (
    ...input: [...Parameters<typeof completeWithCurrentClient>, signedState?: string]
  ) => ReturnType<typeof completeWithCurrentClient>
  abandonExternalMcpAuth: typeof abandonWithEnterpriseClient
  listExternalMcpTools: typeof listWithCurrentClient
  callExternalMcpTool: typeof callWithCurrentClient
}

const currentDenMcpClient: ExternalMcpClientRuntime = {
  connectExternalMcp: connectWithCurrentClient,
  completeExternalMcpAuth: (connection, code, redirectUri, member, diagnosticReferenceId) => (
    completeWithCurrentClient(connection, code, redirectUri, member, diagnosticReferenceId)
  ),
  abandonExternalMcpAuth: async () => undefined,
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
  abandonExternalMcpAuth,
  listExternalMcpTools,
  callExternalMcpTool,
} = selectedRuntime
