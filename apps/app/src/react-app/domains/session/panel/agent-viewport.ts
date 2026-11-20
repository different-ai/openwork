import { useEffect, useRef } from "react";
import type { AgentViewportKey } from "@openwork/browser-tabs";

import { isActiveWorkSessionStatus } from "../sidebar/utils";
import { getElectronBrowser } from "./utils";

export function chooseTabPageSize(tabId: string, key: AgentViewportKey) {
  void getElectronBrowser()?.setTabPageSize?.(tabId, key)?.catch(() => {});
}

export function useBrowserAgentTurns(statusById: Record<string, string>) {
  const previous = useRef<Record<string, string> | null>(null);
  useEffect(() => {
    const before = previous.current;
    previous.current = statusById;
    // Statuses already running when the window opens are not new turns.
    if (!before) return;
    for (const [sessionId, status] of Object.entries(statusById)) {
      if (isActiveWorkSessionStatus(status) && !isActiveWorkSessionStatus(before[sessionId])) {
        void getElectronBrowser()?.startAgentTurn?.(sessionId)?.catch(() => {});
      }
    }
    for (const [sessionId, status] of Object.entries(before)) {
      if (isActiveWorkSessionStatus(status) && !isActiveWorkSessionStatus(statusById[sessionId])) {
        void getElectronBrowser()?.endAgentTurn?.(sessionId)?.catch(() => {});
      }
    }
  }, [statusById]);
}
