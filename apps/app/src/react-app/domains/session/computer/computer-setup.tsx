import { useEffect, useRef, useState } from "react"
import { Check, Loader2 } from "lucide-react"
import type { ComputerPermission, ComputerSnapshot } from "@openwork/types/desktop-ipc"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import type { ComputerBusy } from "./computer-control"

const permissions: Array<{ id: ComputerPermission; title: string; purpose: string }> = [
  { id: "accessibility", title: "Accessibility", purpose: "Use app controls, the mouse and the keyboard in Mac apps." },
  { id: "screenRecording", title: "Screen Recording", purpose: "See app windows. macOS may call it Screen & System Audio Recording." },
]
// After opening a pane, give macOS a moment before offering the stale-entry fix.
const STUCK_AFTER_MS = 15_000

function Row({ done, waiting, title, detail, children, testId }: { done: boolean; waiting: boolean; title: string; detail: string; children?: React.ReactNode; testId: string }) {
  return (
    <li className="flex items-start gap-3 border-t border-border py-3 first:border-t-0" data-testid={testId} data-state={done ? "done" : waiting ? "waiting" : "todo"}>
      <span aria-hidden className={cn("mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border", done ? "border-green-9 bg-green-9 text-white" : "border-border text-muted-foreground")}>
        {done ? <Check size={12} strokeWidth={3} /> : waiting ? <Loader2 size={12} className="animate-spin" /> : null}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium text-foreground">{title}</h3>
          <span className={cn("text-xs", done ? "text-green-11" : waiting ? "text-amber-11" : "text-muted-foreground")}>{done ? "On" : waiting ? "Waiting for macOS" : "Off"}</span>
        </div>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{detail}</p>
        {children}
      </div>
    </li>
  )
}

/**
 * One live checklist for the required macOS system permissions. Every
 * status comes from a fresh helper probe; guidance never grants anything.
 */
export function ComputerSetup({ snapshot, readError, actionError, busy, onPermission, onReset, onRefresh, onClose }: {
  snapshot: ComputerSnapshot | null
  readError: string
  actionError: string
  busy: ComputerBusy
  onPermission: (permission: ComputerPermission) => void
  onReset: (permission: ComputerPermission) => void
  onRefresh: () => void
  onClose: () => void
}) {
  const [opened, setOpened] = useState<Partial<Record<ComputerPermission, number>>>({})
  const [now, setNow] = useState(Date.now)
  const finished = useRef(false)
  // Opened when everything was already on: stay until the person closes it.
  const startedDone = useRef<boolean | null>(null)
  const verified = readError ? undefined : snapshot?.permissions
  const granted = snapshot?.readiness === "ready"
  const entry = snapshot?.entry.name ?? "OpenWork"
  const done = granted
  if (startedDone.current === null && snapshot && !readError) startedDone.current = done
  const nextPermission = permissions.find((permission) => verified?.[permission.id] !== true)?.id

  useEffect(() => {
    if (!Object.keys(opened).length || granted) return
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [opened, granted])

  // Everything is on: say so briefly and get out of the way.
  useEffect(() => {
    if (!done || finished.current || startedDone.current !== false) return
    finished.current = true
    const timer = window.setTimeout(onClose, 1_600)
    return () => window.clearTimeout(timer)
  }, [done, onClose])

  const open = (permission: ComputerPermission) => {
    setOpened((current) => ({ ...current, [permission]: Date.now() }))
    onPermission(permission)
  }

  return (
    <Dialog open onOpenChange={(value) => { if (!value) onClose() }}>
      <DialogContent className="max-h-[min(640px,calc(100dvh-32px))] gap-4 overflow-y-auto lg:max-w-lg" data-testid="session-computer-setup-dialog">
        <DialogHeader>
          <DialogTitle>{done ? "Computer use is ready" : "Set up computer use"}</DialogTitle>
          <DialogDescription>
            {done
              ? "The agent can use Mac apps in this chat. Nothing starts until it needs one."
              : <>In System Settings, turn on <span className="font-medium text-foreground" data-testid="session-computer-entry">{entry}</span> for both permissions. This list updates on its own.</>}
          </DialogDescription>
        </DialogHeader>
        {snapshot && ["unsupported", "unavailable"].includes(snapshot.readiness)
          ? <p role="alert" className="text-sm text-red-11">{snapshot.detail}</p>
          : (
            <ol className="text-sm">
              {permissions.map((permission) => {
                const on = verified?.[permission.id] === true
                const openedAt = opened[permission.id]
                const stuck = !on && openedAt !== undefined && now - openedAt > STUCK_AFTER_MS
                return (
                  <Row key={permission.id} testId={`session-computer-permission-${permission.id}`} done={on} waiting={!on && openedAt !== undefined} title={permission.title} detail={permission.purpose}>
                    {!on ? (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <Button size="sm" variant={nextPermission === permission.id ? "default" : "outline"} disabled={busy !== null || !verified} aria-busy={busy === permission.id} onClick={() => open(permission.id)}>
                          Open {permission.title}
                        </Button>
                        {stuck ? (snapshot?.entry.ours
                          ? <Button size="sm" variant="ghost" disabled={busy !== null} aria-busy={busy === "reset"} data-testid={`session-computer-reset-${permission.id}`} onClick={() => onReset(permission.id)}>Already on? Reset and ask again</Button>
                          : <span className="text-xs text-muted-foreground">Already on? Remove {entry} from the list with the minus button, then add it again.</span>) : null}
                      </div>
                    ) : null}
                  </Row>
                )
              })}
            </ol>
          )}
        {readError ? <p role="alert" className="text-xs text-red-11">Couldn't check this Mac. {readError}</p> : null}
        {actionError ? <p role="alert" className="text-xs text-red-11">{actionError}</p> : null}
        {!done ? (
          <details className="text-xs leading-relaxed text-muted-foreground">
            <summary className="cursor-pointer text-foreground">What these permissions allow</summary>
            <p className="mt-2">macOS grants them to {entry}, which runs the OpenWork Computer Use helper. The agent still sees the app window it is using, and its content goes to your AI model provider. If macOS offers Quit &amp; Reopen, choose Later: this list checks again on its own.</p>
          </details>
        ) : null}
        <DialogFooter>
          {!done ? <Button variant="ghost" disabled={busy !== null} onClick={onRefresh}>Check again</Button> : null}
          <Button variant={done ? "default" : "outline"} onClick={onClose}>{done ? "Done" : "Close"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
