import type { OpenworkMcpAppResource, OpenworkServerClient } from "@/app/lib/openwork-server";
import { startMcpAppTiming } from "@openwork/types/mcp-app-timing";

export type McpAppOrigin = {
  client: OpenworkServerClient;
  workspaceId: string;
  sessionId: string | null;
  engine?: "v1" | "v2";
  readOnly: boolean;
};

export function snapshotMcpAppArguments(args?: Record<string, unknown>) {
  const snapshot = structuredClone(args);
  const seen = new WeakSet<object>();
  const freeze = (value: unknown) => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  };
  freeze(snapshot);
  return snapshot;
}

export function createMcpAppActions(
  origin: McpAppOrigin,
  app: OpenworkMcpAppResource,
) {
  let active = true;
  const background = new AbortController();
  const assertActive = () => {
    if (!active) throw new Error("This view has closed or changed. Reopen it before using its actions.");
    if (origin.readOnly) throw new Error("This view is read-only and cannot perform actions.");
    if (!app.launchId) throw new Error("This view has no live launch context. Update OpenWork and reopen the view.");
  };
  return {
    dispose: () => {
      active = false;
      background.abort();
    },
    assertActive,
    checkRead: async (name: string, args?: Record<string, unknown>) => {
      assertActive();
      const result = await origin.client.callMcpAppTool(origin.workspaceId, {
        launchId: app.launchId,
        sessionId: origin.sessionId,
        ...(origin.engine ? { engine: origin.engine } : {}),
        serverName: app.serverName,
        resourceUri: app.resourceUri,
        name,
        arguments: snapshotMcpAppArguments(args),
        checkOnly: true,
      }, { signal: background.signal }).catch((cause: unknown) => {
        assertActive();
        throw cause;
      });
      assertActive();
      const identity = result._meta?.["openwork/providerIdentity"];
      return result._meta?.["openwork/readOnly"] === true && result.isError !== true && typeof identity === "string" ? identity : null;
    },
    callTool: async (name: string, args?: Record<string, unknown>, userInteraction = false) => {
      assertActive();
      const request = {
        launchId: app.launchId,
        sessionId: origin.sessionId,
        ...(origin.engine ? { engine: origin.engine } : {}),
        serverName: app.serverName,
        resourceUri: app.resourceUri,
        name,
        arguments: snapshotMcpAppArguments(args),
        ...(userInteraction ? { approved: true } : {}),
      };
      const finishTiming = startMcpAppTiming("desktop.tool-roundtrip");
      try {
        const result = await origin.client.callMcpAppTool(origin.workspaceId, request, userInteraction ? undefined : { signal: background.signal });
        assertActive();
        return result;
      } catch (cause) {
        assertActive();
        throw cause;
      } finally { finishTiming(); }
    },
  };
}
