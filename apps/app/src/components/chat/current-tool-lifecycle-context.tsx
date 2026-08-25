"use client"

import * as React from "react"

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

export function CurrentToolLifecycleProvider({
  activityStatus,
  currentToolCallIds,
  children,
}: CurrentToolLifecycleContextValue & { children: React.ReactNode }) {
  const value = React.useMemo(
    () => ({ activityStatus, currentToolCallIds }),
    [activityStatus, currentToolCallIds],
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
