import type { CloudMcpNativeEngineResolver, CloudMcpRuntimeRegistrar } from "./cloud-mcp-health.js";
import type { EngineV2Preview } from "./engine-v2-preview.js";
import artifacts from "./opencode-v2-artifacts.json" with { type: "json" };

/** Bind each health request to the selected local engine; remote owners remain independent. */
export function createNativeCloudMcpResolver(preview: Pick<EngineV2Preview, "status" | "connection">): CloudMcpNativeEngineResolver {
  return (workspace) => {
    if (workspace.workspaceType === "remote" || !preview.status().chatRouting) return undefined;
    const connection = preview.connection();
    return {
      version: artifacts.version,
      request: async (path, directory, method = "GET") => {
        if (!connection) throw new Error("OpenCode v2 is not running. Reconnect before checking OpenWork Connect.");
        const url = new URL(path, connection.url);
        if (directory) url.searchParams.set("location[directory]", directory);
        const response = await fetch(url, {
          method,
          headers: { Authorization: `Basic ${Buffer.from(`${connection.username}:${connection.password}`).toString("base64")}` },
          signal: AbortSignal.timeout(method === "POST" ? 30_000 : 5_000),
        });
        if (!response.ok) throw new Error(`OpenCode v2 ${path} returned ${response.status}`);
        return response.status === 204 ? undefined : response.json();
      },
    };
  };
}

export function createRoutedCloudMcpRegistrar(preview: Pick<EngineV2Preview, "status" | "connection" | "syncWorkspaceMcp">, v1: CloudMcpRuntimeRegistrar): CloudMcpRuntimeRegistrar {
  const nativeEngineForWorkspace = createNativeCloudMcpResolver(preview);
  return async (config, workspace, onlyNames, options) => {
    if (!nativeEngineForWorkspace(workspace)) return v1(config, workspace, onlyNames, options);
    const names = onlyNames ?? ["openwork-cloud"];
    try {
      // The folder's reconciler registers changed config and restarts only
      // connections that are not healthy (including one a repair
      // disconnected). A healthy connection is never restarted by a refresh.
      await preview.syncWorkspaceMcp(workspace.id, workspace.path, { reconnect: names });
      return { status: "ok", syncedNames: names, failures: [] };
    } catch (error) {
      if (options?.throwOnFailure) throw error;
      return { status: "failed", syncedNames: [], failures: [{ name: "openwork-cloud", message: error instanceof Error ? error.message : "OpenCode v2 MCP registration failed" }] };
    }
  };
}
