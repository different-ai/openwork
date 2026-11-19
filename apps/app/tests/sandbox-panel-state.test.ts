import { expect, test } from "bun:test";
import type { OpenworkSandboxSettingsResponse, OpenworkSandboxStatusResponse } from "@/app/lib/openwork-server";
import { sandboxEstimateText, sandboxImageSize, sandboxPanelState, sandboxStatusView, sandboxToggleUpdate } from "@/react-app/domains/settings/panels/sandbox-panel-state";

const off: OpenworkSandboxSettingsResponse = {
  featureEnabled: false, useSandbox: false, forceSandbox: false,
  effectiveUseSandbox: false, effectiveForceSandbox: false, managedUse: false, managedForce: false,
  pending: false, verification: "verified", allowHostExecution: true, effectiveAllowHostExecution: true, managed: false,
};
const statuses: OpenworkSandboxSettingsResponse["verification"][] = ["checking", "verified", "unavailable"];

test("visibility depends on the rollout, saved choice, policy and pending state, not verification", () => {
  for (const verification of statuses)
    for (const featureEnabled of [false, true])
      for (const local of [{}, { useSandbox: true }, { forceSandbox: true }])
        for (const org of [{}, { managedUse: true }, { managedForce: true }])
          for (const pending of [false, true]) {
            const settings = { ...off, ...local, ...org, verification, featureEnabled, pending };
            expect(sandboxPanelState(settings).visible).toBe(Boolean(featureEnabled || Object.keys(local).length || Object.keys(org).length || pending));
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
