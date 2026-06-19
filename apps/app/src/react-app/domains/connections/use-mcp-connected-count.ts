import { useEffect, useState } from "react";

import { unwrap } from "../../../app/lib/opencode";
import type { Client, McpStatusMap } from "../../../app/types";

const REFRESH_INTERVAL_MS = 60_000;

/**
 * Live count of connected MCP servers for the active workspace, polled from
 * opencode's mcp.status. Used by the session status bar so it reflects real
 * connectivity instead of a hardcoded value.
 */
export function useMcpConnectedCount(client: Client | null, directory: string): number {
  const [count, setCount] = useState(0);

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

    void refresh();
    const interval = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [client, directory]);

  return count;
}
