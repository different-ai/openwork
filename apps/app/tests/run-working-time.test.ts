import { afterEach, expect, setSystemTime, test } from "bun:test"
import type { UIMessage } from "ai"
import { SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX } from "../src/app/types"
import { getRunStartedAt, getWaitedMs } from "../src/components/chat/utils"
import { useSessionActivityStore } from "../src/react-app/domains/session/status/session-activity-store"

afterEach(() => {
  setSystemTime()
  useSessionActivityStore.getState().removeSession("workspace_fixture", "session_fixture")
})

function user(id: string, created?: number): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text: id }], ...(created === undefined ? {} : { metadata: { opencode: { created } } }) }
}

function reply(id: string, created: number, completed?: number): UIMessage {
  return { id, role: "assistant", parts: [{ type: "text", text: id }], metadata: { opencode: { created, ...(completed === undefined ? {} : { completed }) } } }
}

test("a run starts at the message that started it", () => {
  expect(getRunStartedAt([user("first", 1_000), reply("answer", 1_100)])).toBe(1_000)
  expect(getRunStartedAt([])).toBeNull()
})

test("a follow-up sent while the reply is still being written keeps the run's start", () => {
  expect(getRunStartedAt([user("first", 1_000), reply("answer", 1_100), user("steer", 5_000)])).toBe(1_000)
  // The reply finished after the follow-up arrived, so it was still working when it was sent.
  expect(getRunStartedAt([user("first", 1_000), reply("answer", 1_100, 9_000), user("steer", 5_000), reply("adjusted", 9_100)])).toBe(1_000)
})

test("several follow-ups in one run all count from the first message", () => {
  expect(getRunStartedAt([
    user("first", 1_000), reply("one", 1_100, 9_000),
    user("steer", 5_000), reply("two", 9_100, 20_000),
    user("again", 15_000), reply("three", 20_100),
  ])).toBe(1_000)
})

test("a message sent after the reply finished starts a new run", () => {
  expect(getRunStartedAt([user("first", 1_000), reply("answer", 1_100, 3_000), user("next", 8_000)])).toBe(8_000)
  expect(getRunStartedAt([user("first", 1_000), reply("answer", 1_100, 3_000), user("next", 8_000), reply("new answer", 8_100)])).toBe(8_000)
})

test("a message sent after an error starts a new run", () => {
  const error = { ...reply("error", 2_000), id: `${SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX}first` }
  expect(getRunStartedAt([user("first", 1_000), reply("answer", 1_100), error, user("retry", 8_000)])).toBe(8_000)
})

test("an old reply left unfinished by an interrupted run does not join the next run", () => {
  // Interrupted runs leave replies without a completion time in history.
  expect(getRunStartedAt([user("first", 1_000), reply("interrupted", 1_100), user("next", 90_000), reply("new answer", 90_100)])).toBe(90_000)
})

test("a pending follow-up without a server time keeps the run's start", () => {
  expect(getRunStartedAt([user("first", 1_000), reply("answer", 1_100), user("pending")])).toBe(1_000)
  expect(getRunStartedAt([user("first", 1_000), reply("answer", 1_100, 3_000), user("pending")])).toBeNull()
})

test("waiting for the person inside the run is left out of its working time", () => {
  expect(getWaitedMs([{ start: 2_000, end: 5_000 }], 1_000, 10_000)).toBe(3_000)
  // An open wait lasts until now.
  expect(getWaitedMs([{ start: 8_000 }], 1_000, 10_000)).toBe(2_000)
  expect(getWaitedMs([], 1_000, 10_000)).toBe(0)
})

test("only the part of a wait inside the run counts", () => {
  expect(getWaitedMs([{ start: 0, end: 500 }], 1_000, 10_000)).toBe(0)
  expect(getWaitedMs([{ start: 500, end: 3_000 }], 1_000, 10_000)).toBe(2_000)
})

test("the chat and a helper waiting at the same time count once", () => {
  expect(getWaitedMs([{ start: 2_000, end: 5_000 }, { start: 4_000, end: 7_000 }, { start: 3_000, end: 4_000 }], 1_000, 10_000)).toBe(5_000)
})

test("a session's waits open on its first request and close when none remain", () => {
  const store = useSessionActivityStore.getState()
  const waits = () => useSessionActivityStore.getState().recordsByWorkspaceId.workspace_fixture?.session_fixture?.waits
  setSystemTime(new Date(1_000))
  store.setWaitingRequest("workspace_fixture", "session_fixture", "permission", "per_1", true)
  setSystemTime(new Date(2_000))
  store.setWaitingRequest("workspace_fixture", "session_fixture", "question", "que_1", true)
  expect(waits()).toEqual([{ start: 1_000 }])
  setSystemTime(new Date(3_000))
  store.setWaitingRequest("workspace_fixture", "session_fixture", "permission", "per_1", false)
  expect(waits()).toEqual([{ start: 1_000 }])
  setSystemTime(new Date(4_000))
  store.setWaitingRequest("workspace_fixture", "session_fixture", "question", "que_1", false)
  expect(waits()).toEqual([{ start: 1_000, end: 4_000 }])
})
