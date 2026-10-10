import { useEffect, useState } from "react";

import { unwrap } from "../../../app/lib/opencode";
import type { Client, McpStatusMap } from "../../../app/types";
import { useGlobalSDK } from "../../kernel/global-sdk-provider";

/**
 * Live count of connected MCP servers for the active workspace, driven by real-time
 * Server-Sent Events (SSE) from the global SDK stream instead of polling on an interval.
 * Used by the session status bar so it reflects real connectivity instantly.
 */
export function useMcpConnectedCount(client: Client | null, directory: string): number {
  const [count, setCount] = useState(0);

  let globalSdk: ReturnType<typeof useGlobalSDK> | null = null;
  try {
    // Safely attempt to access the global SSE emitter context
    globalSdk = useGlobalSDK();
  } catch {
    // Fallback if component rendered outside GlobalSDKProvider (e.g., unit tests)
  }

  useEffect(() => {
    if (!client || !directory.trim()) {
      setCount(0);
      return;
    }

    let cancelled = false;

    const refresh = async () => {
      try {
        const status = unwrap(await client.mcp.status({ directory }));
        if (cancelled) return;
        const values = Object.values(status as McpStatusMap);
        setCount(values.filter((entry) => entry.status === "connected").length);
      } catch {
        if (!cancelled) setCount(0);
      }
    };

    // Perform initial fetch on mount or directory change
    void refresh();

    // Subscribe to SSE event stream if global SDK emitter is available
    if (globalSdk) {
      const handleEvent = (event: { type?: string }) => {
        if (
          event?.type &&
          (event.type.startsWith("mcp.") || event.type.startsWith("server."))
        ) {
          void refresh();
        }
      };

      const unsubscribeDirectory = globalSdk.event.on(directory, handleEvent);
      const unsubscribeGlobal = globalSdk.event.on("global", handleEvent);

      return () => {
        cancelled = true;
        unsubscribeDirectory();
        unsubscribeGlobal();
      };
    }

    return () => {
      cancelled = true;
    };
  }, [client, directory, globalSdk]);

  return count;
}