import type { OpenworkMcpAppResource, OpenworkServerClient } from "@/app/lib/openwork-server";
import { startMcpAppTiming } from "@openwork/types/mcp-app-timing";

/** The host surface owns this value. Never derive it from the selected workspace or App HTML. */
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
  // Background reads stop with this view, so a closed App never holds a
  // connection the App on screen is waiting for.
  const background = new AbortController();
  const assertActive = () => {
    if (!active) throw new Error("This App view has closed or changed. Reopen it before using its actions.");
    if (origin.readOnly) throw new Error("This view is read-only and cannot perform App actions.");
    if (!app.launchId) throw new Error("This App has no live launch context. Update OpenWork and reopen the App.");
  };
  return {
    dispose: () => {
      active = false;
      background.abort();
    },
    assertActive,
    /** The verified server identity when a call that needs no approval is allowed now, checked without running the tool. */
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
        // Only the isolated host proxy can attest a recent, single-use trusted
        // click. Background calls retain the server's read-only approval gate.
        // All calls still pass live-lease, same-server and permission checks.
        ...(userInteraction ? { approved: true } : {}),
      };
      const finishTiming = startMcpAppTiming("desktop.tool-roundtrip");
      try {
        // A click keeps running: the change it asked for may already be under way.
        const result = await origin.client.callMcpAppTool(origin.workspaceId, request, userInteraction ? undefined : { signal: background.signal });
        assertActive();
        return result;
      } catch (cause) {
        assertActive();
        // Never retry an action whose outcome may already have taken effect.
        throw cause;
      } finally { finishTiming(); }
    },
  };
}
