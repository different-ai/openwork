import { mcpAppResolutionRetryDelayMs } from "@/app/lib/mcp-app-resolution"
import type {
  OpenworkMcpAppLaunchReference,
  OpenworkMcpAppResource,
  OpenworkServerClient,
} from "@/app/lib/openwork-server"

type McpAppResolutionEndpoint = {
  client: Pick<OpenworkServerClient, "resolveMcpApp">
  workspaceId: string
}

type ResolveDashboardMcpAppOptions<TEndpoint extends McpAppResolutionEndpoint> = {
  endpoints: TEndpoint[]
  projectedToolName: string
  expected: Pick<OpenworkMcpAppResource, "serverName" | "toolName" | "resourceUri">
  launch?: OpenworkMcpAppLaunchReference
  wait?: (delayMs: number) => Promise<void>
}

/** Resolve the exact saved app before sending its arguments or launch approval. */
export async function resolveDashboardMcpApp<TEndpoint extends McpAppResolutionEndpoint>({
  endpoints,
  projectedToolName,
  expected,
  launch,
  wait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
}: ResolveDashboardMcpAppOptions<TEndpoint>): Promise<{ endpoint: TEndpoint; app: OpenworkMcpAppResource } | null> {
  let attemptIndex = 0
  while (true) {
    let resolveFailure: unknown = null
    for (const endpoint of endpoints) {
      try {
        const { app } = await endpoint.client.resolveMcpApp(endpoint.workspaceId, projectedToolName, launch)
        if (app && app.serverName === expected.serverName
          && app.toolName === expected.toolName && app.resourceUri === expected.resourceUri) return { endpoint, app }
      } catch (cause) {
        resolveFailure ??= cause
      }
    }
    if (!resolveFailure) return null
    const retryDelayMs = mcpAppResolutionRetryDelayMs(resolveFailure, attemptIndex)
    if (retryDelayMs === null) throw resolveFailure
    await wait(retryDelayMs)
    attemptIndex += 1
  }
}
