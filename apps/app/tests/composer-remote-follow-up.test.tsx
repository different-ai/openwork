/** @jsxImportSource react */
import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { act } from "react"
import type { Root } from "react-dom/client"
import type { DynamicToolUIPart, UIMessage } from "ai"
import type { RemoteSessionStatusResult, RemoteSessionThreadStatus } from "@openwork/types/automations"
import type { RemoteThreadEntry } from "../src/react-app/domains/session/remote-threads/remote-thread-store"

/**
 * A task this conversation started on another computer stays in the Agents
 * list above the composer across later turns while it works or waits, and an
 * accepted follow-up (direct or from a Code Mode script) brings it back as
 * the same row, never a second one. Den's status answers are fed to the store
 * exactly as its status loop would (`apply`); no network is used.
 */

// The active organization, without a token: the status loop never calls out.
const den = { ...(await import("../src/app/lib/den")) }
const readSettings = den.readDenSettings
mock.module("../src/app/lib/den", () => ({
  ...den,
  readDenSettings: () => ({ ...readSettings(), authToken: null, activeOrgId: "org_fixture" }),
}))

type TrackerModule = typeof import("../src/react-app/domains/session/surface/composer/composer-subagent-tracker")
type StoreModule = typeof import("../src/react-app/domains/session/remote-threads/remote-thread-store")
type StartsModule = typeof import("../src/lib/remote-thread-starts")
type ThreadModule = typeof import("../src/lib/remote-session-thread")

let createRoot: typeof import("react-dom/client")["createRoot"]
let tracker: TrackerModule
let storeModule: StoreModule
let starts: StartsModule
let thread: ThreadModule
const ownedDom = !GlobalRegistrator.isRegistered && typeof document === "undefined"
beforeAll(async () => {
  if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" })
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
  createRoot = (await import("react-dom/client")).createRoot
  tracker = await import("../src/react-app/domains/session/surface/composer/composer-subagent-tracker")
  storeModule = await import("../src/react-app/domains/session/remote-threads/remote-thread-store")
  starts = await import("../src/lib/remote-thread-starts")
  thread = await import("../src/lib/remote-session-thread")
})
afterAll(async () => { if (ownedDom) await GlobalRegistrator.unregister() })
let root: Root | null = null
afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  root = null
  document.body.innerHTML = ""
  storeModule.useRemoteThreadStore.setState({ helperView: false, threads: {} })
})

const COMMAND = "rsc_fixture_release"
const KEY = `command:${COMMAND}`
const REMOTE_SESSION = "ses_fixture_remote"
const TITLE = "Draft the release notes"
const OWNER = { workspaceId: "ws_fixture", sessionId: "ses_fixture_parent" }

function at(metadataMs: number | null) {
  return metadataMs === null ? {} : { callProviderMetadata: { openwork: { toolStartedAt: metadataMs } } }
}

/** `remote-session:create` for a registered computer: Den answers with a commandId and no sessionId yet. */
function createPart(id: string, startedAt: number | null, commandId = COMMAND, title = TITLE): DynamicToolUIPart {
  return {
    type: "dynamic-tool", toolName: "openwork-cloud_execute_capability", toolCallId: id, state: "output-available",
    input: { name: "remote-session:create", body: { target: "registered", computerId: "cmp_fixture", title, prompt: title } },
    output: { target: "registered", state: "queued", commandId, computerId: "cmp_fixture", workspaceId: "ws_fixture_remote" },
    ...at(startedAt),
  }
}

/** A Code Mode script whose one captured call is `remote-session:send`, with its own result and start time. */
function scriptSend(id: string, sentAt: number | null, output: unknown): DynamicToolUIPart {
  const input = { name: "remote-session:send", body: { sessionId: REMOTE_SESSION, prompt: "Also add a summary at the top." } }
  return {
    type: "dynamic-tool", toolName: "execute", toolCallId: id, state: "output-available", input: { code: "…" }, output: "done",
    callProviderMetadata: { openwork: { codeMode: {
      calls: [{ tool: "openwork-cloud.execute_capability", input, status: "completed" }],
      details: [{ tool: "openwork-cloud.execute_capability", ordinal: 0, invocationId: `${id}:0`, input, output, ...(sentAt === null ? {} : { startedAt: sentAt }) }],
    } } },
  }
}

function accepted(): unknown {
  const receipt = { target: "desktop", state: "accepted", commandId: COMMAND, sessionId: REMOTE_SESSION, workspaceId: "ws_fixture_remote", messageId: "msg_fixture_follow" }
  return { content: [{ type: "text", text: JSON.stringify(receipt) }], structuredContent: receipt }
}

function conversation(turn1: DynamicToolUIPart[], turn2?: DynamicToolUIPart[]): UIMessage[] {
  const messages: UIMessage[] = [
    { id: "u1", role: "user", parts: [{ type: "text", text: "Hand the release notes to my other computer." }] },
    { id: "a1", role: "assistant", parts: turn1 },
  ]
  if (!turn2) return messages
  return [...messages,
    { id: "u2", role: "user", parts: [{ type: "text", text: "Ask it to add a summary too." }] },
    { id: "a2", role: "assistant", parts: turn2 },
  ]
}

let version = 0
function status(state: RemoteSessionThreadStatus["state"], overrides: Partial<RemoteSessionThreadStatus> = {}): RemoteSessionThreadStatus {
  version += 1
  return {
    ref: COMMAND, changed: true, version: `v${version}`, target: "desktop", state, waitingFor: state === "waiting" ? "question" : null,
    title: TITLE, computerId: "cmp_fixture", computerLabel: "Work computer", sessionId: REMOTE_SESSION, workspaceId: "ws_fixture_remote",
    messageCount: 2, preview: null, latestStep: null, error: null, observedAt: Date.now(), ...overrides,
  }
}

/** Den answers the status loop. */
async function den_answers(...threads: RemoteSessionThreadStatus[]) {
  const result: RemoteSessionStatusResult = { threads, retryAfterMs: null }
  await act(async () => { storeModule.useRemoteThreadStore.getState().apply(result, threads.map((entry) => `command:${entry.ref}`), Date.now()) })
}

/** What session-surface renders above the composer for one conversation. */
function Composer(props: { messages: UIMessage[]; parentActive: boolean }) {
  const tasks = tracker.useComposerRemoteTasks(props.messages, OWNER, true)
  if (tasks.length === 0) return null
  return (
    <tracker.ComposerSubagentTracker messages={props.messages} workspaceId={OWNER.workspaceId} parentActive={props.parentActive}
      syncDegraded={false} includeLocal={false} remote={{ tasks, owner: OWNER, onOpen: () => {} }} />
  )
}

async function show(messages: UIMessage[], parentActive: boolean) {
  if (!root) {
    const container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
  }
  await act(async () => { root?.render(<Composer messages={messages} parentActive={parentActive} />) })
}

function rows() {
  return [...document.querySelectorAll<HTMLElement>("[data-subagent-tracker-remote]")].map((row) => ({
    kind: row.dataset.subagentTrackerKind,
    task: row.querySelector("[data-subagent-tracker-task]")?.textContent,
    status: row.querySelector("[data-subagent-tracker-status]")?.textContent,
  }))
}

function trackerShown() {
  const tracker = document.querySelector<HTMLElement>("[data-subagent-tracker]")
  return Boolean(tracker && !tracker.hidden)
}

test("create on turn 1, then an accepted follow-up from a script on turn 2: one row persists, follows the task, and goes away when it finishes", async () => {
  const now = Date.now()
  const turn1 = [createPart("call_create", now - 5 * 60_000)]
  // Turn 1: the agent starts the task; the row appears while the turn runs.
  await show(conversation(turn1), true)
  expect(rows()).toEqual([{ kind: "working", task: TITLE, status: "Starting" }])
  await den_answers(status("running"))
  expect(rows().map((row) => row.kind)).toEqual(["working"])

  // Turn 2: the person asks for more; the agent sends a follow-up from a script, and starts nothing new.
  const turn2 = conversation(turn1, [scriptSend("call_script", Date.now() - 1_000, accepted())])
  expect(turn2.flatMap((message) => starts.remoteThreadStartsInParts(message.parts))).toHaveLength(1)
  await show(turn2, true)
  expect(rows().map((row) => row.task)).toEqual([TITLE])
  const entry = storeModule.useRemoteThreadStore.getState().threads[KEY]
  expect(entry?.followedUpAt).not.toBeNull()

  // The parent chat goes idle while the task keeps working: still listed.
  await show(turn2, false)
  expect(trackerShown()).toBe(true)
  expect(rows()).toHaveLength(1)
  expect(rows()[0]?.kind).toBe("working")

  // It asks the person something: the row says so.
  await den_answers(status("waiting"))
  expect(rows()).toEqual([{ kind: "attention", task: TITLE, status: "Waiting for your answer" }])

  // Working again, then finished: the settled list goes away with the parent idle.
  await den_answers(status("running"))
  expect(rows().map((row) => row.kind)).toEqual(["working"])
  await den_answers(status("idle", { preview: "Done.", messageCount: 4 }))
  expect(trackerShown()).toBe(false)
  expect(Object.keys(storeModule.useRemoteThreadStore.getState().threads)).toEqual([KEY])
})

test("an earlier turn's task that is still working stays listed on a later turn with no follow-up", async () => {
  const now = Date.now()
  const turn2 = conversation([createPart("call_create", now - 10 * 60_000)], [])
  await show(turn2, false)
  // Followed, not listed, until Den says what it is doing: a finished task never flashes.
  expect(storeModule.useRemoteThreadStore.getState().threads[KEY]?.viewers).toBeGreaterThan(0)
  expect(trackerShown()).toBe(false)
  await den_answers(status("running"))
  expect(rows()).toEqual([{ kind: "working", task: TITLE, status: expect.stringMatching(/^Working/) }])
  await den_answers(status("waiting", { waitingFor: "permission" }))
  expect(rows().map((row) => row.kind)).toEqual(["attention"])
})

test("reopening the conversation finds the task still working, and leaves a finished or stopped one out", async () => {
  const now = Date.now()
  // A reopened chat: the follow-up was sent long ago, so nothing is revived; only Den's state decides.
  const reopened = conversation([createPart("call_create", now - 30 * 60_000)], [scriptSend("call_script", now - 20 * 60_000, accepted())])
  await show(reopened, false)
  expect(storeModule.useRemoteThreadStore.getState().threads[KEY]?.followedUpAt).toBeNull()
  expect(trackerShown()).toBe(false)
  await den_answers(status("running"))
  expect(rows().map((row) => row.kind)).toEqual(["working"])
  await act(async () => root?.unmount())
  root = null

  storeModule.useRemoteThreadStore.setState({ threads: {} })
  const finished = conversation([createPart("call_create", now - 30 * 60_000)], [])
  await show(finished, false)
  await den_answers(status("idle", { preview: "Done." }))
  expect(trackerShown()).toBe(false)
  await den_answers(status("error", { error: { code: "MessageAbortedError", message: "The task was stopped." } }))
  expect(trackerShown()).toBe(false)
})

test("a pending or failed follow-up does not count as accepted, and never starts or duplicates a row", () => {
  const now = Date.now()
  const pendingReceipt = { target: "desktop", state: "pending", requestId: "req_fixture", sessionId: REMOTE_SESSION, workspaceId: "ws_fixture_remote" }
  const failedReceipt = { target: "desktop", error: "desktop_request_expired", message: "The desktop did not answer in time.", sessionId: REMOTE_SESSION }
  for (const output of [pendingReceipt, failedReceipt]) {
    const tasks = tracker.conversationRemoteTasks(conversation([createPart("call_create", now - 60_000)], [scriptSend("call_script", now, output)]))
    expect(tasks.followUps).toEqual([])
    expect(tasks.earlier.map((task) => task.start.key)).toEqual([KEY])
  }
  const tasks = tracker.conversationRemoteTasks(conversation([createPart("call_create", now - 60_000)], [scriptSend("call_script", now, accepted())]))
  expect(tasks.followUps).toEqual([{ toolCallId: "call_script:call:0", commandId: COMMAND, sessionId: REMOTE_SESSION, sentAt: now }])
  expect(tasks.current).toEqual([])
})

test("a direct follow-up to a Cloud task matches it by sessionId, and the list is scoped to the active organization", () => {
  const now = Date.now()
  const cloudCreate: DynamicToolUIPart = {
    type: "dynamic-tool", toolName: "openwork_execute_capability", toolCallId: "call_cloud", state: "output-available",
    input: { name: "remote-session:create", body: { target: "cloud", title: "Summarize the inbox", prompt: "Summarize the inbox" } },
    output: { target: "cloud", sessionId: "ses_fixture_cloud", state: "running" }, ...at(now - 60_000),
  }
  const cloudSend: DynamicToolUIPart = {
    type: "dynamic-tool", toolName: "openwork_execute_capability", toolCallId: "call_send", state: "output-available",
    input: { name: "remote-session:send", body: { sessionId: "ses_fixture_cloud", prompt: "Also the archive." } },
    output: JSON.stringify({ target: "cloud", sessionId: "ses_fixture_cloud", state: "accepted", messageId: "msg_fixture" }), ...at(now),
  }
  const tasks = tracker.conversationRemoteTasks(conversation([cloudCreate], [cloudSend]))
  const [task] = tasks.earlier
  if (!task) throw new Error("expected the Cloud task")
  expect(task.start.key).toBe("cloud:ses_fixture_cloud")
  expect(task.startedAt).toBe(now)
  const entry = (organizationId: string, state: RemoteSessionThreadStatus["state"]): RemoteThreadEntry => ({
    start: task.start, organizationId, version: "v1", status: { ...status(state), ref: "ses_fixture_cloud", target: "cloud", sessionId: "ses_fixture_cloud" }, stale: false,
    checkedAt: now, activeSince: now, firstSeenAt: now, followedUpAt: null, followUpVersion: null, revivedAt: null, owners: {}, viewers: 1, lastViewedAt: now,
  })
  // Followed up this turn: listed even once done (the settled list then goes away on its own).
  expect(tracker.selectComposerRemoteTasks(tasks, { [task.start.key]: entry("org_fixture", "idle") }, "org_fixture", now)).toHaveLength(1)
  expect(tracker.selectComposerRemoteTasks(tasks, { [task.start.key]: entry("org_other", "running") }, "org_fixture", now)).toEqual([])
  expect(tracker.selectComposerRemoteTasks({ ...tasks, followUps: [] }, { [task.start.key]: entry("org_fixture", "idle") }, "org_fixture", now)).toEqual([])
})

test("only recent earlier tasks are candidates, at most one status call's worth, and the current turn's task is not repeated", () => {
  const now = Date.now()
  const old = createPart("call_old", now - 7 * 60 * 60_000, "rsc_fixture_old", "Old task")
  const many = Array.from({ length: 12 }, (_, index) => createPart(`call_${index}`, now - (20 - index) * 60_000, `rsc_fixture_${index}`, `Task ${index}`))
  const tasks = tracker.conversationRemoteTasks(conversation([old, ...many], [createPart("call_again", now, "rsc_fixture_11", "Task 11")]))
  expect(tasks.current.map((task) => task.start.key)).toEqual(["command:rsc_fixture_11"])
  expect(tasks.earlier).toHaveLength(10)
  expect(tasks.earlier.map((task) => task.start.key)).not.toContain("command:rsc_fixture_old")
  expect(tasks.earlier.map((task) => task.start.key)).not.toContain("command:rsc_fixture_11")
  expect(tasks.earlier[0]?.start.key).toBe("command:rsc_fixture_10")
})

test("the follow-up a transcript row shows revives its task once, from a script too, and reads Working until the new turn is reported", () => {
  const now = Date.now()
  const created = thread.remoteThreadFromToolPart(createPart("call_create", now - 60_000))
  if (!created) throw new Error("expected the task")
  const store = storeModule.useRemoteThreadStore
  store.setState({ threads: { [KEY]: {
    start: created, organizationId: "org_fixture", version: "v_old", status: status("idle", { version: "v_old" }), stale: false, checkedAt: now,
    activeSince: now - 60_000, firstSeenAt: now - 60_000, followedUpAt: null, followUpVersion: null, revivedAt: null, owners: {}, viewers: 1, lastViewedAt: now,
  } } })
  const followUps = starts.remoteThreadFollowUpsInPart(scriptSend("call_script", now - 1_000, accepted()))
  storeModule.reviveRemoteThreads(followUps)
  const revived = store.getState().threads[KEY]
  expect(revived?.revivedAt).toBe(now - 1_000)
  const firstFollowUp = revived?.followedUpAt
  expect(firstFollowUp).not.toBeNull()
  storeModule.reviveRemoteThreads(followUps)
  expect(store.getState().threads[KEY]?.followedUpAt).toBe(firstFollowUp ?? -1)
  // The previous turn's idle status, seen again, is not the new turn.
  store.getState().apply({ threads: [{ ref: COMMAND, changed: false, version: "v_old" }], retryAfterMs: null }, [KEY], Date.now())
  const waiting = store.getState().threads[KEY]
  if (!waiting) throw new Error("expected the entry")
  expect(storeModule.remoteThreadAwaitingFollowUp(waiting, Date.now())).toBe(true)
  // A newer version ends the wait, even when the follow-up already finished.
  store.getState().apply({ threads: [status("idle", { version: "v_new", messageCount: 4 })], retryAfterMs: null }, [KEY], Date.now())
  const done = store.getState().threads[KEY]
  if (!done) throw new Error("expected the entry")
  expect(done.followedUpAt).toBeNull()
  expect(storeModule.remoteThreadAwaitingFollowUp(done, Date.now())).toBe(false)
})

test("a long chat opened on its newest page still lists a task this window follows for it, like the sidebar does, and no other chat's", async () => {
  const now = Date.now()
  const created = thread.remoteThreadFromToolPart(createPart("call_create", now - 60 * 60_000))
  if (!created) throw new Error("expected the task")
  const owned = (sessionId: string, state: RemoteSessionThreadStatus["state"], key = KEY): RemoteThreadEntry => ({
    start: { ...created, key }, organizationId: "org_fixture", version: "v1", status: status(state), stale: false, checkedAt: now,
    activeSince: now - 60 * 60_000, firstSeenAt: now - 60 * 60_000, followedUpAt: null, followUpVersion: null, revivedAt: null,
    owners: { [`${OWNER.workspaceId}:${sessionId}`]: { workspaceId: OWNER.workspaceId, sessionId } }, viewers: 0, lastViewedAt: now,
  })
  storeModule.useRemoteThreadStore.setState({ helperView: true, threads: {
    [KEY]: owned(OWNER.sessionId, "running"),
    "command:rsc_fixture_done": owned(OWNER.sessionId, "idle", "command:rsc_fixture_done"),
    "command:rsc_fixture_other": owned("ses_fixture_other_chat", "running", "command:rsc_fixture_other"),
  } })
  // Only the newest page is loaded: the turn that started the task is not in it.
  const newestPage: UIMessage[] = [
    { id: "u9", role: "user", parts: [{ type: "text", text: "Anything else on the launch?" }] },
    { id: "a9", role: "assistant", parts: [{ type: "text", text: "Nothing else for now." }] },
  ]
  await show(newestPage, false)
  expect(rows()).toEqual([{ kind: "working", task: TITLE, status: expect.stringMatching(/^Working/) }])
  await den_answers(status("idle", { preview: "Done." }))
  expect(trackerShown()).toBe(false)
})
