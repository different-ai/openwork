import { useEffect, useRef } from "react";
import { AGENT_VIEWPORTS, DEFAULT_AGENT_VIEWPORT, type AgentViewportKey } from "@openwork/browser-tabs";

import { isActiveWorkSessionStatus } from "../sidebar/utils";
import { getElectronBrowser } from "./utils";

const STORAGE_KEY = "openwork.browser.agentViewport";

/** The size the person picked for pages the agent works on. */
export function storedAgentViewport(): AgentViewportKey {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    if (value && Object.hasOwn(AGENT_VIEWPORTS, value)) return value as AgentViewportKey;
  } catch {
    // Storage can be unavailable; the default size still works.
  }
  return DEFAULT_AGENT_VIEWPORT;
}

export function chooseAgentViewport(key: AgentViewportKey) {
  try {
    window.localStorage.setItem(STORAGE_KEY, key);
  } catch {
    // The choice still applies for this run.
  }
  void getElectronBrowser()?.setAgentViewport?.(key)?.catch(() => {});
}

/**
 * Tells the desktop browser the saved agent size, hands tabs the person took
 * over back to the agent when a new turn starts, and releases a
 * conversation's tabs back to the panel's width as soon as its turn ends.
 */
export function useBrowserAgentTurns(statusById: Record<string, string>) {
  useEffect(() => {
    void getElectronBrowser()?.setAgentViewport?.(storedAgentViewport())?.catch(() => {});
  }, []);

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
