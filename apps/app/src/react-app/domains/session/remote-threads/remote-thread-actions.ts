import { createDenClient, DenApiError, readDenSettings } from "@/app/lib/den"
import { parseRecord } from "@/lib/capability-call"
import {
  latestUserMessageId,
  parseRemoteRead,
  remoteActionError,
  remoteFollowUpMessageId,
  remotePendingRequestId,
  type RemoteReadOutcome,
} from "@/lib/remote-session-thread"
import { useRemoteThreadStore, type RemoteThreadAction, type RemoteThreadEntry } from "./remote-thread-store"

const REQUEST_POLL_MS = 2_000
const REQUEST_WAIT_MS = 40_000

type Failure = { code: string; message: string; retryable: boolean }

function context() {
  const settings = readDenSettings()
  const token = settings.authToken?.trim()
  const organizationId = settings.activeOrgId?.trim()
  if (!token || !organizationId) return null
  return { client: createDenClient({ baseUrl: settings.baseUrl, apiBaseUrl: settings.apiBaseUrl, token }), organizationId }
}

function failure(error: unknown): Failure {
  if (error instanceof DenApiError) {
    if (error.code === "feature_disabled") useRemoteThreadStore.getState().setEnabled(false)
    return { code: error.code, message: error.message, retryable: error.status >= 500 }
  }
  return { code: "request_failed", message: "Couldn't reach OpenWork. Check your connection and try again.", retryable: true }
}

/** Where the task's session lives, once its computer has started it. */
export function remoteThreadLocation(entry: RemoteThreadEntry): { sessionId: string; workspaceId?: string } | null {
  const sessionId = entry.status?.sessionId ?? entry.start.sessionId
  if (!sessionId) return null
  const workspaceId = entry.start.target === "desktop" ? entry.status?.workspaceId ?? entry.start.workspaceId : null
  return { sessionId, ...(workspaceId ? { workspaceId } : {}) }
}

async function call(action: "read" | "send" | "stop", input: Record<string, unknown>, pending?: (requestId: string) => void): Promise<unknown> {
  const requireEnabled = () => {
    if (!useRemoteThreadStore.getState().enabled) {
      throw new DenApiError(404, "feature_disabled", "Tasks on other computers are turned off.")
    }
  }
  requireEnabled()
  const den = context()
  if (!den) throw new DenApiError(401, "unauthorized", "Sign in to OpenWork to follow this task.")
  const controller = new AbortController()
  const unsubscribe = useRemoteThreadStore.subscribe((state) => {
    if (!state.enabled) controller.abort()
  })
  try {
    let payload = await den.client.remoteSessionAction(den.organizationId, action, input, controller.signal)
    const deadline = Date.now() + REQUEST_WAIT_MS
    for (let requestId = remotePendingRequestId(payload); requestId; requestId = remotePendingRequestId(payload)) {
      // Keep the known receipt before any read can fail. Recovery must read it,
      // never repeat the original send or Stop.
      pending?.(requestId)
      if (Date.now() >= deadline) break
      await new Promise((resolve) => setTimeout(resolve, REQUEST_POLL_MS))
      requireEnabled()
      payload = await den.client.remoteSessionAction(den.organizationId, "read", { requestId }, controller.signal)
    }
    return payload
  } finally {
    unsubscribe()
  }
}

export async function readRemoteThread(entry: RemoteThreadEntry, input: { limit: number; cursor?: string | null; requestId?: string | null }): Promise<RemoteReadOutcome> {
  const location = remoteThreadLocation(entry)
  if (!location) return { kind: "error", code: "not_started", message: "The conversation appears once the computer starts the task.", retryable: true }
  let requestId = input.requestId ?? null
  try {
    return parseRemoteRead(await call("read", input.requestId ? { requestId: input.requestId } : {
      ...location,
      limit: input.limit,
      ...(input.cursor ? { from: "end", cursor: input.cursor } : {}),
    }, (receipt) => { requestId = receipt }))
  } catch (error) {
    return { kind: "error", ...failure(error), ...(requestId ? { requestId } : {}) }
  }
}

type ActionResult = Omit<RemoteThreadAction, "id">

function actionFailure(error: unknown, requestId: string | null, uncertain: string): ActionResult {
  const problem = failure(error)
  // A client rejection before any receipt is evidence that this action was
  // refused. Once a receipt exists, even sign-in loss must preserve recovery.
  const rejected = requestId === null && error instanceof DenApiError && [400, 401, 403, 404, 409, 422, 429].includes(error.status)
  return { phase: rejected ? "failed" : "unconfirmed", requestId, message: rejected ? problem.message : `${problem.message} ${uncertain}` }
}

function actionResult(payload: unknown, action: "send" | "stop"): ActionResult {
  const requestId = remotePendingRequestId(payload)
  if (requestId) return {
    phase: "unconfirmed", requestId,
    message: action === "send" ? "The computer hasn't confirmed this follow-up. Check again before sending it again." : "The computer hasn't confirmed Stop. The task may still be running.",
  }
  const error = remoteActionError(payload)
  if (error) return { phase: "failed", requestId: null, message: error.message }
  const record = parseRecord(payload)
  if (action === "stop" && (record?.stopped === false || record?.accepted === false)) return {
    phase: "failed", requestId: null,
    message: record.reason === "different_turn" ? "The task moved to a different turn before Stop arrived. Check the conversation before stopping that turn." : "The task didn't accept Stop. Check the conversation and try again.",
  }
  const accepted = action === "send" ? record?.state === "accepted" : record?.stopped === true || record?.accepted === true
  return accepted ? { phase: "accepted", requestId: null, message: null }
    : { phase: "unconfirmed", requestId: null, message: "Couldn't confirm the response. Check the conversation before repeating this action." }
}

const requesting: ActionResult = { phase: "requesting", requestId: null, message: null }

/** The submitted message lives on the thread, independently of the next editable draft. */
export async function sendRemoteFollowUp(entry: RemoteThreadEntry, prompt: string, draftOwner?: string): Promise<void> {
  const store = useRemoteThreadStore.getState()
  const current = store.threads[entry.start.key]
  if (!current || current.followUps.some((item) => item.phase === "requesting")
    || (current.stop && current.stop.phase !== "failed" && current.status?.state !== "idle" && current.status?.state !== "error")) return
  const id = remoteFollowUpMessageId()
  const stopIdAtSubmission = current.stop?.id ?? null
  store.update(entry.start.key, (thread) => ({ ...thread,
    drafts: draftOwner && thread.drafts[draftOwner]?.trim() === prompt ? { ...thread.drafts, [draftOwner]: "" } : thread.drafts,
    followUps: [...thread.followUps, { ...requesting, id, text: prompt, stopIdAtSubmission }],
  }))
  let requestId: string | null = null
  const pending = (receipt: string) => {
    requestId = receipt
    store.update(entry.start.key, (thread) => ({ ...thread, followUps: thread.followUps.map((item) => item.id === id ? { ...item, requestId: receipt } : item) }))
  }
  const location = remoteThreadLocation(entry)
  let result: ActionResult
  try {
    result = location ? actionResult(await call("send", { ...location, prompt, messageId: id }, pending), "send")
      : { phase: "failed", requestId: null, message: "Wait for the computer to start the task, then send your follow-up." }
  } catch (error) {
    // A lost response is not proof that a send failed. Never replay it automatically.
    result = actionFailure(error, requestId, "Check the conversation before sending this follow-up again.")
  }
  store.update(entry.start.key, (thread) => ({ ...thread, followUps: thread.followUps.map((item) => item.id === id ? { ...item, ...result } : item) }))
  if (result.phase === "accepted") store.followedUp(entry.start.key, stopIdAtSubmission)
}

/** Stops only the current turn. Its receipt is shared by the row and panel. */
export async function stopRemoteThread(entry: RemoteThreadEntry, latestUserId?: string | null): Promise<void> {
  const store = useRemoteThreadStore.getState()
  const current = store.threads[entry.start.key]
  if (!current || (current.stop && current.stop.phase !== "failed")) return
  const id = remoteFollowUpMessageId()
  store.update(entry.start.key, (thread) => ({ ...thread, stop: { ...requesting, id, requestedAt: Date.now() } }))
  let requestId: string | null = null
  const pending = (receipt: string) => {
    requestId = receipt
    store.update(entry.start.key, (thread) => thread.stop?.id === id ? { ...thread, stop: { ...thread.stop, requestId: receipt } } : thread)
  }
  let result: ActionResult
  try {
    const location = remoteThreadLocation(entry)
    if (!location) throw new DenApiError(409, "not_started", "The task hasn't started yet.")
    let messageId = latestUserId ?? null
    if (!messageId) {
      const tail = await readRemoteThread(entry, { limit: 4 })
      messageId = tail.kind === "page" ? latestUserMessageId(tail.page.messages) : null
    }
    // Never issue an unguarded desktop Stop after an unconfirmed transcript read.
    if (!messageId && entry.start.target === "desktop") {
      result = { phase: "failed", requestId: null, message: "Couldn't confirm the current turn. Open the conversation and try Stop again." }
    } else result = actionResult(await call("stop", { ...location, ...(messageId ? { messageId } : {}) }, pending), "stop")
  } catch (error) {
    result = actionFailure(error, requestId, "Stop isn't confirmed; the task may still be running.")
  }
  store.update(entry.start.key, (thread) => thread.stop?.id === id ? { ...thread, stop: { ...thread.stop, ...result } } : thread)
}

/** Check an existing receipt, never repeat the send/stop mutation. */
export async function checkRemoteThreadAction(entry: RemoteThreadEntry, followUpId?: string): Promise<void> {
  const store = useRemoteThreadStore.getState()
  const current = store.threads[entry.start.key]
  const followUp = followUpId ? current?.followUps.find((item) => item.id === followUpId) : undefined
  const action = followUpId ? followUp : current?.stop
  if (!action?.requestId || action.phase === "requesting") return
  const update = (result: ActionResult) => store.update(entry.start.key, (thread) => followUpId
    ? { ...thread, followUps: thread.followUps.map((item) => item.id === action.id ? { ...item, ...result } : item) }
    : thread.stop?.id === action.id ? { ...thread, stop: { ...thread.stop, ...result } } : thread)
  let requestId = action.requestId
  update({ ...action, phase: "requesting" })
  try {
    const result = actionResult(await call("read", { requestId }, (receipt) => {
      requestId = receipt
      update({ ...action, phase: "requesting", requestId: receipt })
    }), followUpId ? "send" : "stop")
    update(result)
    if (followUp && result.phase === "accepted") store.followedUp(entry.start.key, followUp.stopIdAtSubmission)
  } catch (error) {
    update({ ...action, requestId, phase: "unconfirmed", message: failure(error).message })
  }
}
