"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { isToolUIPart, type UIMessage } from "ai"
import { ChevronRight } from "lucide-react"

import {
  agentName,
  useElapsedSeconds,
  useSubagentRunState,
} from "@/components/chat/subagent-run-line"
import { isTaskToolPart, taskChildSessionId, type TaskToolPart } from "@/lib/build-in-tools"
import { useSessionActivityStore, type SessionActivityStatus } from "@/react-app/domains/session/status/session-activity-store"
import { REMOTE_SESSION_STATUS_THREADS_MAX } from "@openwork/types/automations"
import {
  mergeRemoteThreadStart,
  remoteFollowUpMatches,
  type RemoteThreadFollowUp,
  type RemoteThreadStart,
} from "@/lib/remote-session-thread"
import {
  remoteThreadActivitiesInParts,
  remoteThreadFollowUpsInParts,
} from "@/lib/remote-thread-starts"
import { RemoteTrackerRow } from "@/react-app/domains/session/remote-threads/remote-tracker-row"
import {
  REMOTE_THREAD_FOLLOW_MAX_MS,
  fetchBoundRemoteSessions,
  remoteThreadAwaitingFollowUp,
  reviveRemoteThreads,
  useRemoteThreadOrganization,
  useRemoteThreadStore,
  type RemoteThreadEntry,
  type RemoteThreadOwner,
} from "@/react-app/domains/session/remote-threads/remote-thread-store"
import { useDesktopFeature } from "@/react-app/domains/session/status/use-desktop-feature"
import { formatElapsedSeconds } from "@/lib/tool-call-duration"
import { cn } from "@/lib/utils"
import { t } from "@/i18n"
import { AgentTrackerRow, type AgentTrackerKind } from "./agent-tracker-row"

export type SubagentTrackerKind = AgentTrackerKind

export const COMPOSER_INTERACTION_SELECTOR = "[data-composer-interaction]"

function currentTurnStart(messages: readonly UIMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === "user") return index + 1
  }
  return 0
}

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

export function earlierTurnSubagentParts(messages: readonly UIMessage[]): TaskToolPart[] {
  const start = currentTurnStart(messages)
  const seen = new Set<string>()
  const parts: TaskToolPart[] = []
  for (const message of messages.slice(0, start)) {
    if (message.role !== "assistant") continue
    for (const part of message.parts) {
      if (!isToolUIPart(part) || !isTaskToolPart(part) || seen.has(part.toolCallId)) continue
      seen.add(part.toolCallId)
      parts.push(part)
    }
  }
  return parts
}

function currentTurnKey(messages: readonly UIMessage[]): string {
  const start = currentTurnStart(messages)
  return start === 0 ? "" : messages[start - 1]?.id ?? ""
}

function childStillActive(status: SessionActivityStatus | undefined): boolean {
  return status !== undefined && status !== "idle" && status !== "error"
}

const NO_PARTS: readonly TaskToolPart[] = []

export function useComposerSubagentParts(
  messages: readonly UIMessage[],
  workspaceId: string,
  options: { enabled: boolean; keepEarlier: boolean },
): readonly TaskToolPart[] {
  const current = useMemo(() => options.enabled ? currentTurnSubagentParts(messages) : [], [options.enabled, messages])
  const earlier = useMemo(
    () => options.enabled && options.keepEarlier ? earlierTurnSubagentParts(messages) : [],
    [options.enabled, options.keepEarlier, messages],
  )
  const turnKey = currentTurnKey(messages)
  const candidates = earlier
    .map((part) => ({ part, childSessionId: taskChildSessionId(part) }))
    .filter((entry): entry is { part: TaskToolPart; childSessionId: string } => Boolean(entry.childSessionId))
  const activeSignature = useSessionActivityStore((state) => {
    const statuses = state.statusesByWorkspaceId[workspaceId]
    return candidates
      .filter((entry) => childStillActive(statuses?.[entry.childSessionId]))
      .map((entry) => entry.part.toolCallId)
      .join("\n")
  })
  const kept = useRef<{ turnKey: string; ids: Set<string> }>({ turnKey, ids: new Set() })
  const active = activeSignature ? activeSignature.split("\n") : []
  if (kept.current.turnKey !== turnKey) kept.current = { turnKey, ids: new Set(active) }
  else for (const id of active) kept.current.ids.add(id)
  const keptSignature = [...kept.current.ids].sort().join("\n")
  return useMemo(() => {
    const ids = new Set(keptSignature ? keptSignature.split("\n") : [])
    const listed = earlier.filter((part) => ids.has(part.toolCallId))
    if (listed.length === 0 && current.length === 0) return NO_PARTS
    return [...listed, ...current]
  }, [earlier, current, keptSignature])
}

export type RemoteTrackerTask = { start: RemoteThreadStart; startedAt: number | null }

export function currentTurnRemoteTasks(messages: readonly UIMessage[]): RemoteTrackerTask[] {
  const tasks = new Map<string, RemoteTrackerTask>()
  for (const message of messages.slice(currentTurnStart(messages))) {
    if (message.role !== "assistant") continue
    for (const { start, kind, startedAt } of remoteThreadActivitiesInParts(message.parts)) {
      if (kind !== "create" && kind !== "interaction") continue
      const existing = tasks.get(start.key)
      tasks.set(
        start.key,
        existing
          ? { start: mergeRemoteThreadStart(existing.start, start), startedAt: latest(existing.startedAt, startedAt) }
          : { start, startedAt },
      )
    }
  }
  return [...tasks.values()]
}

export type ConversationRemoteTasks = {
  current: RemoteTrackerTask[]
  earlier: RemoteTrackerTask[]
  followUps: RemoteThreadFollowUp[]
}

function latest(left: number | null, right: number | null): number | null {
  return left === null ? right : right === null ? left : Math.max(left, right)
}

export function conversationRemoteTasks(messages: readonly UIMessage[], now = Date.now()): ConversationRemoteTasks {
  const turnStart = currentTurnStart(messages)
  const currentMap = new Map<string, RemoteTrackerTask>()
  for (const task of currentTurnRemoteTasks(messages)) currentMap.set(task.start.key, task)
  const earlier = new Map<string, RemoteTrackerTask>()
  const allFollowUps: RemoteThreadFollowUp[] = []
  const followUps: RemoteThreadFollowUp[] = []
  messages.forEach((message, index) => {
    if (message.role !== "assistant") return
    if (index < turnStart) {
      for (const { start, kind, startedAt } of remoteThreadActivitiesInParts(message.parts)) {
        if (kind !== "create" && kind !== "interaction") continue
        const currentTask = currentMap.get(start.key)
        if (currentTask) {
          currentMap.set(start.key, {
            start: kind === "create" ? mergeRemoteThreadStart(start, currentTask.start) : mergeRemoteThreadStart(currentTask.start, start),
            startedAt: latest(currentTask.startedAt, startedAt),
          })
          continue
        }
        const existing = earlier.get(start.key)
        earlier.set(
          start.key,
          existing
            ? {
                start: kind === "create" ? mergeRemoteThreadStart(start, existing.start) : mergeRemoteThreadStart(existing.start, start),
                startedAt: latest(existing.startedAt, startedAt),
              }
            : { start, startedAt },
        )
      }
    }
    const sent = remoteThreadFollowUpsInParts(message.parts)
    allFollowUps.push(...sent)
    if (index >= turnStart) followUps.push(...sent)
  })
  const current = [...currentMap.values()]
  const candidates = [...earlier.values()]
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

function remoteEntryListed(
  entry: RemoteThreadEntry,
  followUps: readonly RemoteThreadFollowUp[],
  now: number,
  includeSettled = false,
): boolean {
  if (!entry.status) return false
  if (followUps.some((followUp) => remoteFollowUpMatches(followUp, entry.start, entry.status?.sessionId ?? null))) return true
  if (remoteThreadAwaitingFollowUp(entry, now)) return true
  const state = entry.status?.state
  if (includeSettled && state === "idle") return true
  return state !== undefined && state !== "idle" && state !== "error"
}

export function selectComposerRemoteTasks(
  tasks: ConversationRemoteTasks,
  threads: Readonly<Record<string, RemoteThreadEntry>>,
  organizationId: string | null,
  now: number,
  owner?: RemoteThreadOwner,
  options?: ReadonlySet<string> | { retained?: ReadonlySet<string>; includeSettled?: boolean },
): RemoteTrackerTask[] {
  const retained = options ? ("has" in options ? options : options.retained) : undefined
  const includeSettled = options && !("has" in options) ? options.includeSettled === true : false
  const listable = (entry: RemoteThreadEntry | undefined): entry is RemoteThreadEntry =>
    Boolean(entry && organizationId && entry.organizationId === organizationId
      && (retained?.has(entry.start.key) || remoteEntryListed(entry, tasks.followUps, now, includeSettled)))
  const listed = tasks.earlier.filter((task) => listable(threads[task.start.key]))
  const known = new Set([...tasks.earlier, ...tasks.current].map((task) => task.start.key))
  const owned = !owner ? [] : Object.values(threads)
    .filter((entry) => !known.has(entry.start.key)
      && Object.values(entry.owners).some((candidate) => candidate.sessionId === owner.sessionId)
      && listable(entry))
    .sort((left, right) => (left.activeSince ?? left.firstSeenAt) - (right.activeSince ?? right.firstSeenAt))
    .map((entry) => ({ start: entry.start, startedAt: entry.activeSince }))
  return [...owned, ...listed.reverse(), ...tasks.current]
}

const NO_FOLLOW_UPS: readonly RemoteThreadFollowUp[] = []

export function useComposerRemoteTasks(messages: readonly UIMessage[], owner: RemoteThreadOwner, parentActive: boolean): RemoteTrackerTask[] {
  const liveSyncEnabled = useDesktopFeature("remoteSessionLiveSync")
  const tasks = useMemo<ConversationRemoteTasks>(
    () => conversationRemoteTasks(messages),
    [messages],
  )
  const organizationId = useRemoteThreadOrganization()
  const { workspaceId, sessionId } = owner
  const earlierSignature = tasks.earlier.map((task) => task.start.key).join("\n")
  const latestTasks = useRef(tasks)
  latestTasks.current = tasks
  useEffect(() => {
    if (liveSyncEnabled) {
      if (organizationId && sessionId) void fetchBoundRemoteSessions(sessionId)
      return
    }
    if (!earlierSignature || !organizationId) return
    const store = useRemoteThreadStore.getState()
    const stops = latestTasks.current.earlier.map((task) => store.watch(task.start, { owner: { workspaceId, sessionId }, organizationId, startedAt: task.startedAt }))
    return () => { for (const stop of stops) stop() }
  }, [liveSyncEnabled, earlierSignature, organizationId, workspaceId, sessionId])
  const followUps = tasks.followUps.length > 0 ? tasks.followUps : NO_FOLLOW_UPS
  const matchSignature = useRemoteThreadStore((state) => followUps.length === 0 ? ""
    : Object.values(state.threads).map((entry) => `${entry.start.key}=${entry.status?.sessionId ?? entry.start.sessionId ?? ""}`).sort().join("\n"))
  useEffect(() => {
    if (!liveSyncEnabled && followUps.length > 0) reviveRemoteThreads(followUps)
  }, [liveSyncEnabled, followUps, matchSignature])
  const scope = JSON.stringify([organizationId, workspaceId, sessionId, currentTurnKey(messages), liveSyncEnabled])
  const kept = useRef({ scope, ids: new Set<string>() })
  const listedSignature = useRemoteThreadStore((state) =>
    selectComposerRemoteTasks(tasks, state.threads, organizationId, Date.now(), owner, {
      retained: parentActive && kept.current.scope === scope ? kept.current.ids : undefined,
      includeSettled: liveSyncEnabled,
    }).map((task) => task.start.key).join("\n"))
  const listed = useMemo(() => {
    if (!listedSignature) return []
    const keys = new Set(listedSignature.split("\n"))
    const threads = useRemoteThreadStore.getState().threads
    return selectComposerRemoteTasks(tasks, threads, organizationId, Date.now(), { workspaceId, sessionId }, {
      retained: keys,
      includeSettled: liveSyncEnabled,
    }).filter((task) => keys.has(task.start.key))
  }, [tasks, listedSignature, organizationId, workspaceId, sessionId, liveSyncEnabled])
  kept.current = { scope, ids: new Set(listed.map((task) => task.start.key)) }
  return listed
}

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
  parentActive: boolean
  syncDegraded: boolean
  onOpenSubagentSession?: (sessionId: string) => void
  onStopSubagentSession?: (sessionId: string) => void | Promise<void>
  includeLocal?: boolean
  parts?: readonly TaskToolPart[]
  remote?: {
    tasks: readonly RemoteTrackerTask[]
    owner: RemoteThreadOwner
    onOpen?: (start: RemoteThreadStart) => void
  }
}

const NO_REMOTE_TASKS: readonly RemoteTrackerTask[] = []

export function ComposerSubagentTracker(props: ComposerSubagentTrackerProps) {
  const includeLocal = props.includeLocal !== false
  const providedParts = props.parts
  const parts = useMemo(
    () => !includeLocal ? [] : providedParts ?? currentTurnSubagentParts(props.messages),
    [includeLocal, providedParts, props.messages],
  )
  const remote = props.remote
  const remoteTasks = remote?.tasks ?? NO_REMOTE_TASKS
  const ids = [...parts.map((part) => part.toolCallId), ...remoteTasks.map((task) => task.start.key)]
  const [kinds, setKinds] = useState<Record<string, SubagentTrackerKind>>({})
  const [manualExpanded, setManualExpanded] = useState<boolean | null>(null)
  const report = useCallback((toolCallId: string, kind: SubagentTrackerKind) => {
    setKinds((current) => (current[toolCallId] === kind ? current : { ...current, [toolCallId]: kind }))
  }, [])
  const partIds = parts.map((part) => part.toolCallId).join("\n")
  const firstPartId = ids[0]
  useEffect(() => { setManualExpanded(null) }, [firstPartId])

  const current = ids.map((id) => kinds[id]).filter((kind) => kind !== undefined)
  const anyAttention = current.includes("attention")
  const settled = current.length === ids.length && current.every((kind) => kind === "done" || kind === "stopped" || kind === "error")
  const allQuiet = current.length === ids.length && current.every((kind) => kind === "done" || kind === "stopped")
  const expanded = manualExpanded ?? (anyAttention || ((!allQuiet || remoteTasks.length > 0) && ids.length <= 3))
  const summary = subagentTrackerSummary(current)

  if (ids.length === 0 || (!props.parentActive && settled && remoteTasks.length === 0)) return null
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
