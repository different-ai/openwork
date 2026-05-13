// Unit tests for apps/desktop/electron/openshell/openeral-terminal.mjs.
// Only the pure-function helpers (deriveOpenEralSandboxName) are tested
// here. The actual terminal launchers (launchExternalTerminalToSandbox)
// are OS-spawn glue with platform branches — they're covered by manual
// testing on each platform and by the Phase 10 E2E spec on Windows.

import test from "node:test";
import assert from "node:assert/strict";

const { deriveOpenEralSandboxName } = await import(
  "../../electron/openshell/openeral-terminal.mjs"
);

test("deriveOpenEralSandboxName: trivial workspace id", () => {
  assert.equal(deriveOpenEralSandboxName("myworkspace"), "openeral-myworkspace");
});

test("deriveOpenEralSandboxName: lowercases the id", () => {
  assert.equal(deriveOpenEralSandboxName("MyWorkspace"), "openeral-myworkspace");
});

test("deriveOpenEralSandboxName: replaces punctuation with dashes", () => {
  assert.equal(
    deriveOpenEralSandboxName("My Workspace / Q3 + analysis"),
    "openeral-my-workspace-q3-analysis",
  );
});

test("deriveOpenEralSandboxName: collapses repeated and trims edge dashes", () => {
  assert.equal(deriveOpenEralSandboxName("---abc---"), "openeral-abc");
});

test("deriveOpenEralSandboxName: preserves dots, dashes, underscores", () => {
  assert.equal(
    deriveOpenEralSandboxName("foo_bar.v1-q3"),
    "openeral-foo_bar.v1-q3",
  );
});

test("deriveOpenEralSandboxName: caps length at 50 chars (plus prefix)", () => {
  const long = "x".repeat(80);
  const out = deriveOpenEralSandboxName(long);
  // "openeral-" (9 chars) + 50 sanitized chars
  assert.equal(out, `openeral-${"x".repeat(50)}`);
});

test("deriveOpenEralSandboxName: throws on empty input", () => {
  assert.throws(() => deriveOpenEralSandboxName(""), /empty workspace id/i);
});

test("deriveOpenEralSandboxName: throws on whitespace-only input after sanitization", () => {
  assert.throws(() => deriveOpenEralSandboxName("   "), /empty workspace id/i);
});

test("deriveOpenEralSandboxName: throws on punctuation-only input", () => {
  assert.throws(() => deriveOpenEralSandboxName("///"), /empty workspace id/i);
});

test("deriveOpenEralSandboxName: same input always produces same output (portability story)", () => {
  // OpenEral's cross-machine restore relies on this being deterministic
  // and stable across runs — the sandbox name is the workspace identity.
  const a = deriveOpenEralSandboxName("Q3 Earnings");
  const b = deriveOpenEralSandboxName("Q3 Earnings");
  assert.equal(a, b);
  assert.equal(a, "openeral-q3-earnings");
});
