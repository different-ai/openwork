import { expect, test } from "bun:test";
import {
  createSingleFlight,
  resolveAdmissionOutcome,
  type AdmissionOutcomeInput,
} from "../src/react-app/domains/session/surface/session-admission-outcome";

type Messages = AdmissionOutcomeInput["messages"];

function userMessage(id: string, text: string): Messages[number] {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

function assistantMessage(id: string, text: string): Messages[number] {
  return { id, role: "assistant", parts: [{ type: "text", text }] };
}

function emptyAssistantMessage(id: string): Messages[number] {
  return { id, role: "assistant", parts: [{ type: "step-start" }] };
}

function outcome(messages: Messages, overrides: Partial<AdmissionOutcomeInput> = {}) {
  return resolveAdmissionOutcome({
    messages,
    statusType: "idle",
    sending: false,
    hasActiveQuestion: false,
    hasActivePermission: false,
    hasSessionError: false,
    ...overrides,
  });
}

test("accepted admission that reaches idle with no assistant result is unresolved, not plain idle", () => {
  // The reported failure shape: the session and user message were created
  // (admission accepted), the engine returned to idle, and no assistant
  // message exists. The appended user message used to satisfy the
  // transcript-length check and silently clear the wait state after ~1.2s.
  const accepted: Messages = [
    assistantMessage("a0", "previous turn"),
    userMessage("u1", "do the thing"),
  ];
  expect(outcome(accepted)).toBe("unresolved");

  // A brand-new session whose only message is the accepted user message —
  // exactly the length-check false positive — must also stay unresolved.
  expect(outcome([userMessage("u1", "first ever message")])).toBe("unresolved");

});

test("every accepted admission terminates in a supported terminal state", () => {
  const unanswered: Messages = [userMessage("u1", "do the thing")];

  // Still executing: busy/retry status or an in-flight submission is pending.
  expect(outcome(unanswered, { statusType: "busy" })).toBe("pending");
  expect(outcome(unanswered, { statusType: "retry" })).toBe("pending");
  expect(outcome(unanswered, { sending: true })).toBe("pending");

  // Needs input: question or permission waits are their own terminal surface.
  expect(outcome(unanswered, { hasActiveQuestion: true })).toBe("pending");
  expect(outcome(unanswered, { hasActivePermission: true })).toBe("pending");

  // Explicit error: the session error card owns recovery.
  expect(outcome(unanswered, { hasSessionError: true })).toBe("settled");

  // Assistant output followed by idle settles the admission.
  expect(outcome([userMessage("u1", "q"), assistantMessage("a1", "answer")])).toBe("settled");

  // An assistant message with no visible output is not a silent success.
  expect(outcome([userMessage("u1", "q"), emptyAssistantMessage("a1")])).toBe("unresolved");

  // No admission at all has nothing to recover.
  expect(outcome([])).toBe("settled");
  expect(outcome([assistantMessage("a0", "hello")])).toBe("settled");

});

test("the recovery state is a pure function of transcript and status, so it survives a reload", () => {
  const transcript: Messages = [
    assistantMessage("a0", "previous turn"),
    userMessage("u1", "do the thing"),
  ];
  const before = outcome(transcript);
  // A reload rehydrates the same server-persisted transcript and idle status;
  // recomputing from identical inputs must reproduce the recovery state.
  const rehydrated: Messages = transcript.map((message) => ({ ...message }));
  const after = outcome(rehydrated);
  expect(before).toBe("unresolved");
  expect(after).toBe("unresolved");
});

test("resume single-flight guard admits exactly one recovery prompt for rapid repeat clicks", async () => {
  const guard = createSingleFlight();
  let executions = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });

  const first = guard.run(async () => {
    executions += 1;
    await gate;
  });
  // Rapid second and third clicks while the first resume is in flight.
  const second = guard.run(async () => { executions += 1; });
  const third = guard.run(async () => { executions += 1; });
  expect(await second).toBe(false);
  expect(await third).toBe(false);
  expect(guard.inFlight).toBe(true);
  release?.();
  expect(await first).toBe(true);
  expect(executions).toBe(1);

  // A later deliberate click, after the first resolved, runs again.
  expect(await guard.run(async () => { executions += 1; })).toBe(true);
  expect(executions).toBe(2);

});
