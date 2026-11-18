/**
 * What an idle conversation asks of its host: nothing. On celld a job that always wants another run is an alarm that
 * wakes the cell (every conversation, once a day, for ever), and a woken cell stays in memory for a while.
 */
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { loadConfig } from "../src/config.js"
import { nodeSqlite } from "../src/node-sqlite.js"
import { createRuntime } from "../src/runtime.js"
import { Store } from "../src/store.js"

test("a conversation with nothing to do asks for no alarm, with the Den index, self-resume and sealing on", async () => {
  const files = mkdtempSync(join(tmpdir(), "idle-upkeep-"))
  const store = new Store(nodeSqlite(":memory:"))
  try {
    // Production's shape: the Den index and self-resume (the three Den settings) and sealing over a files store.
    const config = loadConfig({
      HEADLESS_API_TOKEN: "r".repeat(32),
      HEADLESS_MODEL_PROTOCOL: "openai",
      HEADLESS_MODEL_BASE_URL: "https://models.test/v1",
      HEADLESS_MODEL: "test-model",
      HEADLESS_MODEL_API_KEY: "test-key",
      HEADLESS_FILES: "disk",
      HEADLESS_FILES_DIR: files,
      HEADLESS_SEGMENTS: "on",
      HEADLESS_DEN_API_URL: "https://den.test",
      HEADLESS_DEN_CALLBACK_TOKEN: "c".repeat(32),
      HEADLESS_GRANT_KEY: "g".repeat(32),
    })
    const runtime = await createRuntime(config, store)
    store.putSession("hs_idle_chat_0001", { title: "Idle" })
    // The one look every start gets (the sealer counts what the store holds), run as a cell's first alarm runs it.
    await runtime.background.runDue()
    // These three are what a cell sets its alarm from (worker/index.ts, armResume).
    assert.equal(runtime.background.nextAt(), null, "no upkeep job wants another run")
    assert.equal(runtime.selfResume?.nextSweepAt() ?? null, null)
    assert.equal(runtime.runner.nextStepAt(), null)
  } finally {
    store.close()
    rmSync(files, { recursive: true, force: true })
  }
})
