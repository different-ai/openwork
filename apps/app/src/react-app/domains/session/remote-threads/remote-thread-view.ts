import type { RemoteSessionThreadState } from "@openwork/types/automations"

import { formatRelativeTime } from "@/app/utils"
import { t } from "@/i18n"
import type { RemoteThreadStart } from "@/lib/remote-session-thread"
import { formatElapsedSeconds } from "@/lib/tool-call-duration"
import type { RemoteThreadEntry } from "./remote-thread-store"

/** One reading of a task for its row and its panel, so both always say the same thing. */
export type RemoteThreadView = {
  title: string
  /** Where it runs: "Cloud computer", the computer's name, or "your computer". */
  computer: string
  state: RemoteSessionThreadState
  waitingFor: "permission" | "question" | null
  stopped: boolean
  /** The state line, e.g. "Working 1m 20s" or "Completed · The notes cover…". */
  status: string
  /** Set when Den couldn't confirm the state lately; the row shows the last known one. */
  lastChecked: string | null
  active: boolean
  /** A session exists to read, follow up on, or stop. */
  started: boolean
  /** The step it ran last while it works, e.g. "Read manifest.md"; null when Den doesn't say. */
  latestStep: string | null
  /** How long it has worked, or worked in total once finished; null when the chat doesn't know when it started. */
  elapsed: string | null
}

const STOPPED = /abort|interrupt|cancel/i

export function remoteThreadView(start: RemoteThreadStart, entry: RemoteThreadEntry | null, now: number, stoppedHere = false): RemoteThreadView {
  const status = entry?.status ?? null
  // Before the first answer: Cloud tasks are already running, others wait for their computer.
  const state: RemoteSessionThreadState = status?.state ?? (start.target === "cloud" ? "running" : "starting")
  const computer = start.target === "cloud"
    ? t("session.remote_task_cloud")
    : status?.computerLabel ?? t("session.remote_task_your_computer")
  const error = status?.error ?? null
  const stopped = state === "error" && (stoppedHere || STOPPED.test(`${error?.code ?? ""} ${error?.message ?? ""}`))
  const waitingFor = state === "waiting" ? status?.waitingFor ?? "question" : null
  const since = entry?.activeSince ?? null
  const settledAt = state === "idle" || state === "error" ? status?.observedAt ?? null : now
  const elapsedSeconds = since === null || settledAt === null ? null : Math.max(0, Math.floor((settledAt - since) / 1000))
  const elapsed = elapsedSeconds === null ? "" : formatElapsedSeconds(elapsedSeconds)
  const line = state === "starting" ? t("session.remote_task_starting", { computer })
    : waitingFor === "permission" ? t("session.remote_task_permission", { computer })
    : waitingFor === "question" ? t("session.remote_task_question", { computer })
    : state === "idle" ? [t("session.remote_task_completed"), status?.preview].filter(Boolean).join(" · ")
    : state === "error" ? stopped ? t("session.remote_task_stopped") : error?.message ?? t("session.remote_task_stopped")
    : t("session.remote_task_working", { elapsed }).trim()
  return {
    title: status?.title && status.title !== "Remote session" ? status.title : start.title,
    computer,
    state,
    waitingFor,
    stopped,
    status: line,
    lastChecked: entry?.stale && entry.checkedAt ? t("session.remote_task_last_checked", { time: formatRelativeTime(entry.checkedAt) }) : null,
    active: state !== "idle" && state !== "error",
    started: Boolean(status?.sessionId ?? start.sessionId),
    latestStep: state === "running" || state === "waiting" ? status?.latestStep ?? null : null,
    elapsed: elapsed || null,
  }
}

export type RemoteThreadSentenceTone = "starting" | "running" | "waiting" | "done" | "stopped" | "failed"

/**
 * The parent chat's row for a task, as one sentence like a local helper's:
 * "Working on Studio computer · Check the release notes", then
 * "12m 4s, last ran: Read v1.1.md". Waiting reads "Waiting for you on …",
 * finished "Finished in the Cloud · …" with how long it took.
 */
export type RemoteThreadSentence = {
  tone: RemoteThreadSentenceTone
  lead: string
  title: string
  detail: string | null
}

export function remoteThreadSentence(start: RemoteThreadStart, view: RemoteThreadView): RemoteThreadSentence {
  const place = start.target === "cloud"
    ? t("session.remote_task_place_cloud")
    : t("session.remote_task_place_computer", { computer: view.computer })
  const tone: RemoteThreadSentenceTone = view.state === "starting" ? "starting"
    : view.state === "waiting" ? "waiting"
    : view.state === "idle" ? "done"
    : view.state === "error" ? view.stopped ? "stopped" : "failed"
    : "running"
  // Static keys, so the i18n audit can see every string this row uses.
  const lead = tone === "starting" ? t("session.remote_task_row_starting", { place })
    : tone === "waiting" ? t("session.remote_task_row_waiting", { place })
    : tone === "done" ? t("session.remote_task_row_done", { place })
    : tone === "stopped" ? t("session.remote_task_row_stopped", { place })
    : tone === "failed" ? t("session.remote_task_row_failed", { place })
    : t("session.remote_task_row_running", { place })
  const detail = tone === "running"
    ? view.elapsed && view.latestStep ? t("session.remote_task_row_last_ran", { elapsed: view.elapsed, step: view.latestStep })
      : view.latestStep ? t("session.remote_task_row_last_ran_only", { step: view.latestStep }) : view.elapsed
    : tone === "waiting" ? t(view.waitingFor === "permission" ? "session.remote_task_row_needs_approval" : "session.remote_task_row_has_question")
    : tone === "done" ? view.elapsed
    : tone === "failed" ? view.status
    : null
  return { tone, lead, title: view.title, detail: detail ? [detail, view.lastChecked].filter(Boolean).join(" · ") : view.lastChecked }
}

/** The word for a task in the Agents list and the sidebar (DESIGN.md: a word, not a dot). */
export function remoteThreadStatusWord(state: RemoteSessionThreadState, stopped: boolean): string {
  return state === "waiting" ? t("session.remote_task_status_needs_you")
    : state === "idle" ? t("session.remote_task_status_done")
    : state === "error" ? t(stopped ? "session.remote_task_status_stopped" : "session.remote_task_status_failed")
    : t("session.remote_task_status_working")
}
