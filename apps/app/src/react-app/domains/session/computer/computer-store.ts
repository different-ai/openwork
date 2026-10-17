import { useEffect, useRef } from "react"
import { create } from "zustand"
import type { ComputerRequest } from "@openwork/types/desktop-ipc"

import { desktopBridge } from "@/app/lib/desktop"
import { isActiveWorkSessionStatus } from "../sidebar/utils"

type ComputerStore = {
  /** Chats whose agent is waiting for computer use: setup or the person's allowance. */
  requests: Record<string, ComputerRequest>
  /** The chat whose setup checklist is open, from the header or an in-chat card. */
  setupSessionId: string | null
  setRequest: (sessionId: string, request: ComputerRequest | null) => void
  openSetup: (sessionId: string) => void
  closeSetup: () => void
}

export const useComputerStore = create<ComputerStore>((set) => ({
  requests: {},
  setupSessionId: null,
  setRequest: (sessionId, request) => set((state) => {
    const requests = { ...state.requests }
    if (request) requests[sessionId] = request
    else delete requests[sessionId]
    return { requests }
  }),
  openSetup: (sessionId) => set({ setupSessionId: sessionId }),
  closeSetup: () => set({ setupSessionId: null }),
}))

export const useComputerRequest = (sessionId: string | null | undefined) =>
  useComputerStore((state) => sessionId ? state.requests[sessionId] ?? null : null)

/**
 * Connects the desktop's computer broker to the chat, once per window: reports
 * the `computerUse` and `remoteComputers` features, keeps in-chat requests current, and
 * hands the Mac back as soon as a chat's turn ends (the broker also releases
 * idle sessions on its own; this only makes it immediate).
 */
export function useComputerBridge(statusById: Record<string, string>, enabled: boolean, remote: boolean) {
  useEffect(() => {
    void desktopBridge.computerSetRemoteEnabled(enabled && remote).catch(() => {})
  }, [enabled, remote])

  useEffect(() => {
    void desktopBridge.computerSetFeatureEnabled(enabled).catch(() => {})
    if (!enabled) return
    return window.__OPENWORK_ELECTRON__?.computer?.onRequest?.(({ sessionId, request }) => {
      useComputerStore.getState().setRequest(sessionId, request)
    })
  }, [enabled])

  const previous = useRef<Record<string, string>>({})
  useEffect(() => {
    const before = previous.current
    previous.current = statusById
    if (!enabled) return
    for (const [sessionId, status] of Object.entries(before)) {
      if (isActiveWorkSessionStatus(status) && !isActiveWorkSessionStatus(statusById[sessionId])) {
        void desktopBridge.computerEndTurn(sessionId).catch(() => {})
      }
    }
  }, [statusById, enabled])
}
