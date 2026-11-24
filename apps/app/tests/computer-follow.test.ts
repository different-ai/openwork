import { expect, test } from "bun:test"
import { createComputerFollow } from "../src/react-app/domains/session/computer/computer-follow"

function harness() {
  const sent: Array<[string, boolean]> = []
  const pending = new Map<number, () => void>()
  let next = 0
  const follow = createComputerFollow(async (sessionId, watching) => { sent.push([sessionId, watching]) }, 1_000, {
    set: (run) => { pending.set(++next, run); return next },
    clear: (handle) => { pending.delete(handle as number) },
  })
  const elapse = () => { const due = [...pending.values()]; pending.clear(); for (const run of due) run() }
  return { sent, follow, elapse, pending }
}

test("a chat on screen is reported as watched once it has stayed there", () => {
  const { sent, follow, elapse } = harness()
  follow("a", true)
  expect(sent).toEqual([])
  elapse()
  expect(sent).toEqual([["a", true]])
  follow("a", true); elapse()
  expect(sent).toEqual([["a", true]])
})

test("a quick switch to another thread and back does not flip the chat", () => {
  const { sent, follow, elapse } = harness()
  follow("a", true); elapse()
  follow("a", false)
  follow("b", true)
  follow("b", false)
  follow("a", true)
  elapse()
  expect(sent).toEqual([["a", true]])
})

test("another thread selected, or OpenWork hidden, stops watching after the delay", () => {
  const { sent, follow, elapse } = harness()
  follow("a", true); elapse()
  // Another thread: this chat's control unmounts and the other mounts.
  follow("a", false); follow("b", true); elapse()
  expect(sent).toEqual([["a", true], ["a", false], ["b", true]])
  // OpenWork hidden or minimized: the page is no longer visible.
  follow("b", false); elapse()
  expect(sent.at(-1)).toEqual(["b", false])
})

test("a chat never watched is not reported, and an older desktop's refusal is ignored", async () => {
  const { sent, follow, pending } = harness()
  follow("a", false)
  expect(pending.size).toBe(0)
  expect(sent).toEqual([])
  const refused = createComputerFollow(() => Promise.reject(new Error("unknown command")), 0, { set: (run) => { run(); return 0 }, clear: () => {} })
  expect(() => refused("a", true)).not.toThrow()
})
