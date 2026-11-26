"use client"

import { useEffect, useState } from "react"

import { t } from "@/i18n"
import type { RemoteThreadStart } from "@/lib/remote-session-thread"
import { AgentTrackerRow, type AgentTrackerKind } from "@/react-app/domains/session/surface/composer/agent-tracker-row"
import { stopRemoteThread } from "./remote-thread-actions"
import { useFollowRemoteThread, useRemoteThread, type RemoteThreadOwner } from "./remote-thread-store"
import { remoteThreadView } from "./remote-thread-view"

export type RemoteTrackerKind = AgentTrackerKind

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
  const [now, setNow] = useState(() => Date.now())
  const stale = entry?.stale ?? false
  const view = remoteThreadView(start, entry, stale ? entry?.checkedAt ?? now : now, stoppedHere)
  const ticking = view.active && !stale
  useEffect(() => {
    if (!ticking) return
    const update = () => setNow(Date.now())
    update()
    const interval = window.setInterval(update, 1_000)
    return () => window.clearInterval(interval)
  }, [ticking])
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
        workingNote: stale ? "reconnecting" : view.state === "starting" ? "starting" : null,
        waitingFor: view.waitingFor,
        stopping,
        shimmer: view.state === "running" && !stale,
        lastChecked: view.lastChecked,
      }}
      onOpen={onOpen ? () => onOpen(start) : undefined}
      openLabel={t("session.remote_task_tracker_open", { title: view.title, computer: view.computer })}
      onStop={canStop ? stop : undefined}
      stopLabel={t("session.remote_task_stop", { title: view.title })}
      rowAttributes={{ "data-subagent-tracker-remote": "" }}
    />
  )
}
