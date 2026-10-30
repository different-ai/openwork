"use client"

import { useEffect, useState } from "react"

import { Button } from "@/components/ui/button"
import { t } from "@/i18n"
import type { RemoteThreadStart } from "@/lib/remote-session-thread"
import { cn } from "@/lib/utils"
import { useTextActivityRail } from "@/components/chat/text-activity-rail-store"
import { stopRemoteThread } from "./remote-thread-actions"
import { useFollowRemoteThread, useRemoteThread, type RemoteThreadOwner } from "./remote-thread-store"
import { remoteThreadStatusWord, remoteThreadView } from "./remote-thread-view"

/** How the composer's Agents list counts a row; mirrors its local helper kinds. */
export type RemoteTrackerKind = "attention" | "working" | "error" | "done" | "stopped"

/**
 * `remoteSessionHelperView` in the composer's Agents list: a task the turn
 * started on another computer, in the same row shape as a local helper so
 * the two read as one list. Agent = where it runs (plain text), task = its
 * title, then a status word and `Open` / `Stop` as small text buttons.
 */
export function RemoteTrackerRow({ start, owner, startedAt, onKind, onOpen }: {
  start: RemoteThreadStart
  owner: RemoteThreadOwner
  startedAt: number | null
  onKind: (id: string, kind: RemoteTrackerKind) => void
  onOpen?: (start: RemoteThreadStart) => void
}) {
  useFollowRemoteThread(start, owner, startedAt)
  const textRail = useTextActivityRail()
  const entry = useRemoteThread(start.key)
  const [stopping, setStopping] = useState(false)
  const [stoppedHere, setStoppedHere] = useState(false)
  const view = remoteThreadView(start, entry, Date.now(), stoppedHere)
  const kind: RemoteTrackerKind = view.state === "waiting" ? "attention"
    : view.state === "idle" ? "done"
    : view.state === "error" ? view.stopped ? "stopped" : "error"
    : "working"
  useEffect(() => { onKind(start.key, kind) }, [kind, onKind, start.key])

  const word = stopping ? t("session.subagent_tracker_stopping") : remoteThreadStatusWord(view.state, view.stopped)
  const canStop = Boolean(entry && view.active && view.started)

  return (
    <div
      data-subagent-tracker-row={start.key}
      data-subagent-tracker-kind={kind}
      data-subagent-tracker-remote=""
      className="flex h-9 min-w-0 items-center gap-2.5 px-4 text-[13px]"
    >
      {/* The list's status dot, so remote and local rows share one left edge;
          text-first (textActivityRail) drops it for both, the word carries the state. */}
      {textRail ? null : <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center">
        <span className={cn(
          "size-1.5 rounded-full",
          kind === "attention" ? "bg-amber-9" : kind === "error" ? "bg-red-9" : kind === "stopped" || kind === "done" ? "bg-gray-6" : "bg-gray-9",
        )} />
      </span>}
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="shrink-0 font-medium text-gray-12" data-subagent-tracker-agent="">{view.computer}</span>
        <span data-subagent-tracker-task className="min-w-0 truncate text-gray-9 @max-[480px]/composer:hidden">{view.title}</span>
      </span>
      <span
        data-subagent-tracker-status
        className={cn(
          "shrink-0 text-xs",
          kind === "attention" ? "font-medium text-amber-11" : kind === "error" ? "text-red-11" : "text-gray-9",
        )}
      >
        {word}
      </span>
      <span className="flex shrink-0 items-center justify-end gap-0.5">
        {canStop && entry ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="text-gray-10 hover:text-gray-12"
            data-subagent-tracker-stop=""
            disabled={stopping}
            aria-label={t("session.remote_task_stop", { title: view.title })}
            onClick={() => {
              setStopping(true)
              void stopRemoteThread(entry).then((failure) => {
                if (!failure) setStoppedHere(true)
              }).finally(() => setStopping(false))
            }}
          >
            {t("session.remote_task_stop_short")}
          </Button>
        ) : null}
        {onOpen ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="text-gray-10 hover:text-gray-12"
            data-subagent-tracker-open=""
            aria-label={t("session.remote_task_tracker_open", { title: view.title, computer: view.computer })}
            onClick={() => onOpen(start)}
          >
            {t("session.remote_task_open_short")}
          </Button>
        ) : null}
      </span>
    </div>
  )
}
