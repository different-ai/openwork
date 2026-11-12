import { createHash } from "node:crypto"
import { desktopRunnerConnected } from "@openwork/automations"
import type { RunnerReportedSession } from "@openwork/types/automations"
import {
  MEMBER_SESSION_LIST_LIMIT,
  type MemberSession,
  type MemberSessionComputer,
  type MemberSessionListResponse,
  type MemberSessionState,
} from "@openwork/types/den/remote-sessions"
import { automationRunnerComputerIds } from "../automations/repository.js"
import type { RemoteSessionDesktopRecord } from "../mcp/remote-session-capabilities.js"
import { commandProjection } from "../mcp/remote-session-status.js"
import { computerSessionAccess, runnerAccessCapabilities, type ComputerSessionAccess, type RemoteSessionAccessPolicy } from "./access.js"
import type { RemoteSessionCommand } from "./commands.js"
import { sessionTimestampIso } from "./timestamps.js"

/**
 * A member's own sessions across their computers: the ones they reach through
 * a remote-session command, and the ones their computers report that they
 * could attach to. Nothing here reads another member's computers or commands;
 * callers pass what they already scoped to one person.
 */

/** Commands shown in one list; older delivered sessions stay reachable by their ids. */
export const MEMBER_SESSION_COMMAND_LIMIT = 100

const PLATFORM_LABELS: Record<RemoteSessionDesktopRecord["platform"], string> = {
  darwin: "Mac",
  win32: "Windows PC",
  linux: "Linux computer",
}

/** The computer's own name when it reported one, else what kind of computer it is. */
export function computerLabel(computer: RemoteSessionDesktopRecord): string {
  return computer.inventory?.computer.label ?? PLATFORM_LABELS[computer.platform]
}

export function computerOnline(computer: RemoteSessionDesktopRecord, now: number): boolean {
  return desktopRunnerConnected({ lastSeenAt: computer.lastSeenAt, now })
}

export function sessionAccessOf(computer: RemoteSessionDesktopRecord, policy: RemoteSessionAccessPolicy): ComputerSessionAccess {
  return computerSessionAccess({ ...runnerAccessCapabilities(computer.capabilities), reported: computer.sessionAccess ?? null }, policy)
}

/** The computer a command ran on or waits for, among the member's computers; null when it is no longer registered. */
export function commandComputer(
  command: Pick<RemoteSessionCommand, "organizationId" | "ownerMemberId" | "claimedByRunnerId" | "targetComputerId">,
  computers: readonly RemoteSessionDesktopRecord[],
): RemoteSessionDesktopRecord | null {
  const ids: readonly string[] = command.claimedByRunnerId
    ? automationRunnerComputerIds({ organizationId: command.organizationId, ownerMemberId: command.ownerMemberId, runnerId: command.claimedByRunnerId })
    : command.targetComputerId ? [command.targetComputerId] : []
  return computers.find((computer) => ids.includes(computer.computerId)) ?? null
}

function sessionKey(computerId: string | null, workspaceId: string | null, sessionId: string | null): string {
  return `${computerId ?? ""}\n${workspaceId ?? ""}\n${sessionId ?? ""}`
}

function workspaceName(computer: RemoteSessionDesktopRecord | null, workspaceId: string | null): string | null {
  if (!computer || !workspaceId) return null
  return computer.inventory?.workspaces.find((workspace) => workspace.workspaceId === workspaceId)?.name ?? null
}

function reportedState(session: RunnerReportedSession | undefined): MemberSessionState {
  if (session?.working === true) return "running"
  return session?.working === false ? "idle" : "unknown"
}

export type AttachableSession = {
  computer: RemoteSessionDesktopRecord
  session: RunnerReportedSession
}

/**
 * Sessions the member's computers report that no command reaches yet. Only a
 * computer whose owner and organization both allow every session lists any.
 * `covered` holds the sessions a command already reaches or is attaching to.
 */
export function attachableSessions(
  computers: readonly RemoteSessionDesktopRecord[],
  policy: RemoteSessionAccessPolicy,
  covered: ReadonlySet<string>,
): AttachableSession[] {
  return computers.flatMap((computer) => {
    if (sessionAccessOf(computer, policy).effectiveAccess !== "all") return []
    return (computer.sessions ?? [])
      .filter((session) => !covered.has(sessionKey(computer.computerId, session.workspaceId, session.sessionId)))
      .map((session) => ({ computer, session }))
  })
}

/** The key `attachableSessions` uses for a session a command covers. */
export function coveredSessionKey(computer: RemoteSessionDesktopRecord, workspaceId: string, sessionId: string): string {
  return sessionKey(computer.computerId, workspaceId, sessionId)
}

function commandSession(
  command: RemoteSessionCommand,
  computers: readonly RemoteSessionDesktopRecord[],
  policy: RemoteSessionAccessPolicy,
): MemberSession | null {
  const computer = commandComputer(command, computers)
  // Nothing reaches a computer that is off; its sessions are listed again once it is allowed.
  if (computer && sessionAccessOf(computer, policy).effectiveAccess === "off") return null
  const projection = commandProjection(command)
  const identity = {
    key: `command:${command.id}`,
    computerId: computer?.computerId ?? projection.computerId,
    computerLabel: computer ? computerLabel(computer) : null,
    origin: command.kind === "attach" ? "local" as const : "remote" as const,
    commandId: command.id,
    updatedAt: sessionTimestampIso(command.updatedAt),
  }
  if (command.status !== "delivered") {
    const workspaceId = command.targetWorkspaceId
    return {
      ...identity,
      workspaceId,
      workspaceName: workspaceName(computer, workspaceId),
      sessionId: command.targetSessionId,
      title: command.title,
      reach: "connecting",
      state: "starting",
      waitingFor: null,
      pending: null,
      latestStep: null,
    }
  }
  // A session that was started on the computer stays listed only while its owner and the organization allow it.
  if (command.kind === "attach" && (!computer || sessionAccessOf(computer, policy).effectiveAccess !== "all")) return null
  const reported = computer?.sessions?.find((session) => session.sessionId === command.sessionId && session.workspaceId === command.workspaceId)
  return {
    ...identity,
    workspaceId: command.workspaceId,
    workspaceName: workspaceName(computer, command.workspaceId),
    sessionId: command.sessionId,
    // The computer's own title is the current one; the command's is from when it was queued.
    title: reported?.title.trim() || command.title,
    reach: "reachable",
    // An attached session says nothing until its computer first reports on it.
    state: command.kind === "attach" && !command.session ? reportedState(reported) : projection.state,
    waitingFor: projection.waitingFor,
    pending: projection.pending ?? null,
    latestStep: projection.latestStep ?? null,
  }
}

function newestFirst(left: MemberSession, right: MemberSession): number {
  if (left.updatedAt === right.updatedAt) return left.key.localeCompare(right.key)
  if (left.updatedAt === null) return 1
  if (right.updatedAt === null) return -1
  return Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
}

export function memberSessionComputers(
  computers: readonly RemoteSessionDesktopRecord[],
  policy: RemoteSessionAccessPolicy,
  now: number,
): MemberSessionComputer[] {
  return computers.map((computer) => ({
    computerId: computer.computerId,
    label: computerLabel(computer),
    platform: computer.platform,
    online: computerOnline(computer, now),
    lastSeenAt: sessionTimestampIso(computer.lastSeenAt),
    ...sessionAccessOf(computer, policy),
    sessionsUpdatedAt: sessionTimestampIso(computer.sessionsUpdatedAt),
  }))
}

/** `commands` are the member's delivered and still-queued commands, newest first. */
export function memberSessionList(input: {
  policy: RemoteSessionAccessPolicy
  computers: readonly RemoteSessionDesktopRecord[]
  commands: readonly RemoteSessionCommand[]
  now: number
}): MemberSessionListResponse {
  const { policy, computers } = input
  const covered = new Set<string>()
  const sessions: MemberSession[] = []
  for (const command of input.commands) {
    const session = commandSession(command, computers, policy)
    if (!session) continue
    sessions.push(session)
    if (session.sessionId) covered.add(sessionKey(session.computerId, session.workspaceId, session.sessionId))
  }
  for (const { computer, session } of attachableSessions(computers, policy, covered)) {
    sessions.push({
      key: `session:${createHash("sha256").update(sessionKey(computer.computerId, session.workspaceId, session.sessionId)).digest("hex").slice(0, 32)}`,
      computerId: computer.computerId,
      computerLabel: computerLabel(computer),
      workspaceId: session.workspaceId,
      workspaceName: workspaceName(computer, session.workspaceId),
      sessionId: session.sessionId,
      title: session.title.trim() || null,
      origin: "local",
      reach: "attachable",
      commandId: null,
      state: reportedState(session),
      waitingFor: null,
      pending: null,
      latestStep: null,
      updatedAt: sessionTimestampIso(session.updatedAt),
    })
  }
  return {
    ceiling: policy.ceiling,
    optIn: policy.optIn,
    computers: memberSessionComputers(computers, policy, input.now),
    sessions: sessions.sort(newestFirst).slice(0, MEMBER_SESSION_LIST_LIMIT),
  }
}
