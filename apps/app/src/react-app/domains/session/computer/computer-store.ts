import { useEffect, useRef } from "react"
import { create } from "zustand"
import type { ComputerRequest } from "@openwork/types/desktop-ipc"

import { desktopBridge } from "@/app/lib/desktop"
import { isActiveWorkSessionStatus } from "../sidebar/utils"
import { useDesktopFeature } from "../status/use-desktop-feature"

type ComputerStore = {
  /** Chats whose agent is waiting for computer use: setup or the person's allowance. */
  requests: Record<string, ComputerRequest>
  /** Bumped when the person presses Continue in a chat's Computer view. */
  continued: Record<string, number>
  setRequest: (sessionId: string, request: ComputerRequest | null) => void
  markContinued: (sessionId: string) => void
}

export const useComputerStore = create<ComputerStore>((set) => ({
  requests: {},
  continued: {},
  setRequest: (sessionId, request) => set((state) => {
    const requests = { ...state.requests }
    if (request) requests[sessionId] = request
    else delete requests[sessionId]
    return { requests }
  }),
  markContinued: (sessionId) => set((state) => ({ continued: { ...state.continued, [sessionId]: (state.continued[sessionId] ?? 0) + 1 } })),
}))

export const useComputerRequest = (sessionId: string | null | undefined) =>
  useComputerStore((state) => sessionId ? state.requests[sessionId] ?? null : null)

/**
 * Connects the desktop's computer broker to the app, once per window and on
 * every route, Settings included: reports the `computerUse`,
 * `remoteComputers` and `computerUseBackground` features and keeps in-chat
 * requests current.
 */
export function ComputerBridge() {
  const enabled = useDesktopFeature("computerUse")
  const remote = useDesktopFeature("remoteComputers")
  const background = useDesktopFeature("computerUseBackground")
  useEffect(() => {
    void desktopBridge.computerSetRemoteEnabled(enabled && remote).catch(() => {})
  }, [enabled, remote])

  useEffect(() => {
    void desktopBridge.computerSetBackgroundEnabled(enabled && background).catch(() => {})
  }, [enabled, background])

  useEffect(() => {
    void desktopBridge.computerSetFeatureEnabled(enabled).catch(() => {})
    if (!enabled) return
    return window.__OPENWORK_ELECTRON__?.computer?.onRequest?.(({ sessionId, request }) => {
      useComputerStore.getState().setRequest(sessionId, request)
    })
  }, [enabled])
  return null
}

/**
 * Hands the Mac back as soon as a chat's turn ends (the broker also releases
 * idle sessions on its own; this only makes it immediate).
 */
export function useComputerEndTurn(statusById: Record<string, string>, enabled: boolean) {
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
