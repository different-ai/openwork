import assert from "node:assert/strict";

import { latestSessionErrorTurnTime, shouldResetRunState } from "../src/app/session/run-state";

assert.equal(latestSessionErrorTurnTime([]), null);
assert.equal(
  latestSessionErrorTurnTime([
    { id: "session-error:test:0", text: "older", afterMessageID: null, time: 10 },
    { id: "session-error:test:1", text: "latest", afterMessageID: "message-1", time: 25 },
  ]),
  25,
);

assert.equal(
  shouldResetRunState({
    hasError: false,
    sessionStatus: "idle",
    runHasBegun: true,
    runStartedAt: 100,
    latestErrorTurnTime: null,
  }),
  true,
);

assert.equal(
  shouldResetRunState({
    hasError: false,
    sessionStatus: "idle",
    runHasBegun: false,
    runStartedAt: 100,
    latestErrorTurnTime: 120,
  }),
  true,
);

assert.equal(
  shouldResetRunState({
    hasError: false,
    sessionStatus: "idle",
    runHasBegun: false,
    runStartedAt: 100,
    latestErrorTurnTime: 80,
  }),
  false,
);

assert.equal(
  shouldResetRunState({
    hasError: false,
    sessionStatus: "running",
    runHasBegun: false,
    runStartedAt: 100,
    latestErrorTurnTime: 120,
  }),
  false,
);

assert.equal(
  shouldResetRunState({
    hasError: false,
    sessionStatus: "idle",
    runHasBegun: false,
    runStartedAt: null,
    latestErrorTurnTime: 120,
  }),
  false,
);

assert.equal(
  shouldResetRunState({
    hasError: true,
    sessionStatus: "idle",
    runHasBegun: false,
    runStartedAt: 100,
    latestErrorTurnTime: null,
  }),
  true,
);

console.log(
  JSON.stringify({
    ok: true,
    cases: [
      "picks latest session error turn",
      "resets completed runs when the session returns idle",
      "resets immediate failed sends after a synthetic session error turn",
      "resets immediate failures that only surface a session-level error banner",
      "ignores stale prior errors",
      "does not reset while the session is still active",
    ],
  }),
);
