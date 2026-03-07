/**
 * Test script for sidebar session guard logic.
 *
 * Verifies the fix for Issue #750: Session loss when switching workspaces.
 *
 * Run with: node packages/app/scripts/sidebar-sessions-guard.mjs
 */

import assert from "node:assert/strict";

/**
 * Determines whether the sidebar sessions should be updated.
 * This is the pure function extracted from app.tsx for testability.
 *
 * @param {Array<{id: string}>} currentSessions - Current sidebar sessions
 * @param {Array<{id: string}>} newSessions - New sessions from server
 * @returns {boolean} true if should update, false to preserve existing
 */
function shouldUpdateSidebarSessions(currentSessions, newSessions) {
  // Don't clear existing sidebar sessions if the session store is empty.
  // This can happen during worker restart/reconnect when the server hasn't fully loaded
  // its session database yet. Preserving existing sessions prevents the sidebar from
  // flickering empty during the reconnection window.
  if (currentSessions.length > 0 && newSessions.length === 0) {
    return false;
  }
  return true;
}

const results = {
  ok: true,
  tests: [],
};

function test(name, fn) {
  results.tests.push({ name, status: "running" });
  const idx = results.tests.length - 1;

  try {
    fn();
    results.tests[idx] = { name, status: "ok" };
  } catch (e) {
    results.ok = false;
    results.tests[idx] = {
      name,
      status: "error",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// Test 1: Empty current, empty new -> should update (no-op, but allowed)
test("empty current, empty new -> should update", () => {
  const current = [];
  const newSessions = [];
  assert.equal(shouldUpdateSidebarSessions(current, newSessions), true);
});

// Test 2: Empty current, non-empty new -> should update (normal load)
test("empty current, non-empty new -> should update", () => {
  const current = [];
  const newSessions = [{ id: "session-1" }];
  assert.equal(shouldUpdateSidebarSessions(current, newSessions), true);
});

// Test 3: Non-empty current, empty new -> should NOT update (guard triggers)
test("non-empty current, empty new -> should NOT update", () => {
  const current = [{ id: "session-1" }];
  const newSessions = [];
  assert.equal(shouldUpdateSidebarSessions(current, newSessions), false);
});

// Test 4: Non-empty current, non-empty new -> should update (normal refresh)
test("non-empty current, non-empty new -> should update", () => {
  const current = [{ id: "session-1" }];
  const newSessions = [{ id: "session-1" }, { id: "session-2" }];
  assert.equal(shouldUpdateSidebarSessions(current, newSessions), true);
});

// Test 5: Multiple current, empty new -> should NOT update (guard triggers)
test("multiple current, empty new -> should NOT update", () => {
  const current = [{ id: "session-1" }, { id: "session-2" }, { id: "session-3" }];
  const newSessions = [];
  assert.equal(shouldUpdateSidebarSessions(current, newSessions), false);
});

// Test 6: Multiple current, fewer new -> should update (deletion allowed)
test("multiple current, fewer new -> should update", () => {
  const current = [{ id: "session-1" }, { id: "session-2" }];
  const newSessions = [{ id: "session-1" }];
  assert.equal(shouldUpdateSidebarSessions(current, newSessions), true);
});

// Test 7: Single current, empty new -> should NOT update
test("single current, empty new -> should NOT update", () => {
  const current = [{ id: "only-session" }];
  const newSessions = [];
  assert.equal(shouldUpdateSidebarSessions(current, newSessions), false);
});

console.log(JSON.stringify(results, null, 2));

if (!results.ok) {
  process.exitCode = 1;
}
