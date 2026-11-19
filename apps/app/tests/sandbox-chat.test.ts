import { expect, test } from "bun:test";
import type { DynamicToolUIPart } from "ai";
import type { OpenworkSandboxSettingsResponse, OpenworkSandboxStatusResponse } from "@/app/lib/openwork-server";
import { sandboxRunningToolStep } from "@/lib/tool-activity";
import { sandboxPillView } from "@/react-app/kernel/sandbox-chat";
import { sandboxToolRenderer } from "@/lib/build-in-tools";
import { sandboxSendDisposition, sandboxTransitionNote } from "@/react-app/kernel/sandbox-transition";
import { parseDynamicToolUIPart } from "@/react-app/domains/session/sync/parse-tool-parts";
import { describeTaskCreateFailure } from "@/react-app/shell/route-workspaces";

for (const [source, renderer] of Object.entries({ sandbox_shell: "bash", sandbox_read: "read", sandbox_write: "write", sandbox_edit: "edit", sandbox_glob: "glob", sandbox_grep: "grep", read: "read" })) {
  test(`${source} uses the ${renderer} renderer and keeps the sandbox result marker`, () => {
    expect(sandboxToolRenderer(source)).toBe(renderer);
    const part = parseDynamicToolUIPart({ type: "tool", id: "part", sessionID: "s", messageID: "m", callID: "c", tool: source,
      state: { status: "completed", input: {}, output: "result", title: "", metadata: { sandbox: true }, time: { start: 1, end: 2 } },
    });
    expect(part).toMatchObject({ toolName: renderer, callProviderMetadata: { openwork: { sandbox: true } } });
  });
}

const off: OpenworkSandboxSettingsResponse = {
  featureEnabled: true, useSandbox: false, forceSandbox: false,
  effectiveUseSandbox: false, effectiveForceSandbox: false, managedUse: false, managedForce: false,
  pending: false, verification: "verified", allowHostExecution: true, effectiveAllowHostExecution: true, managed: false,
};
const status: OpenworkSandboxStatusResponse = {
  mode: "use", state: "ready", steps: [], imageBytes: null, imageSource: "bundled", estimatedRemainingMs: null,
  startedAt: null, readyAt: null, lastPrepareMs: null, folders: [], error: null,
};

test("the pill uses effective settings even when status mode is stale", () => {
  expect(sandboxPillView(off, status)).toBeNull();
  expect(sandboxPillView({ ...off, pending: true, forceSandbox: true }, status)).toBeNull();
  const use = { ...off, effectiveUseSandbox: true };
  const force = { ...off, effectiveForceSandbox: true };
  expect(sandboxPillView(use, { ...status, mode: "off", state: "off" })).toEqual({ label: "Sandbox", step: null, attention: false });
  expect(sandboxPillView(force, undefined)).toEqual({ label: "Sandbox only", step: null, attention: false });
  expect(sandboxPillView(force, { ...status, state: "preparing" })).toEqual({ label: "Sandbox only", step: "Starting the sandbox…", attention: false });
  expect(sandboxPillView(use, { ...status, state: "unsupported" })).toEqual({ label: "Sandbox", step: null, attention: true });
});

test("preparation is only shown on running, structured sandbox calls", () => {
  const part: DynamicToolUIPart = { type: "dynamic-tool", toolCallId: "c", toolName: "bash", state: "input-available", input: {} };
  const step = "Starting the sandbox…";
  expect(sandboxRunningToolStep(part, true, step)).toBeNull();
  const sandbox = { ...part, toolName: "sandbox_shell" };
  expect(sandboxRunningToolStep(sandbox, false, step)).toBeNull();
  expect(sandboxRunningToolStep(sandbox, true, null)).toBeNull();
  expect(sandboxRunningToolStep(sandbox, true, step)).toBe(step);
  expect(sandboxRunningToolStep({ ...part, callProviderMetadata: { openwork: { sandbox: true } } }, true, step)).toBe(step);
  expect(sandboxRunningToolStep({ ...part, state: "output-error", errorText: "sandbox is restarting" }, true, step)).toBeNull();
  expect(sandboxRunningToolStep({ ...sandbox, state: "output-error", errorText: "sandbox updating" }, true, step)).toBeNull();
  expect(sandboxRunningToolStep({ ...sandbox, state: "output-available", output: "Done" }, true, step)).toBeNull();
});

test("task creation toast unwraps unrelated JSON proxy errors", () => {
  expect(describeTaskCreateFailure(new Error('{"code":"permission_denied","message":"Choose a different project."}'), 1).description).toBe("Choose a different project.");
});

test.each(["sandbox_engine_busy", "sandbox_engine_policy_pending", "sandbox_engine_activity_unavailable"])("%s produces a neutral transition note", (code) => {
  expect(sandboxTransitionNote(new Error(JSON.stringify({ code, message: "Old response." })))).toBe("Your sandbox setting applies when current tasks finish. Send this again then.");
  expect(sandboxTransitionNote({ code, status: 400 })).toBeNull();
});

test("keeps the plain server message and only defers recognized transition errors", () => {
  const message = "Your sandbox setting is saved and applies when current tasks finish. Send this again then.";
  expect(sandboxTransitionNote({ status: 409, code: "sandbox_engine_policy_pending", message })).toBe(message);
  expect(sandboxTransitionNote({ status: 503, error: "engine_v2_preview_not_running" }, true)).toBe("Applying your sandbox setting…");
  expect(sandboxSendDisposition(new Error('{"code":"engine_v2_preview_not_running"}'))).toEqual({ kind: "deferred", note: "Applying your sandbox setting…" });
  expect(sandboxSendDisposition({ status: 409, code: "sandbox_engine_policy_pending", message })).toEqual({ kind: "deferred", note: message });
  expect(sandboxSendDisposition({ status: 409, code: "unrelated" })).toEqual({ kind: "failed" });
  expect(sandboxTransitionNote({ status: 503, error: "unrelated" }, true)).toBeNull();
});
