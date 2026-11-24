import { expect, test } from "bun:test";
import type { OpenworkSandboxSettingsResponse, OpenworkSandboxStatusResponse } from "@/app/lib/openwork-server";
import { sandboxEditableToggleUpdate, sandboxEstimateText, sandboxImageSize, sandboxPanelState, sandboxPanelVisibility, sandboxRetryStarted, sandboxSavedChoiceMatches, sandboxStatusView, sandboxToggleUpdate } from "@/react-app/domains/settings/panels/sandbox-panel-state";

const off: OpenworkSandboxSettingsResponse = {
  featureEnabled: false, useSandbox: false, forceSandbox: false,
  effectiveUseSandbox: false, effectiveForceSandbox: false, managedUse: false, managedForce: false,
  pending: false, verification: "verified", allowHostExecution: true, effectiveAllowHostExecution: true, managed: false,
};
test("visibility and readiness for unknown, off and on rollouts", () => {
  const render = (visible: boolean, ready: boolean) => ({ visible, ready });
  for (const rollout of [undefined, false, true]) {
    expect(sandboxPanelVisibility(rollout, "loading")).toEqual(render(rollout === true, false));
    expect(sandboxPanelVisibility(rollout, "error")).toEqual(render(rollout === true, rollout !== undefined));
    expect(sandboxPanelVisibility(rollout, "settled", null)).toEqual(render(rollout === true, rollout !== undefined));
    expect(sandboxPanelVisibility(rollout, "settled", { ...off, featureEnabled: true, verification: "checking" })).toEqual(render(rollout === true, rollout !== undefined));
    for (const reason of [{ managedUse: true }, { managedForce: true }, { useSandbox: true }, { forceSandbox: true }, { pending: true }]) {
      expect(sandboxPanelVisibility(rollout, "settled", { ...off, ...reason })).toEqual(render(true, true));
    }
  }
});

test("Force includes Use; organization locks leave stricter choices editable", () => {
  expect(sandboxPanelState(off, sandboxToggleUpdate("force", true))).toMatchObject({ use: true, force: true, useNote: "included", forceNote: null });
  expect(sandboxPanelState({ ...off, managedUse: true })).toMatchObject({ use: true, force: false, useNote: "managed", forceNote: null });
  expect(sandboxPanelState({ ...off, managedForce: true })).toMatchObject({ use: true, force: true, useNote: "managed", forceNote: "managed", unavailable: true });
  expect(sandboxToggleUpdate("use", false)).toEqual({ useSandbox: false, forceSandbox: false });
  expect(sandboxPanelState({ ...off, pending: true, effectiveForceSandbox: true })).toMatchObject({ use: false, force: false, pending: "sandbox" });
  expect(sandboxPanelState({ ...off, pending: true, forceSandbox: true })).toMatchObject({ use: true, force: true, pending: "computer" });
});

test("toggle payloads only write editable choices", () => {
  const toggleUseOff = { setting: "use", checked: false } satisfies Parameters<typeof sandboxEditableToggleUpdate>[1];
  const toggleForceOn = { setting: "force", checked: true } satisfies Parameters<typeof sandboxEditableToggleUpdate>[1];
  expect(sandboxEditableToggleUpdate(off, toggleUseOff)).toEqual({ useSandbox: false, forceSandbox: false });
  expect(sandboxEditableToggleUpdate({ ...off, managedUse: true }, toggleUseOff)).toBeNull();
  expect(sandboxEditableToggleUpdate({ ...off, managedForce: true }, toggleUseOff)).toBeNull();
  expect(sandboxEditableToggleUpdate({ ...off, managedForce: true }, toggleForceOn)).toBeNull();
  expect(sandboxEditableToggleUpdate({ ...off, managedUse: true }, toggleForceOn)).toEqual({ forceSandbox: true });
  expect(sandboxToggleUpdate("force", false)).toEqual({ forceSandbox: false });
});

test("an uncertain save succeeds only when the saved fields match", () => {
  expect(sandboxSavedChoiceMatches(null, { forceSandbox: true })).toBe(false);
  expect(sandboxSavedChoiceMatches({ ...off, managedForce: true, effectiveForceSandbox: true }, { forceSandbox: true })).toBe(false);
  expect(sandboxSavedChoiceMatches({ ...off, useSandbox: true, forceSandbox: true, pending: true }, { forceSandbox: true })).toBe(true);
  expect(sandboxSavedChoiceMatches({ ...off, useSandbox: true }, { forceSandbox: false })).toBe(true);
  expect(sandboxSavedChoiceMatches({ ...off, useSandbox: true }, { useSandbox: false, forceSandbox: false })).toBe(false);
  expect(sandboxSavedChoiceMatches({ ...off, effectiveForceSandbox: true, pending: true }, { useSandbox: false, forceSandbox: false })).toBe(true);
});

const status: OpenworkSandboxStatusResponse = {
  mode: "use", state: "preparing", steps: [{ id: "download", state: "active", totalBytes: 25_000_000, completedBytes: 10_000_000 }],
  imageBytes: 25_000_000, imageSource: "bundled", estimatedRemainingMs: 9999, startedAt: null, readyAt: null, lastPrepareMs: null, folders: [], error: null,
};

test("progress uses byte totals, source, step order and estimate", () => {
  expect(sandboxStatusView(status, true)).toEqual({ kind: "progress", estimate: "About 10 seconds left", steps: [
    { id: "download", label: "Preparing the sandbox, about 25 MB", state: "active", value: 40 },
    { id: "start", label: "Starting", state: "waiting", value: 0 },
    { id: "folders", label: "Connecting your folders", state: "waiting", value: 0 },
  ] });
  expect(sandboxStatusView({ ...status, imageSource: "download", steps: [{ id: "download", state: "active" }] }, true)).toMatchObject({ steps: [{ label: "Downloading the sandbox, about 25 MB", value: null }, {}, {}] });
  expect(sandboxStatusView(status, false)).toEqual({ kind: "none" });
  expect(sandboxImageSize(null)).toBeNull();
  expect(sandboxImageSize(25_800_000)).toBe(26);
  expect(sandboxEstimateText(1)).toBe("About 1 second left");
  expect(sandboxEstimateText(null)).toBeNull();
});

test("ready reports folder access; failure offers only applicable retry", () => {
  const folders: OpenworkSandboxStatusResponse["folders"] = [{ path: "/project", access: "rw", kind: "workspace" }, { path: "/files", access: "ro", kind: "folder" }];
  const error: NonNullable<OpenworkSandboxStatusResponse["error"]> = { code: "image_failed", message: "Couldn't download the sandbox.", action: "Check your connection.", retryable: true };
  expect(sandboxStatusView({ ...status, state: "ready", folders }, true)).toEqual({ kind: "ready", folders });
  expect(sandboxStatusView({ ...status, state: "failed", error }, true)).toEqual({ kind: "failed", error, retry: true });
  expect(sandboxStatusView({ ...status, state: "failed", error: { ...error, retryable: false } }, true)).toMatchObject({ retry: false });
  expect(sandboxStatusView({ ...status, state: "unsupported", error }, true)).toEqual({ kind: "unsupported", error, retry: false });
});

test("Retry shows setup starting again at once instead of the old error", () => {
  const failed: OpenworkSandboxStatusResponse = {
    mode: "force", state: "failed", imageSource: "bundled", imageBytes: 4_134_912, estimatedRemainingMs: null,
    startedAt: 1, readyAt: null, lastPrepareMs: 900, folders: [],
    steps: [{ id: "download", state: "done" }, { id: "start", state: "active" }, { id: "folders", state: "waiting" }],
    error: { code: "start_failed", message: "The sandbox couldn't start. Nothing ran.", action: "Try again.", retryable: true },
  };
  const retried = sandboxRetryStarted(failed);
  expect(retried).toMatchObject({ mode: "force", state: "preparing", error: null, imageBytes: 4_134_912 });
  expect(retried?.steps.map((step) => step.state)).toEqual(["active", "waiting", "waiting"]);
  expect(sandboxStatusView(retried, true).kind).toBe("progress");
  expect(sandboxRetryStarted(null)).toBeNull();
});
