"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { isToolUIPart, type UIMessage } from "ai"
import { ChevronRight } from "lucide-react"

import {
  agentName,
  useElapsedSeconds,
  useSubagentRunState,
} from "@/components/chat/subagent-run-line"
import { isTaskToolPart, type TaskToolPart } from "@/lib/build-in-tools"
import { REMOTE_SESSION_STATUS_THREADS_MAX } from "@openwork/types/automations"
import { readDenSettings } from "@/app/lib/den"
import {
  remoteFollowUpMatches,
  remoteToolCallStartedAt,
  type RemoteThreadFollowUp,
  type RemoteThreadStart,
} from "@/lib/remote-session-thread"
import { remoteThreadFollowUpsInParts, remoteThreadStartsInParts } from "@/lib/remote-thread-starts"
import { RemoteTrackerRow } from "@/react-app/domains/session/remote-threads/remote-tracker-row"
import {
  REMOTE_THREAD_FOLLOW_MAX_MS,
  remoteThreadAwaitingFollowUp,
  reviveRemoteThreads,
  useRemoteThreadStore,
  type RemoteThreadEntry,
  type RemoteThreadOwner,
} from "@/react-app/domains/session/remote-threads/remote-thread-store"
import { formatElapsedSeconds } from "@/lib/tool-call-duration"
import { cn } from "@/lib/utils"
import { t } from "@/i18n"
import { AgentTrackerRow, type AgentTrackerKind } from "./agent-tracker-row"

/** What the person needs to know about one agent, in the order the header reports it. */
export type SubagentTrackerKind = AgentTrackerKind

/** Interaction cards (approval, question) the Review action brings into focus. */
export const COMPOSER_INTERACTION_SELECTOR = "[data-composer-interaction]"

function currentTurnStart(messages: readonly UIMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === "user") return index + 1
  }
  return 0
}

/** Sub-agent tasks the current turn started: everything after the latest message the person sent. */
export function currentTurnSubagentParts(messages: readonly UIMessage[]): TaskToolPart[] {
  const start = currentTurnStart(messages)
  const seen = new Set<string>()
  const parts: TaskToolPart[] = []
  for (const message of messages.slice(start)) {
    if (message.role !== "assistant") continue
    for (const part of message.parts) {
      if (!isToolUIPart(part) || !isTaskToolPart(part) || seen.has(part.toolCallId)) continue
      seen.add(part.toolCallId)
      parts.push(part)
    }
  }
  return parts
}

/** A task the current turn started on another computer (`remoteSessionHelperView`). */
export type RemoteTrackerTask = { start: RemoteThreadStart; startedAt: number | null }

/** Tasks the current turn started on other computers, directly or from a script, once each. */
export function currentTurnRemoteTasks(messages: readonly UIMessage[]): RemoteTrackerTask[] {
  const seen = new Set<string>()
  const tasks: RemoteTrackerTask[] = []
  for (const message of messages.slice(currentTurnStart(messages))) {
    if (message.role !== "assistant") continue
    for (const { start, part } of remoteThreadStartsInParts(message.parts)) {
      if (seen.has(start.key)) continue
      seen.add(start.key)
      tasks.push({ start, startedAt: remoteToolCallStartedAt(part) })
    }
  }
  return tasks
}

/** A conversation's tasks on other computers, as the Agents list needs them. */
export type ConversationRemoteTasks = {
  /** Started by the current turn: always listed, as before. */
  current: RemoteTrackerTask[]
  /** Started by an earlier turn and recent enough to still be followed, newest first: listed while they work or wait, or once this turn follows up on them. */
  earlier: RemoteTrackerTask[]
  /** Follow-ups the current turn sent that their computer accepted. */
  followUps: RemoteThreadFollowUp[]
}

function latest(left: number | null, right: number | null): number | null {
  return left === null ? right : right === null ? left : Math.max(left, right)
}

/**
 * Every task the conversation started on other computers, directly or from
 * a script, once each. An earlier turn's task is a candidate only while Den
 * would still follow it (6 hours after it last got work), and at most as
 * many as one status call checks, so reopening a long chat costs one call.
 */
export function conversationRemoteTasks(messages: readonly UIMessage[], now = Date.now()): ConversationRemoteTasks {
  const turnStart = currentTurnStart(messages)
  const current = currentTurnRemoteTasks(messages)
  const currentKeys = new Set(current.map((task) => task.start.key))
  const earlier = new Map<string, RemoteTrackerTask>()
  const allFollowUps: RemoteThreadFollowUp[] = []
  const followUps: RemoteThreadFollowUp[] = []
  messages.forEach((message, index) => {
    if (message.role !== "assistant") return
    if (index < turnStart) {
      for (const { start, part } of remoteThreadStartsInParts(message.parts)) {
        if (!currentKeys.has(start.key) && !earlier.has(start.key)) earlier.set(start.key, { start, startedAt: remoteToolCallStartedAt(part) })
      }
    }
    const sent = remoteThreadFollowUpsInParts(message.parts)
    allFollowUps.push(...sent)
    if (index >= turnStart) followUps.push(...sent)
  })
  const candidates = [...earlier.values()]
    // The task last got work when it started or was last followed up.
    .map((task) => ({
      ...task,
      startedAt: allFollowUps.filter((followUp) => remoteFollowUpMatches(followUp, task.start, null))
        .reduce<number | null>((at, followUp) => latest(at, followUp.sentAt), task.startedAt),
    }))
    .filter((task) => task.startedAt === null || now - task.startedAt <= REMOTE_THREAD_FOLLOW_MAX_MS)
    .reverse()
    .sort((left, right) => (right.startedAt ?? 0) - (left.startedAt ?? 0))
    .slice(0, REMOTE_SESSION_STATUS_THREADS_MAX)
  return { current, earlier: candidates, followUps }
}

function remoteEntryListed(entry: RemoteThreadEntry, followUps: readonly RemoteThreadFollowUp[], now: number): boolean {
  // Until Den answers, an earlier task may long be finished: list it only once its state is known.
  if (!entry.status) return false
  if (followUps.some((followUp) => remoteFollowUpMatches(followUp, entry.start, entry.status?.sessionId ?? null))) return true
  if (remoteThreadAwaitingFollowUp(entry, now)) return true
  const state = entry.status?.state
  return state !== undefined && state !== "idle" && state !== "error"
}

/**
 * Which of a conversation's tasks the Agents list shows: the current turn's,
 * plus an earlier turn's task while it still works or waits on the person,
 * or once this turn sent it a follow-up. Earlier tasks are followed (not
 * shown) until Den says which they are, so a finished task never flashes and
 * reopening the chat finds the ones still working. A follow-up the agent just
 * sent revives its task, however the agent sent it.
 */
export function selectComposerRemoteTasks(
  tasks: ConversationRemoteTasks,
  threads: Readonly<Record<string, RemoteThreadEntry>>,
  organizationId: string | null,
  now: number,
  owner?: RemoteThreadOwner,
): RemoteTrackerTask[] {
  const listable = (entry: RemoteThreadEntry | undefined): entry is RemoteThreadEntry =>
    Boolean(entry && organizationId && entry.organizationId === organizationId && remoteEntryListed(entry, tasks.followUps, now))
  const listed = tasks.earlier.filter((task) => listable(threads[task.start.key]))
  // A task this window already follows for this conversation, whose start is
  // outside the loaded history (a long chat opens on its newest page): the
  // sidebar lists it under the chat, so the Agents list does too.
  const known = new Set([...tasks.earlier, ...tasks.current].map((task) => task.start.key))
  const ownerKey = owner ? `${owner.workspaceId}:${owner.sessionId}` : null
  const followed = ownerKey === null ? [] : Object.values(threads)
    .filter((entry) => !known.has(entry.start.key) && Object.hasOwn(entry.owners, ownerKey) && listable(entry))
    .sort((left, right) => (left.activeSince ?? left.firstSeenAt) - (right.activeSince ?? right.firstSeenAt))
    .map((entry) => ({ start: entry.start, startedAt: entry.activeSince }))
  // Oldest first, in the order the conversation started them.
  return [...followed, ...listed.reverse(), ...tasks.current]
}

const NO_FOLLOW_UPS: readonly RemoteThreadFollowUp[] = []

/** The Agents list's tasks on other computers for one conversation, following earlier ones while it is open. */
export function useComposerRemoteTasks(messages: readonly UIMessage[], owner: RemoteThreadOwner, enabled: boolean): RemoteTrackerTask[] {
  const tasks = useMemo<ConversationRemoteTasks>(
    () => enabled ? conversationRemoteTasks(messages) : { current: [], earlier: [], followUps: [] },
    [enabled, messages],
  )
  const organizationId = readDenSettings().activeOrgId?.trim() || null
  const { workspaceId, sessionId } = owner
  const earlierSignature = tasks.earlier.map((task) => task.start.key).join("\n")
  const latestTasks = useRef(tasks)
  latestTasks.current = tasks
  // Follow earlier tasks while the conversation is open, so their state is known before they are listed.
  useEffect(() => {
    if (!earlierSignature || !organizationId) return
    const store = useRemoteThreadStore.getState()
    const stops = latestTasks.current.earlier.map((task) => store.watch(task.start, { owner: { workspaceId, sessionId }, organizationId, startedAt: task.startedAt }))
    return () => { for (const stop of stops) stop() }
  }, [earlierSignature, organizationId, workspaceId, sessionId])
  // The current turn's accepted follow-ups revive their task once its entry can be matched (a registered task's sessionId arrives with its status).
  const followUps = tasks.followUps.length > 0 ? tasks.followUps : NO_FOLLOW_UPS
  const matchSignature = useRemoteThreadStore((state) => followUps.length === 0 ? ""
    : Object.values(state.threads).map((entry) => `${entry.start.key}=${entry.status?.sessionId ?? entry.start.sessionId ?? ""}`).sort().join("\n"))
  useEffect(() => {
    if (followUps.length > 0) reviveRemoteThreads(followUps)
  }, [followUps, matchSignature])
  // A string that changes only when the listed set does: status updates that change nothing here never re-render the chat.
  const listedSignature = useRemoteThreadStore((state) => enabled
    ? selectComposerRemoteTasks(tasks, state.threads, organizationId, Date.now(), owner).map((task) => task.start.key).join("\n") : "")
  return useMemo(() => {
    if (!listedSignature) return []
    const keys = new Set(listedSignature.split("\n"))
    const threads = useRemoteThreadStore.getState().threads
    return selectComposerRemoteTasks(tasks, threads, organizationId, Date.now(), { workspaceId, sessionId })
      .filter((task) => keys.has(task.start.key))
  }, [tasks, listedSignature, organizationId, workspaceId, sessionId])
}

/** The header's counts, attention first; empty groups are left out. */
export function subagentTrackerSummary(kinds: readonly SubagentTrackerKind[]): { kind: SubagentTrackerKind; text: string }[] {
  const count = (kind: SubagentTrackerKind) => kinds.filter((value) => value === kind).length
  const attention = count("attention")
  const working = count("working")
  const error = count("error")
  const done = count("done") + count("stopped")
  return [
    attention ? { kind: "attention" as const, text: t("session.subagent_tracker_summary_attention", { count: attention }) } : null,
    working ? { kind: "working" as const, text: t("session.subagent_tracker_summary_working", { count: working }) } : null,
    error ? { kind: "error" as const, text: t("session.subagent_tracker_summary_error", { count: error }) } : null,
    done ? { kind: "done" as const, text: t("session.subagent_tracker_summary_done", { count: done }) } : null,
  ].filter((entry) => entry !== null)
}

type ComposerSubagentTrackerProps = {
  messages: readonly UIMessage[]
  workspaceId: string
  /** The parent turn is still running. Once it ends and every agent has settled, the list goes away. */
  parentActive: boolean
  syncDegraded: boolean
  onOpenSubagentSession?: (sessionId: string) => void
  onStopSubagentSession?: (sessionId: string) => void | Promise<void>
  /** Local helpers are listed only where their state can be followed (OpenCode v2); defaults to true. */
  includeLocal?: boolean
  /** Tasks the turn started on other computers, listed and counted with the local helpers. */
  remote?: {
    tasks: readonly RemoteTrackerTask[]
    owner: RemoteThreadOwner
    onOpen?: (start: RemoteThreadStart) => void
  }
}

const NO_REMOTE_TASKS: readonly RemoteTrackerTask[] = []

/**
 * The current turn's sub-agents, attached to the top of the composer so they
 * stay in view while their transcript rows scroll away. Local helpers and
 * tasks on other computers share one row (AgentTrackerRow): name, task, one
 * status word or time, then a fixed action lane (DESIGN.md OW-LIST, V2).
 */
export function ComposerSubagentTracker(props: ComposerSubagentTrackerProps) {
  const includeLocal = props.includeLocal !== false
  const parts = useMemo(() => includeLocal ? currentTurnSubagentParts(props.messages) : [], [includeLocal, props.messages])
  const remote = props.remote
  const remoteTasks = remote?.tasks ?? NO_REMOTE_TASKS
  const ids = [...parts.map((part) => part.toolCallId), ...remoteTasks.map((task) => task.start.key)]
  const [kinds, setKinds] = useState<Record<string, SubagentTrackerKind>>({})
  const [manualExpanded, setManualExpanded] = useState<boolean | null>(null)
  const report = useCallback((toolCallId: string, kind: SubagentTrackerKind) => {
    setKinds((current) => (current[toolCallId] === kind ? current : { ...current, [toolCallId]: kind }))
  }, [])
  const partIds = parts.map((part) => part.toolCallId).join("\n")
  // A new turn starts collapsed or expanded by its own rule again.
  const firstPartId = ids[0]
  useEffect(() => { setManualExpanded(null) }, [firstPartId])

  const current = ids.map((id) => kinds[id]).filter((kind) => kind !== undefined)
  const anyAttention = current.includes("attention")
  const settled = current.length === ids.length && current.every((kind) => kind === "done" || kind === "stopped" || kind === "error")
  const allQuiet = current.length === ids.length && current.every((kind) => kind === "done" || kind === "stopped")
  const expanded = manualExpanded ?? (anyAttention || (!allQuiet && ids.length <= 3))
  const summary = subagentTrackerSummary(current)

  if (ids.length === 0 || (!props.parentActive && settled)) return null
  // Reopening a finished turn: wait for every row's state before showing
  // anything, so a list that is about to go away never flashes.
  const unresolved = !props.parentActive && current.length < ids.length

  return (
    <div
      hidden={unresolved}
      data-subagent-tracker
      data-subagent-tracker-count={ids.length}
      data-subagent-tracker-expanded={expanded ? "true" : "false"}
      data-subagent-tracker-parts={partIds}
      className="overflow-hidden bg-transparent"
    >
      <button
        type="button"
        data-testid="subagent-tracker-toggle"
        aria-expanded={expanded}
        className="group/toggle flex w-full cursor-pointer items-center gap-1.5 px-4 pt-3 pb-1.5 text-start text-xs"
        onClick={() => setManualExpanded(!expanded)}
      >
        <span className="shrink-0 font-medium text-gray-12">{t("session.subagent_tracker_label")}</span>
        <span data-subagent-tracker-summary className="min-w-0 truncate text-gray-9 transition-colors group-hover/toggle:text-gray-11">
          {summary.map((entry, index) => (
            <span key={entry.kind} className={cn(entry.kind === "attention" && "font-medium text-amber-11")}>
              {index > 0 ? ", " : ""}{entry.text}
            </span>
          ))}
        </span>
        <ChevronRight
          aria-hidden="true"
          size={14}
          className={cn("shrink-0 text-gray-9 transition-transform duration-150 ease-out group-hover/toggle:text-gray-11 motion-reduce:transition-none", expanded && "rotate-90")}
        />
      </button>
      {/* Rows stay mounted while collapsed so the header's counts stay live. */}
      <div hidden={!expanded} className="max-h-44 overflow-y-auto pt-0.5 pb-2">
        {parts.map((part) => (
          <SubagentTrackerRow
            key={part.toolCallId}
            part={part}
            workspaceId={props.workspaceId}
            parentActive={props.parentActive}
            syncDegraded={props.syncDegraded}
            onOpenSubagentSession={props.onOpenSubagentSession}
            onStopSubagentSession={props.onStopSubagentSession}
            onKind={report}
          />
        ))}
        {remote ? remoteTasks.map((task) => (
          <RemoteTrackerRow
            key={task.start.key}
            start={task.start}
            startedAt={task.startedAt}
            owner={remote.owner}
            onKind={report}
            onOpen={remote.onOpen}
          />
        )) : null}
      </div>
      {/* Inset hairline between the list and the message, on the composer text's edges. */}
      <div aria-hidden="true" className={cn("mx-4 h-px bg-dls-border", !expanded && "mt-1.5")} />
    </div>
  )
}

function focusComposerInteraction(): boolean {
  const card = document.querySelector<HTMLElement>(COMPOSER_INTERACTION_SELECTOR)
  if (!card) return false
  card.scrollIntoView({ block: "nearest" })
  const first = card.querySelector<HTMLElement>("button:not([disabled]), [href], input, textarea, [tabindex]:not([tabindex='-1'])")
  ;(first ?? card).focus()
  return true
}

function SubagentTrackerRow(props: {
  part: TaskToolPart
  workspaceId: string
  parentActive: boolean
  syncDegraded: boolean
  onOpenSubagentSession?: (sessionId: string) => void
  onStopSubagentSession?: (sessionId: string) => void | Promise<void>
  onKind: (toolCallId: string, kind: SubagentTrackerKind) => void
}) {
  const { part, onKind } = props
  const [stopping, setStopping] = useState(false)
  const stoppedByPerson = useRef(false)
  const state = useSubagentRunState(part, props.parentActive, props.workspaceId, props.syncDegraded)
  const elapsedSeconds = useElapsedSeconds(state.inFlight, state.startedAt, props.syncDegraded, part.toolCallId)
  const agent = agentName(part.input?.subagent_type ?? "")
  const task = part.input?.description?.trim().slice(0, 160) || t("session.subagent_task")
  const stopped = (stoppedByPerson.current || state.stoppedByError) && !state.childRunning
  const kind: SubagentTrackerKind = state.activity === "waiting-permission" || state.activity === "waiting-question" ? "attention"
    : stopped ? "stopped"
    : state.activity === "failed" ? "error"
    : state.activity === "completed" ? "done"
    : "working"
  useEffect(() => { onKind(part.toolCallId, kind) }, [kind, onKind, part.toolCallId])

  const childSessionId = state.childSessionId
  const canOpen = Boolean(childSessionId && props.onOpenSubagentSession)
  const canStop = Boolean(childSessionId && state.childRunning && props.onStopSubagentSession)

  const open = () => {
    if (childSessionId) props.onOpenSubagentSession?.(childSessionId)
  }
  const stop = () => {
    if (!childSessionId || !props.onStopSubagentSession) return
    setStopping(true)
    void Promise.resolve()
      .then(() => props.onStopSubagentSession?.(childSessionId))
      .then(() => { stoppedByPerson.current = true }, () => {})
      .finally(() => setStopping(false))
  }
  const review = () => {
    // Approvals and answers for a sub-agent already sit above the composer;
    // without one there, the agent's own chat is where it waits.
    if (!focusComposerInteraction()) open()
  }

  return (
    <AgentTrackerRow
      id={part.toolCallId}
      name={agent}
      task={task}
      status={{
        kind,
        elapsed: formatElapsedSeconds(elapsedSeconds),
        workingNote: state.activity === "retrying" ? "retrying" : state.activity === "reconnecting" ? "reconnecting" : null,
        waitingFor: state.activity === "waiting-permission" ? "permission" : state.activity === "waiting-question" ? "question" : null,
        stopping,
        shimmer: state.activity === "shimmer",
      }}
      onOpen={canOpen ? open : undefined}
      openLabel={t("session.subagent_tracker_open", { agent })}
      onStop={canStop ? stop : undefined}
      stopLabel={t("session.subagent_tracker_stop", { agent })}
      onReview={review}
      rowAttributes={{
        "data-subagent-activity": state.activity,
        ...(childSessionId ? { "data-subagent-session-id": childSessionId } : {}),
      }}
    />
  )
}
