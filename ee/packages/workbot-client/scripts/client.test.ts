import assert from "node:assert/strict"
import { test } from "node:test"
import { applyLiveEvent, parseLiveEvent, reconnectDelay, takeEvents } from "../src/live.ts"
import { parseDelimited, showsTimestamp, withoutNextLine } from "../src/present.ts"

test("the live stream splits into events, keeping what hasn't fully arrived", () => {
  const { events, rest } = takeEvents(': keep-alive\n\nevent: ready\ndata: {}\n\ndata: {"type":"changed","messageId":"m1"}\r\n\r\ndata: a\ndata: b\n\ndata: {"ty')
  assert.deepEqual(events, ['{"type":"changed","messageId":"m1"}', "a\nb"])
  assert.equal(rest, 'data: {"ty')
  assert.deepEqual(takeEvents(rest + 'pe":"changed","messageId":"m2"}\n\n').events, ['{"type":"changed","messageId":"m2"}'])
})

test("only events the conversation understands are kept", () => {
  assert.equal(parseLiveEvent("not json"), null)
  assert.equal(parseLiveEvent('{"type":"party","messageId":"m1"}'), null)
  assert.deepEqual(parseLiveEvent('{"type":"text","messageId":"m1","step":0,"delta":"Hi"}'), { type: "text", messageId: "m1", step: 0, delta: "Hi" })
})

test("reply text builds up per step: a new step starts over, an older step is ignored, a reset replaces", () => {
  let live = applyLiveEvent({}, { type: "text", messageId: "m1", step: 0, delta: "Hel" }, 0)
  live = applyLiveEvent(live, { type: "text", messageId: "m1", step: 0, delta: "lo" }, 0)
  assert.equal(live.m1?.text, "Hello")
  live = applyLiveEvent(live, { type: "text", messageId: "m1", step: 1, delta: "Next" }, 0)
  assert.deepEqual(live.m1, { step: 1, text: "Next" })
  live = applyLiveEvent(live, { type: "text", messageId: "m1", step: 0, delta: "late" }, 0)
  assert.deepEqual(live.m1, { step: 1, text: "Next" })
  live = applyLiveEvent(live, { type: "text", messageId: "m1", step: 1, delta: "Over", reset: true }, 0)
  assert.equal(live.m1?.text, "Over")
})

test("a step that starts work keeps its text and stays working until a reset", () => {
  let live = applyLiveEvent({}, { type: "text", messageId: "m1", step: 2, delta: "Looking" }, 0)
  live = applyLiveEvent(live, { type: "working", messageId: "m1", step: 2, on: "computer" }, 5)
  assert.deepEqual(live.m1, { step: 2, text: "Looking", working: { on: "computer", since: 5 } })
  live = applyLiveEvent(live, { type: "text", messageId: "m1", step: 2, delta: "…" }, 6)
  assert.deepEqual(live.m1?.working, { on: "computer", since: 5 })
  live = applyLiveEvent(live, { type: "text", messageId: "m1", step: 2, delta: "Done", reset: true }, 7)
  assert.deepEqual(live.m1, { step: 2, text: "Done" })
})

test("the stream reopens at once, then backs off to eight seconds", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 9].map(reconnectDelay), [250, 1_000, 2_000, 4_000, 8_000, 8_000])
})

test("CSV cells keep quoted delimiters, escaped quotes and Windows line ends", () => {
  assert.deepEqual(parseDelimited('a,"b,c","say ""hi"""\r\n1,2,3\n', ","), [["a", "b,c", 'say "hi"'], ["1", "2", "3"]])
  assert.deepEqual(parseDelimited("x\ty", "\t"), [["x", "y"]])
  assert.deepEqual(parseDelimited("", ","), [[""]])
})

test("a time shows above a message after a quiet hour or on a new day", () => {
  const morning = new Date(2026, 9, 8, 9, 0).getTime()
  assert.equal(showsTimestamp(null, morning), true)
  assert.equal(showsTimestamp(morning, morning + 30 * 60_000), false)
  assert.equal(showsTimestamp(morning, morning + 61 * 60_000), true)
  assert.equal(showsTimestamp(new Date(2026, 9, 7, 23, 50).getTime(), new Date(2026, 9, 8, 0, 5).getTime()), true)
  assert.equal(showsTimestamp(morning, 0), false)
})

test("an answer's closing Next line becomes buttons, so it isn't shown, even half-written", () => {
  assert.equal(withoutNextLine("Hi Alex.\n\nNext: Draft both replies | Plan my afternoon"), "Hi Alex.")
  assert.equal(withoutNextLine("Hi Alex.\n\n**Next:** Draft"), "Hi Alex.")
  assert.equal(withoutNextLine("Hi Alex.\n\nNe"), "Hi Alex.")
  assert.equal(withoutNextLine("Hi Alex.\n\nNever mind"), "Hi Alex.\n\nNever mind")
})
