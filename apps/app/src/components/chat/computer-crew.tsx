import { useEffect, useState } from "react"
import type { ComputerCrewMember } from "@openwork/types/desktop-ipc"

import { desktopBridge } from "@/app/lib/desktop"
import { Button } from "@/components/ui/button"

const POLL_MS = 1_500

const STATES: Record<ComputerCrewMember["state"], string> = {
  working: "Working",
  waiting: "Waiting for its turn",
  paused: "Paused for you",
  done: "Done",
}

/**
 * While `enabled`, the chat's subagents on its computer (`parallelComputerUse`), read from the
 * desktop with a live frame of each agent's app. Leaving stops the frames.
 */
export function useComputerCrew(sessionId: string, enabled: boolean): ComputerCrewMember[] {
  const [members, setMembers] = useState<ComputerCrewMember[]>([])
  useEffect(() => {
    if (!enabled) { setMembers([]); return }
    let current = true
    const read = () => {
      if (document.visibilityState !== "visible") return
      void desktopBridge.computerCrew(sessionId, true).then(next => { if (current) setMembers(next) }, () => {})
    }
    read()
    const timer = window.setInterval(read, POLL_MS)
    return () => {
      current = false
      window.clearInterval(timer)
      void desktopBridge.computerCrew(sessionId, false).catch(() => {})
    }
  }, [sessionId, enabled])
  return members
}

/** One row per agent: its cursor's name and color, app, state and latest step; a row opens its live view. */
export function ComputerCrew({ members, onOpen }: { members: readonly ComputerCrewMember[]; onOpen: (member: ComputerCrewMember) => void }) {
  if (!members.length) return null
  return (
    <ul data-computer-crew="" aria-label="Agents using the computer" className="space-y-1 border-t border-border px-1 py-1">
      {members.map(member => <li key={member.sessionId}>
        <Button variant="ghost" data-computer-crew-member={member.state} aria-label={`Watch ${member.name} live`}
          className="h-auto w-full min-w-0 justify-start gap-3 px-2 py-1.5 text-left" onClick={() => onOpen(member)}>
          <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: member.color }} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{member.name}{member.app ? <span className="font-normal text-muted-foreground"> · {member.app}</span> : null}</span>
            <span className="block truncate text-xs font-normal text-muted-foreground">
              <span data-computer-crew-state="">{STATES[member.state]}</span>{member.intent && member.state !== "done" ? <> · {member.intent}</> : null}
            </span>
          </span>
          {member.frame ? <img src={`data:${member.frame.mimeType};base64,${member.frame.data}`} alt="" className="h-10 w-16 shrink-0 rounded object-contain" decoding="async" /> : null}
        </Button>
      </li>)}
    </ul>
  )
}

/** The crew alone, for a chat whose own turn used no computer steps. */
export function ComputerCrewCard({ members, onOpen }: { members: readonly ComputerCrewMember[]; onOpen: (member: ComputerCrewMember) => void }) {
  if (!members.length) return null
  return (
    <div data-computer-crew-card="" role="group" aria-label="Agents using the computer" className="w-full min-w-0 overflow-hidden rounded-xl border border-border bg-background">
      <p className="px-3 pt-3 pb-2 text-sm font-medium">{members.some(member => member.state !== "done") ? "Agents using computer" : "Agents used computer"}</p>
      <ComputerCrew members={members} onOpen={onOpen} />
    </div>
  )
}
