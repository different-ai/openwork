"use client"

import { useEffect, useState } from "react"

import { t } from "@/i18n"
import type { RemoteThreadStart } from "@/lib/remote-session-thread"
import { AgentTrackerRow, type AgentTrackerKind } from "@/react-app/domains/session/surface/composer/agent-tracker-row"
import { stopRemoteThread } from "./remote-thread-actions"
import { useFollowRemoteThread, useRemoteThread, type RemoteThreadOwner } from "./remote-thread-store"
import { remoteThreadView } from "./remote-thread-view"

/** How the composer's Agents list counts a row; the same kinds as a local helper. */
export type RemoteTrackerKind = AgentTrackerKind

/**
 * `remoteSessionHelperView` in the composer's Agents list: a task the turn
 * started on another computer, drawn by the same row as a local helper, with
 * the same words, time, Review, Stop and Open. Name = where it runs, task =
 * its title.
 */
export function RemoteTrackerRow({ start, owner, startedAt, onKind, onOpen }: {
  start: RemoteThreadStart
  owner: RemoteThreadOwner
  startedAt: number | null
  onKind: (id: string, kind: RemoteTrackerKind) => void
  onOpen?: (start: RemoteThreadStart) => void
}) {
  useFollowRemoteThread(start, owner, startedAt)
  const entry = useRemoteThread(start.key)
  const [stopping, setStopping] = useState(false)
  const [stoppedHere, setStoppedHere] = useState(false)
  // The time ticks like a local helper's while the task works.
  const [now, setNow] = useState(() => Date.now())
  const view = remoteThreadView(start, entry, now, stoppedHere)
  useEffect(() => {
    if (!view.active) return
    const interval = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(interval)
  }, [view.active])
  const kind: RemoteTrackerKind = view.state === "waiting" ? "attention"
    : view.state === "idle" ? "done"
    : view.state === "error" ? view.stopped ? "stopped" : "error"
    : "working"
  useEffect(() => { onKind(start.key, kind) }, [kind, onKind, start.key])

  const canStop = Boolean(entry && view.active && view.started)
  const stop = () => {
    if (!entry) return
    setStopping(true)
    void stopRemoteThread(entry).then((failure) => {
      if (!failure) setStoppedHere(true)
    }).finally(() => setStopping(false))
  }

  return (
    <AgentTrackerRow
      id={start.key}
      name={view.computer}
      task={view.title}
      status={{
        kind,
        elapsed: view.elapsed,
        workingNote: view.state === "starting" ? "starting" : null,
        waitingFor: view.waitingFor,
        stopping,
        shimmer: kind === "working",
      }}
      onOpen={onOpen ? () => onOpen(start) : undefined}
      openLabel={t("session.remote_task_tracker_open", { title: view.title, computer: view.computer })}
      onStop={canStop ? stop : undefined}
      stopLabel={t("session.remote_task_stop", { title: view.title })}
      rowAttributes={{ "data-subagent-tracker-remote": "" }}
    />
  )
}
