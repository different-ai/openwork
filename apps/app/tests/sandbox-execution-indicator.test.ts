import { describe, expect, it } from "bun:test";
import type { OpenworkSandboxSettingsResponse } from "../src/app/lib/openwork-server";
import { sandboxExecutionIndicatorState } from "../src/react-app/domains/session/status/sandbox-execution-state";

const base: OpenworkSandboxSettingsResponse = {
  allowHostExecution: true, effectiveAllowHostExecution: true, pending: false, managed: false, featureEnabled: true,
};

describe("chat execution indicator", () => {
  it("does not claim sandbox execution with the rollout off or before authority is read", () => {
    expect(sandboxExecutionIndicatorState({ ...base, effectiveAllowHostExecution: false }, false)).toBeNull();
    expect(sandboxExecutionIndicatorState(null, true)).toBeNull();
    expect(sandboxExecutionIndicatorState(base, true)).toBeNull();
  });
  it("reports a saved pending choice without claiming the current computer task is isolated", () => {
    expect(sandboxExecutionIndicatorState({ ...base, allowHostExecution: false, pending: true }, true)?.state).toBe("pending");
  });
  it("reports applied sandbox execution while the opposite choice is pending", () => {
    expect(sandboxExecutionIndicatorState({ ...base, effectiveAllowHostExecution: false, pending: true }, true)).toMatchObject({
      state: "sandbox", detail: "context_panel.host_execution_pending_sandbox",
    });
  });
  it("distinguishes preparing and unavailable from a usable sandbox", () => {
    const selected = { ...base, allowHostExecution: false, effectiveAllowHostExecution: false };
    expect(sandboxExecutionIndicatorState({ ...selected, runtime: { state: "starting", canRetry: false } }, true)?.state).toBe("starting");
    expect(sandboxExecutionIndicatorState({ ...selected, runtime: { state: "ready", canRetry: false } }, true)?.state).toBe("sandbox");
    for (const state of ["unsupported", "failed"] satisfies ("unsupported" | "failed")[]) {
      expect(sandboxExecutionIndicatorState({ ...selected, runtime: { state, canRetry: true } }, true)?.state).toBe("unavailable");
    }
    expect(sandboxExecutionIndicatorState({ ...selected, featureEnabled: false }, true)?.state).toBe("unavailable");
  });
});
