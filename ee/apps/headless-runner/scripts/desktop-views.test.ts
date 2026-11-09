import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { DESKTOP_TOOL } from "../../../packages/headless-computer/src/desktop-tool.js"
import { desktopPrompt, desktopToolsFor, desktopViewRefused } from "../src/desktop-views.js"
import { nodeSqlite } from "../src/node-sqlite.js"
import { Store } from "../src/store.js"

type Schema = { properties: { view: { enum: string[] }; operation: { enum: string[] } } }

test("a conversation keeps the desktop views it may use, and every view is the default", () => {
  const directory = mkdtempSync(join(tmpdir(), "headless-views-"))
  const store = new Store(nodeSqlite(join(directory, "runner.sqlite")), () => 1_000)
  try {
    const session = store.createSession({ owner: "owner", computer: true, desktop: true })
    assert.equal(store.getSession(session.id)?.desktopViews, null)
    store.putSession(session.id, { desktopViews: ["computer"] })
    assert.deepEqual(store.getSession(session.id)?.desktopViews, ["computer"])
    // An update that doesn't mention views keeps them.
    store.putSession(session.id, { title: "Renamed" })
    assert.deepEqual(store.getSession(session.id)?.desktopViews, ["computer"])
    store.putSession(session.id, { desktopViews: ["computer", "browser"] })
    assert.equal(store.getSession(session.id)?.desktopViews, null)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("browser recovery defaults off and persists on, unrelated updates, and an explicit reset", () => {
  const directory = mkdtempSync(join(tmpdir(), "headless-recovery-"))
  const path = join(directory, "runner.sqlite")
  try {
    const store = new Store(nodeSqlite(path), () => 1_000)
    const legacy = store.createSession({ owner: "owner", computer: true, desktop: true })
    assert.equal(store.getSession(legacy.id)?.browserRecovery, false)
    const enabled = store.createSession({ owner: "owner", computer: true, desktop: true, browserRecovery: true })
    assert.equal(store.getSession(enabled.id)?.browserRecovery, true)
    store.putSession(legacy.id, { browserRecovery: true })
    store.putSession(legacy.id, { title: "Renamed", desktopViews: ["browser"] })
    const restarted = new Store(nodeSqlite(path), () => 2_000)
    assert.equal(restarted.getSession(legacy.id)?.browserRecovery, true)
    assert.equal(restarted.getSession(enabled.id)?.browserRecovery, true)
    restarted.putSession(legacy.id, { browserRecovery: false })
    restarted.putSession(legacy.id, { title: "Still off" })
    assert.equal(new Store(nodeSqlite(path), () => 3_000).getSession(legacy.id)?.browserRecovery, false)
    assert.deepEqual(restarted.getSession(legacy.id)?.desktopViews, ["browser"], "reset keeps unrelated policy")
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("the desktop tool offers only the views a conversation may use", () => {
  assert.deepEqual(desktopToolsFor([DESKTOP_TOOL], null), [DESKTOP_TOOL])
  assert.deepEqual(desktopToolsFor([DESKTOP_TOOL], ["browser", "computer"]), [DESKTOP_TOOL])

  const browser = desktopToolsFor([DESKTOP_TOOL], ["browser"])[0]!.inputSchema as Schema
  assert.deepEqual(browser.properties.view.enum, ["browser"])
  assert.deepEqual(browser.properties.operation.enum, ["tabs", "open", "navigate", "observe", "act", "extract", "computer_run"])

  const computer = desktopToolsFor([DESKTOP_TOOL], ["computer"])[0]!.inputSchema as Schema
  assert.deepEqual(computer.properties.view.enum, ["computer"])
  assert.ok(computer.properties.operation.enum.every((name) => name.startsWith("computer_")))
  assert.ok(computer.properties.operation.enum.includes("computer_run"))

  assert.match(desktopPrompt(["browser"]), /the browser \(view browser only/)
  assert.match(desktopPrompt(null), /visible browser and native applications/)
})

test("a desktop call on a view the conversation may not use is refused", () => {
  assert.equal(desktopViewRefused(null, { view: "computer" }), null)
  assert.equal(desktopViewRefused(["browser"], { view: "browser", operation: "computer_run" }), null)
  assert.equal(desktopViewRefused(["browser"], { view: "computer", operation: "computer_launch" })?.isError, true)
  assert.equal(desktopViewRefused(["computer"], { view: "browser", operation: "open" })?.isError, true)
})
