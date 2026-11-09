import assert from "node:assert/strict"
import { test } from "node:test"
import { BUILD_RELOAD_WINDOW_MS, shouldReloadForNewBuild } from "../src/client/stale-build.js"

test("a tab reloads for a new build once, then not again until the window has passed", () => {
  const now = 1_800_000_000_000
  assert.equal(shouldReloadForNewBuild(null, now), true)
  // The reload did not help: the file is really missing, and reloading again would loop.
  assert.equal(shouldReloadForNewBuild(now - 1_000, now), false)
  assert.equal(shouldReloadForNewBuild(now - BUILD_RELOAD_WINDOW_MS + 1, now), false)
  // A later deploy is a new reason.
  assert.equal(shouldReloadForNewBuild(now - BUILD_RELOAD_WINDOW_MS, now), true)
  // What was stored is not a time, or the clock moved back: neither blocks the reload.
  assert.equal(shouldReloadForNewBuild(Number("not a time"), now), true)
  assert.equal(shouldReloadForNewBuild(now + 60_000, now), true)
  // Offline, the file is out of reach, not replaced by a new build.
  assert.equal(shouldReloadForNewBuild(null, now, false), false)
})
