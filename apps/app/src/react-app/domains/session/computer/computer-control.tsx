import { useEffect, useEffectEvent, useRef, useState } from "react"
import type { ComputerSnapshot } from "@openwork/types/desktop-ipc"

import { desktopBridge } from "@/app/lib/desktop"
import { useSessionFloatingSlot } from "../panel/floating-slot"
import { ComputerPanel } from "./computer-panel"
import { useComputerRequest } from "./computer-store"

const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)

/**
 * Shows this chat's live computer view while the agent works. Setup and the
 * choice of computer live in Settings, so the chat shows no idle status.
 */
export function ComputerControl({ sessionId }: { sessionId: string }) {
  const slot = useSessionFloatingSlot()
  const request = useComputerRequest(sessionId)
  const [snapshot, setSnapshot] = useState<ComputerSnapshot | null>(null)
  const [actionError, setActionError] = useState("")
  const [stopping, setStopping] = useState(false)
  const generation = useRef(0)
  const reading = useRef(false)
  const changing = useRef(false)

  async function refresh() {
    if (reading.current || changing.current) return
    reading.current = true
    const current = generation.current
    try {
      const next = await desktopBridge.computerSnapshot(sessionId)
      if (current === generation.current) setSnapshot(next)
    } catch { /* The next read tries again. */ }
    finally { reading.current = false }
  }
  useEffect(() => () => { generation.current++ }, [])
  const readLatest = useEffectEvent(refresh)
  const working = Boolean(snapshot?.session || snapshot?.cleanupPending)
  useEffect(() => {
    void readLatest()
    const update = () => { if (document.visibilityState === "visible") void readLatest() }
    // Agent work can start without a request. Keep the live view current across
    // silent renewal and follow-up messages.
    const timer = window.setInterval(update, 1_500)
    window.addEventListener("focus", update)
    document.addEventListener("visibilitychange", update)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener("focus", update)
      document.removeEventListener("visibilitychange", update)
    }
  }, [request, working])

  async function halt() {
    if (changing.current) return
    changing.current = true
    const current = ++generation.current
    setStopping(true)
    setActionError("")
    try {
      await desktopBridge.computerHalt(sessionId)
    } catch (cause) {
      if (current === generation.current) setActionError(message(cause))
    } finally {
      changing.current = false
      if (current === generation.current) { setStopping(false); void refresh() }
    }
  }

  if (!slot || !snapshot || !working) return null
  return <ComputerPanel sessionId={sessionId} slot={slot} enabled={snapshot.enabled} canStop controlsBusy={stopping} stopping={stopping} cleanupPending={Boolean(snapshot.cleanupPending)} stopError={actionError} onStop={() => void halt()} />
}
