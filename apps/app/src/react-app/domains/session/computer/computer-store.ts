import { useEffect, useRef } from "react"
import { create } from "zustand"
import type { ComputerRequest } from "@openwork/types/desktop-ipc"

import { desktopBridge } from "@/app/lib/desktop"
import { useBrowserSecretsEnabled } from "../panel/use-browser-secrets"
import { isActiveWorkSessionStatus } from "../sidebar/utils"
import { useDesktopFeature } from "../status/use-desktop-feature"

type ComputerStore = {
  requests: Record<string, ComputerRequest>
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

export function ComputerBridge() {
  const remote = useDesktopFeature("remoteComputers")
  useEffect(() => {
    void desktopBridge.computerSetRemoteEnabled(remote).catch(() => {})
  }, [remote])
  useBrowserSecretsEnabled()

  useEffect(() => window.__OPENWORK_ELECTRON__?.computer?.onRequest?.(({ sessionId, request }) => {
    useComputerStore.getState().setRequest(sessionId, request)
  }), [])
  return null
}

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
