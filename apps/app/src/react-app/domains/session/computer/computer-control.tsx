import { useEffect, useEffectEvent, useRef, useState } from "react"
import type { ComputerSnapshot } from "@openwork/types/desktop-ipc"

import { desktopBridge } from "@/app/lib/desktop"
import { useComputerSessionHistoryStore } from "@/components/chat/computer-session-history-store"
import { showsLiveComputerView } from "@/lib/computer-session-history"
import { useSessionFloatingSlot } from "../panel/floating-slot"
import { createComputerFollow } from "./computer-follow"
import { ComputerPanel } from "./computer-panel"
import { useComputerRequest } from "./computer-store"

const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)
const followComputer = createComputerFollow((sessionId, watching) => desktopBridge.computerFollow(sessionId, watching))

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
    } catch {}
    finally { reading.current = false }
  }
  useEffect(() => () => { generation.current++ }, [])
  useEffect(() => {
    const update = () => followComputer(sessionId, document.visibilityState === "visible")
    update()
    document.addEventListener("visibilitychange", update)
    return () => {
      document.removeEventListener("visibilitychange", update)
      followComputer(sessionId, false)
    }
  }, [sessionId])
  const readLatest = useEffectEvent(refresh)
  const working = Boolean(snapshot?.session || snapshot?.cleanupPending)
  const watching = useComputerSessionHistoryStore(state => Boolean(state.watching[sessionId]))
  const agent = useComputerSessionHistoryStore(state => state.agents[sessionId])
  useEffect(() => { if (!watching) useComputerSessionHistoryStore.getState().setAgent(sessionId, null) }, [sessionId, watching])
  useEffect(() => {
    const history = useComputerSessionHistoryStore.getState()
    history.setWorking(sessionId, working)
    if (!working) history.setWatching(sessionId, false)
  }, [sessionId, working])
  useEffect(() => () => useComputerSessionHistoryStore.getState().setWorking(sessionId, false), [sessionId])
  useEffect(() => {
    void readLatest()
    const update = () => { if (document.visibilityState === "visible") void readLatest() }
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
  if (!showsLiveComputerView({ watching, session: snapshot.session })) return null
  return <ComputerPanel key={agent ?? sessionId} sessionId={agent ?? sessionId} slot={slot} enabled={snapshot.enabled} canStop controlsBusy={stopping} stopping={stopping} cleanupPending={Boolean(snapshot.cleanupPending)} stopError={actionError} onStop={() => void halt()} />
}
