import type { RemoteSessionAnswerInput } from "@openwork/types/automations"

import { createDenClient, DenApiError, readDenSettings } from "@/app/lib/den"
import {
  latestUserMessageId,
  parseRemoteRead,
  remoteActionError,
  remoteFollowUpMessageId,
  remotePendingRequestId,
  type RemoteReadOutcome,
} from "@/lib/remote-session-thread"
import { useRemoteThreadStore, type RemoteThreadEntry } from "./remote-thread-store"

const REQUEST_POLL_MS = 1_500
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
    return { code: error.code, message: error.message, retryable: error.status >= 500 }
  }
  return { code: "request_failed", message: "Couldn't reach OpenWork. Check your connection and try again.", retryable: true }
}

export function remoteThreadLocation(entry: RemoteThreadEntry): { sessionId: string; workspaceId?: string } | null {
  const sessionId = entry.status?.sessionId ?? entry.start.sessionId
  if (!sessionId) return null
  const workspaceId = entry.start.target === "desktop" ? entry.status?.workspaceId ?? entry.start.workspaceId : null
  return { sessionId, ...(workspaceId ? { workspaceId } : {}) }
}

async function call(action: "read" | "send" | "stop" | "answer", input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const den = context()
  if (!den) throw new DenApiError(401, "unauthorized", "Sign in to OpenWork to follow this task.")
  let payload = await den.client.remoteSessionAction(den.organizationId, action, input, signal)
  const deadline = Date.now() + REQUEST_WAIT_MS
  for (let requestId = remotePendingRequestId(payload); requestId && Date.now() < deadline; requestId = remotePendingRequestId(payload)) {
    await new Promise((resolve) => setTimeout(resolve, REQUEST_POLL_MS))
    signal?.throwIfAborted()
    payload = await den.client.remoteSessionAction(den.organizationId, "read", { requestId }, signal)
  }
  return payload
}

export async function readRemoteThread(entry: RemoteThreadEntry, input: { limit: number; cursor?: string | null; signal?: AbortSignal }): Promise<RemoteReadOutcome> {
  const location = remoteThreadLocation(entry)
  if (!location) return { kind: "error", code: "not_started", message: "The conversation appears once the computer starts the task.", retryable: true }
  try {
    return parseRemoteRead(await call("read", {
      ...location,
      limit: input.limit,
      ...(input.cursor ? { from: "end", cursor: input.cursor } : {}),
    }, input.signal))
  } catch (error) {
    return { kind: "error", ...failure(error) }
  }
}

export async function sendRemoteFollowUp(entry: RemoteThreadEntry, prompt: string, messageId?: string): Promise<Failure | null> {
  const location = remoteThreadLocation(entry)
  if (!location) return { code: "not_started", message: "Wait for the computer to start the task, then send your follow-up.", retryable: true }
  try {
    const payload = await call("send", { ...location, prompt, messageId: messageId || remoteFollowUpMessageId() })
    if (remotePendingRequestId(payload)) return { code: "desktop_request_pending", message: "The computer hasn't confirmed your follow-up yet. Check the conversation before sending it again.", retryable: false }
    const error = remoteActionError(payload)
    if (error) return error
    useRemoteThreadStore.getState().followedUp(entry.start.key)
    return null
  } catch (error) {
    return failure(error)
  }
}

export async function answerRemoteThread(entry: RemoteThreadEntry, answer: RemoteSessionAnswerInput): Promise<Failure | null> {
  const location = remoteThreadLocation(entry)
  if (!location) return { code: "not_started", message: "The task hasn't started yet.", retryable: true }
  try {
    const payload = await call("answer", { ...location, ...answer })
    if (remotePendingRequestId(payload)) return { code: "desktop_request_pending", message: "The computer hasn't confirmed your answer yet. Check the task before answering again.", retryable: false }
    const error = remoteActionError(payload)
    if (error) return error
    useRemoteThreadStore.getState().followedUp(entry.start.key)
    return null
  } catch (error) {
    return failure(error)
  }
}

export async function stopRemoteThread(entry: RemoteThreadEntry, latestUserId?: string | null): Promise<Failure | null> {
  const location = remoteThreadLocation(entry)
  if (!location) return { code: "not_started", message: "The task hasn't started yet.", retryable: true }
  try {
    let messageId = latestUserId ?? null
    if (!messageId) {
      const tail = await readRemoteThread(entry, { limit: 4 })
      messageId = tail.kind === "page" ? latestUserMessageId(tail.page.messages) : null
    }
    return remoteActionError(await call("stop", { ...location, ...(messageId ? { messageId } : {}) }))
  } catch (error) {
    return failure(error)
  }
}
