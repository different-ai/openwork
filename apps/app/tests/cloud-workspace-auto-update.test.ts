import { describe, expect, test } from "bun:test";

import {
  CLOUD_AUTO_UPDATE_HIDDEN_MS,
  CLOUD_AUTO_UPDATE_INPUT_IDLE_MS,
  cloudWorkspaceUpdateDeferredLine,
  isUserAway,
  mapCloudWorkspaceState,
  shouldAutoUpdateCloudWorkspace,
} from "../src/react-app/shell/cloud-workspace-status";

type AutoUpdateInput = Parameters<typeof shouldAutoUpdateCloudWorkspace>[0];

const eligible: AutoUpdateInput = {
  gatewayMode: true,
  visible: true,
  away: true,
  status: "ready",
  updateAvailable: true,
  updating: false,
  requestFailed: false,
  hasActiveRun: false,
  latestVersion: "openwork-0.19.0",
  lastAttemptedVersion: null,
};

describe("cloud workspace auto-update", () => {
  test("nudges a signed-in, stale running gateway instance once the person is away and idle", () => {
    expect(shouldAutoUpdateCloudWorkspace(eligible)).toBe(true);
  });

  test("never starts while the person is present, and honors the retry window after a deferral", () => {
    expect(shouldAutoUpdateCloudWorkspace({ ...eligible, away: false })).toBe(false);
    expect(shouldAutoUpdateCloudWorkspace({ ...eligible, nowMs: 1_000, retryNotBeforeMs: 2_000 })).toBe(false);
    expect(shouldAutoUpdateCloudWorkspace({ ...eligible, nowMs: 2_000, retryNotBeforeMs: 2_000 })).toBe(true);
    expect(shouldAutoUpdateCloudWorkspace({ ...eligible, retryNotBeforeMs: null })).toBe(true);
  });

  test("counts a long-hidden tab or a long-untouched visible tab as away", () => {
    const now = 1_000_000_000;
    expect(isUserAway({ hiddenSinceMs: null, lastInputAtMs: now, nowMs: now })).toBe(false);
    expect(isUserAway({ hiddenSinceMs: now - CLOUD_AUTO_UPDATE_HIDDEN_MS + 1, lastInputAtMs: now, nowMs: now })).toBe(false);
    expect(isUserAway({ hiddenSinceMs: now - CLOUD_AUTO_UPDATE_HIDDEN_MS, lastInputAtMs: now, nowMs: now })).toBe(true);
    expect(isUserAway({ hiddenSinceMs: null, lastInputAtMs: now - CLOUD_AUTO_UPDATE_INPUT_IDLE_MS + 1, nowMs: now })).toBe(false);
    expect(isUserAway({ hiddenSinceMs: null, lastInputAtMs: now - CLOUD_AUTO_UPDATE_INPUT_IDLE_MS, nowMs: now })).toBe(true);
  });

  test("explains a deferred update on the stale pill without a failure state", () => {
    const instance = {
      status: "ready" as const,
      url: "https://workspace.example.test",
      imageVersion: "openwork-0.18.2",
      latestVersion: "openwork-0.18.8",
    };
    const deferred = mapCloudWorkspaceState({ instance, updating: false, accessRequired: false, updateDeferred: "busy" });
    expect(deferred.variant).toBe("stale");
    expect(deferred.label).toBe("Update available");
    expect(deferred.showUpdate).toBe(true);
    expect(deferred.statusLine).toBe(cloudWorkspaceUpdateDeferredLine("busy"));
    expect(deferred.statusLine).toContain("applies when your current work finishes");
    expect(mapCloudWorkspaceState({ instance, updating: false, accessRequired: false, updateDeferred: "activity_unknown" }).statusLine)
      .toBe(cloudWorkspaceUpdateDeferredLine("activity_unknown"));
    expect(mapCloudWorkspaceState({ instance, updating: false, accessRequired: false }).statusLine)
      .toBe("Connected · v0.18.2 -> v0.18.8");
  });

  test("skips ineligible instance and client states", () => {
    const ineligible: AutoUpdateInput[] = [
      { ...eligible, gatewayMode: false },
      { ...eligible, visible: false },
      { ...eligible, away: false },
      { ...eligible, status: "waking" },
      { ...eligible, status: "provisioning" },
      { ...eligible, status: "failed" },
      { ...eligible, updating: true },
      { ...eligible, requestFailed: true },
      { ...eligible, hasActiveRun: true },
      { ...eligible, lastAttemptedVersion: "openwork-0.19.0" },
      { ...eligible, latestVersion: null },
    ];

    for (const input of ineligible) {
      expect(shouldAutoUpdateCloudWorkspace(input)).toBe(false);
    }
  });

  test("allows a new attempt when the target version changes", () => {
    expect(shouldAutoUpdateCloudWorkspace({
      ...eligible,
      lastAttemptedVersion: "openwork-0.19.0",
    })).toBe(false);
    expect(shouldAutoUpdateCloudWorkspace({
      ...eligible,
      latestVersion: "openwork-0.20.0",
      lastAttemptedVersion: "openwork-0.19.0",
    })).toBe(true);
  });
});
