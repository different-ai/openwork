import { env } from "../env.js"
import {
  callExternalMcpTool as callWithCurrentClient,
  completeExternalMcpAuth as completeWithCurrentClient,
  connectExternalMcp as connectWithCurrentClient,
  listExternalMcpTools as listWithCurrentClient,
} from "./external-mcp-client.js"
import type {
  ExternalMcpDiagnosticCredentialFence,
  ExternalMcpDiagnosticObserver,
  ExternalMcpLifecycleDeadline,
  ExternalMcpMemberContext,
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
    connection: Parameters<typeof completeWithCurrentClient>[0],
    code: string,
    redirectUri: string,
    signedState: string,
    credentialFence?: ExternalMcpDiagnosticCredentialFence,
    member?: ExternalMcpMemberContext,
    diagnosticObserver?: ExternalMcpDiagnosticObserver,
    lifecycleDeadline?: ExternalMcpLifecycleDeadline,
    diagnosticReferenceId?: string,
  ) => ReturnType<typeof completeWithCurrentClient>
  abandonExternalMcpAuth: typeof abandonWithEnterpriseClient
  listExternalMcpTools: typeof listWithCurrentClient
  callExternalMcpTool: typeof callWithCurrentClient
}

const currentDenMcpClient: ExternalMcpClientRuntime = {
  connectExternalMcp: connectWithCurrentClient,
  completeExternalMcpAuth: completeWithCurrentClient,
  abandonExternalMcpAuth: async () => undefined,
  listExternalMcpTools: listWithCurrentClient,
  callExternalMcpTool: callWithCurrentClient,
}

const enterpriseMcpClient: ExternalMcpClientRuntime = {
  connectExternalMcp: connectWithEnterpriseClient,
  completeExternalMcpAuth: async (
    connection,
    code,
    redirectUri,
    signedState,
    _credentialFence,
    member,
    diagnosticObserver,
    lifecycleDeadline,
    diagnosticReferenceId,
  ) => {
    const startedAt = Date.now()
    await diagnosticObserver?.({
      phase: "AUTH_TOKEN_ACQUISITION",
      outcome: "running",
      healthLevel: "reachable",
      messageSafe: "Exchanging the authorization response for an MCP access token.",
    })
    await completeWithEnterpriseClient(
      connection,
      code,
      redirectUri,
      member,
      diagnosticReferenceId,
      signedState,
    )
    if (lifecycleDeadline?.signal.aborted) {
      throw lifecycleDeadline.signal.reason ?? new Error("The external MCP lifecycle was cancelled.")
    }
    await diagnosticObserver?.({
      phase: "AUTH_TOKEN_ACQUISITION",
      outcome: "passed",
      healthLevel: "authorized",
      messageSafe: "The authorization server completed the token exchange and the MCP resource accepted the credential.",
      phaseDurationMs: Date.now() - startedAt,
    })
  },
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
