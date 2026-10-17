import { useEffect, useEffectEvent, useRef, useState } from "react"
import { AlertTriangle, Monitor } from "lucide-react"
import type { ComputerPermission, ComputerSnapshot } from "@openwork/types/desktop-ipc"

import { desktopBridge } from "@/app/lib/desktop"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useSessionFloatingSlot } from "../panel/floating-slot"
import { ComputerPanel } from "./computer-panel"
import { ComputerSetup } from "./computer-setup"
import { useComputerRequest, useComputerStore } from "./computer-store"

export type ComputerBusy = "halt" | "reset" | "choose" | ComputerPermission | null
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)

/** The rollout enables access. This control shows readiness and active work. */
export function ComputerControl({ sessionId }: { sessionId: string }) {
  const slot = useSessionFloatingSlot()
  const request = useComputerRequest(sessionId)
  const setupOpen = useComputerStore((state) => state.setupSessionId === sessionId)
  const openSetup = useComputerStore((state) => state.openSetup)
  const closeSetup = useComputerStore((state) => state.closeSetup)
  const [open, setOpen] = useState(false)
  const [snapshot, setSnapshot] = useState<ComputerSnapshot | null>(null)
  const [readError, setReadError] = useState("")
  const [actionError, setActionError] = useState("")
  const [busy, setBusy] = useState<ComputerBusy>(null)
  const generation = useRef(0)
  const reading = useRef(false)
  const changing = useRef(false)
  const trigger = useRef<HTMLButtonElement>(null)

  async function refresh() {
    if (reading.current || changing.current) return
    reading.current = true
    const current = generation.current
    try {
      const next = await desktopBridge.computerSnapshot(sessionId)
      if (current !== generation.current) return
      setSnapshot(next)
      setReadError("")
    } catch (cause) {
      if (current === generation.current) setReadError(message(cause))
    } finally { reading.current = false }
  }
  useEffect(() => () => { generation.current++ }, [])
  const readLatest = useEffectEvent(refresh)
  const working = Boolean(snapshot?.session || snapshot?.cleanupPending)
  useEffect(() => {
    void readLatest()
    const update = () => { if (document.visibilityState === "visible") void readLatest() }
    const timer = window.setInterval(() => { if (open || setupOpen || request || working || !snapshot || snapshot.readiness === "unsupported") update() }, 1_500)
    window.addEventListener("focus", update)
    document.addEventListener("visibilitychange", update)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener("focus", update)
      document.removeEventListener("visibilitychange", update)
    }
  }, [open, setupOpen, request, working, snapshot?.readiness])

  async function act(action: "halt" | "reset" | ComputerPermission, permission?: ComputerPermission) {
    if (changing.current) return
    changing.current = true
    const current = ++generation.current
    setBusy(action)
    setActionError("")
    try {
      if (action === "halt") await desktopBridge.computerHalt(sessionId)
      else if (action === "reset" && permission) await desktopBridge.computerResetPermission(permission)
      else if (action === "accessibility" || action === "screenRecording") await desktopBridge.computerSetup(action)
    } catch (cause) {
      if (current === generation.current) setActionError(message(cause))
    } finally {
      changing.current = false
      if (current === generation.current) { setBusy(null); void refresh() }
    }
  }

  async function choose(targetId: string) {
    if (changing.current || targetId === snapshot?.targetId) return
    changing.current = true
    const current = ++generation.current
    setBusy("choose")
    setActionError("")
    try {
      const next = await desktopBridge.computerChoose({ sessionId, targetId })
      if (current === generation.current) { setSnapshot(next); setReadError("") }
    } catch (cause) {
      if (current === generation.current) setActionError(message(cause))
    } finally {
      changing.current = false
      if (current === generation.current) setBusy(null)
    }
  }
  const remote = snapshot?.placement === "remote"
  const computer = snapshot?.targets.find((target) => target.id === snapshot.targetId)?.label ?? "This computer"
  const session = snapshot?.session
  const ready = snapshot?.readiness === "ready"
  const status = readError || session?.state === "unavailable" ? "Status unavailable" : snapshot?.cleanupPending ? "Stopping" : session?.state === "paused" ? "You have control" : session ? "Working" : ready ? "Ready" : snapshot?.readiness === "setup-required" ? "Setup needed" : "Unavailable"
  const attention = Boolean(request || readError || actionError || snapshot?.cleanupPending)
  // Unsupported platforms have no native computer controls.
  if (snapshot?.readiness === "unsupported" && snapshot.targets.length === 1) return null

  return <>
    {slot && snapshot && working ? <ComputerPanel sessionId={sessionId} slot={slot} enabled={snapshot.enabled} canStop controlsBusy={busy !== null} stopping={busy === "halt"} cleanupPending={Boolean(snapshot.cleanupPending)} stopError={actionError} onStop={() => void act("halt")} /> : null}
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger render={<PopoverTrigger render={<Button ref={trigger} variant="ghost" size="icon-sm" data-testid="session-computer-control" aria-label={`Computer use: ${status}`} className="relative rounded-xl text-gray-10 hover:bg-muted hover:text-foreground"><Monitor size={16} />{attention ? <AlertTriangle aria-hidden className="absolute right-0.5 top-0.5 size-3 text-amber-11" /> : null}</Button>} />} />
        <TooltipContent>Computer · {status}</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-[min(320px,calc(100vw-32px))] gap-3 text-xs leading-relaxed text-muted-foreground" data-testid="session-computer-popover">
        <h2 className="text-sm font-semibold text-foreground">Computer</h2>
        {snapshot && snapshot.targets.length > 1 ? <Select value={snapshot.targetId} disabled={busy !== null} onValueChange={(value) => { if (value) void choose(value) }}><SelectTrigger aria-label="Computer" data-testid="session-computer-target"><SelectValue /></SelectTrigger><SelectContent>{snapshot.targets.map((target) => <SelectItem key={target.id} value={target.id}>{target.label}</SelectItem>)}</SelectContent></Select> : <p>{computer}</p>}
        <p role="status" className="text-foreground" data-testid="session-computer-status">{status}</p>
        {snapshot ? <p data-testid="session-computer-readiness" data-state={snapshot.readiness}>{snapshot.detail}</p> : null}
        {session?.appName ? <p>{session.appName}{session.windowTitle ? ` · ${session.windowTitle}` : ""}</p> : null}
        {session?.reason ? <p>{session.reason}</p> : null}
        {readError ? <p role="alert" className="text-red-11">Updates unavailable. {readError}</p> : null}
        {actionError ? <p role="alert" className="text-red-11">{actionError}</p> : null}
        {snapshot?.busyElsewhere ? <p>Another chat is using the computer. This chat can use it when that task finishes.</p> : null}
        <div className="flex flex-wrap gap-2">
          {working ? <Button size="sm" variant="destructive" disabled={busy !== null} aria-busy={busy === "halt"} data-testid="session-computer-stop" onClick={() => void act("halt")}>Stop</Button> : null}
          {!remote ? <Button size="sm" variant={ready ? "outline" : "default"} disabled={busy !== null || !snapshot} data-testid="session-computer-setup" onClick={() => { setOpen(false); openSetup(sessionId) }}>{ready ? "macOS permissions" : "Set up"}</Button> : null}
        </div>
      </PopoverContent>
    </Popover>
    {setupOpen ? <ComputerSetup snapshot={snapshot} readError={readError} actionError={actionError} busy={busy} onPermission={(permission) => void act(permission)} onReset={(permission) => void act("reset", permission)} onRefresh={() => void refresh()} onClose={() => { closeSetup(); void desktopBridge.computerDismissSetup().catch(() => {}); trigger.current?.focus() }} /> : null}
  </>
}
