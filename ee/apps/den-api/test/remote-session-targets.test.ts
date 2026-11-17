import assert from "node:assert/strict"
import { test } from "node:test"
import { listedTargets } from "../src/remote-sessions/targets.js"

/** Which of a member's registrations remote-session:targets offers as places to start a task. */

const NOW = Date.parse("2026-11-16T20:00:00.000Z")
const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

function computer(id: string, seenAgo: number, label: string | null = "Milo's MacBook Pro", platform: "darwin" | "win32" | "linux" = "darwin") {
  return {
    id,
    platform,
    lastSeenAt: NOW - seenAgo,
    inventory: label === null ? null : { computer: { label, platform, appVersion: "1.7.0" }, workspaces: [] },
  }
}

const listed = (computers: ReturnType<typeof computer>[]) => listedTargets(computers, NOW).map((entry) => entry.id)

test("an offline registration is left out once the same computer has been seen since under another one", () => {
  assert.deepEqual(listed([computer("in-use", MINUTE), computer("old-build", 14 * DAY)]), ["in-use"])
  assert.deepEqual(listed([computer("old-build", 14 * DAY), computer("in-use", MINUTE)]), ["in-use"], "whatever order they are read in")
  assert.deepEqual(listed([computer("newer", 2 * DAY), computer("older", 14 * DAY), computer("oldest", 40 * DAY)]), ["newer"], "all offline: the one seen last stays")
})

test("registrations that are online all stay, and so does a computer with another name", () => {
  assert.deepEqual(listed([computer("stable", MINUTE), computer("dev-build", 2 * MINUTE)]), ["stable", "dev-build"], "two apps open on one computer")
  assert.deepEqual(listed([computer("laptop", MINUTE), computer("studio", 14 * DAY, "Milo's Mac Studio")]), ["laptop", "studio"])
  assert.deepEqual(listed([computer("mac", MINUTE, "Front desk"), computer("pc", 14 * DAY, "Front desk", "win32")]), ["mac", "pc"], "one name on two platforms is two computers")
  assert.deepEqual(listed([computer("only", 14 * DAY)]), ["only"], "an offline computer with nothing newer is still listed")
})

test("a computer that never reported a name is never taken for another one", () => {
  assert.deepEqual(listed([computer("unnamed-new", MINUTE, null), computer("unnamed-old", 14 * DAY, null)]), ["unnamed-new", "unnamed-old"])
  assert.deepEqual(listed([computer("named", MINUTE), computer("unnamed", 14 * DAY, null)]), ["named", "unnamed"])
})

test("two registrations seen at the same moment keep the first", () => {
  assert.deepEqual(listed([computer("first", 14 * DAY), computer("second", 14 * DAY)]), ["first"])
})
