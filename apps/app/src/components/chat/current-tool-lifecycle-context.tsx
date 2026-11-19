"use client"

import * as React from "react"
import type { DynamicToolUIPart, ToolUIPart } from "ai"
import { Badge } from "@/components/ui/badge"
import { t } from "@/i18n"
import { sandboxRunningToolStep } from "@/lib/tool-activity"

import type { SessionActivityStatus } from "@/react-app/domains/session/status/session-activity-store"
import {
  resolveCurrentToolLifecycle,
  type CurrentToolLifecycle,
} from "@/lib/current-tool-lifecycle"

type CurrentToolLifecycleContextValue = {
  activityStatus: SessionActivityStatus
  currentToolCallIds: ReadonlySet<string>
}

const CurrentToolLifecycleContext = React.createContext<CurrentToolLifecycleContextValue | null>(null)

export function toolCallIdsKey(toolCallIds: ReadonlySet<string>): string {
  return JSON.stringify([...toolCallIds].sort())
}

export function CurrentToolLifecycleProvider({
  activityStatus,
  currentToolCallIds,
  children,
}: CurrentToolLifecycleContextValue & { children: React.ReactNode }) {
  const idsKey = toolCallIdsKey(currentToolCallIds)
  const stableToolCallIds = React.useMemo(() => currentToolCallIds, [idsKey])
  const value = React.useMemo(
    () => ({ activityStatus, currentToolCallIds: stableToolCallIds }),
    [activityStatus, stableToolCallIds],
  )

  return (
    <CurrentToolLifecycleContext.Provider value={value}>
      {children}
    </CurrentToolLifecycleContext.Provider>
  )
}

export function useCurrentToolLifecycleResolver(): (
  toolCallId: string,
  isToolInFlight: boolean,
) => CurrentToolLifecycle | null {
  const context = React.useContext(CurrentToolLifecycleContext)
  return React.useCallback(
    (toolCallId, isToolInFlight) => {
      if (!context) return null
      return resolveCurrentToolLifecycle(
        context.activityStatus,
        context.currentToolCallIds.has(toolCallId),
        isToolInFlight,
      )
    },
    [context],
  )
}

/** The App spans tools, so waiting belongs to the session, not its last tool. */
export function useCurrentSessionActivityStatus(): SessionActivityStatus | null {
  return React.useContext(CurrentToolLifecycleContext)?.activityStatus ?? null
}

export const SandboxActivityContext = React.createContext<string | null>(null);

export function toolRanInSandbox(part: DynamicToolUIPart | ToolUIPart) {
  return part.callProviderMetadata?.openwork?.sandbox === true;
}

export function useSandboxToolStep(part: DynamicToolUIPart | ToolUIPart | undefined, running: boolean) {
  const step = React.useContext(SandboxActivityContext);
  return sandboxRunningToolStep(part, running, step);
}

export function SandboxToolTag({ part }: { part: DynamicToolUIPart | ToolUIPart }) {
  return toolRanInSandbox(part) ? <Badge variant="secondary" data-testid="sandbox-tag">{t("sandbox.tag")}</Badge> : null;
}
