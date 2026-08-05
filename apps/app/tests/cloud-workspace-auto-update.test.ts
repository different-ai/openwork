import { describe, expect, test } from "bun:test";

import { shouldAutoUpdateCloudWorkspace } from "../src/react-app/shell/cloud-workspace-status";

type AutoUpdateInput = Parameters<typeof shouldAutoUpdateCloudWorkspace>[0];

const eligible: AutoUpdateInput = {
  gatewayMode: true,
  visible: true,
  status: "ready",
  updateAvailable: true,
  updating: false,
  requestFailed: false,
  hasActiveRun: false,
  latestVersion: "micx-0.19.0",
  lastAttemptedVersion: null,
};

describe("cloud workspace auto-update", () => {
  test("nudges a visible, idle, stale running gateway instance", () => {
    expect(shouldAutoUpdateCloudWorkspace(eligible)).toBe(true);
  });

  test("skips ineligible instance and client states", () => {
    const ineligible: AutoUpdateInput[] = [
      { ...eligible, gatewayMode: false },
      { ...eligible, visible: false },
      { ...eligible, status: "waking" },
      { ...eligible, status: "provisioning" },
      { ...eligible, status: "failed" },
      { ...eligible, updating: true },
      { ...eligible, requestFailed: true },
      { ...eligible, hasActiveRun: true },
      { ...eligible, lastAttemptedVersion: "micx-0.19.0" },
      { ...eligible, latestVersion: null },
    ];

    for (const input of ineligible) {
      expect(shouldAutoUpdateCloudWorkspace(input)).toBe(false);
    }
  });

  test("allows a new attempt when the target version changes", () => {
    expect(shouldAutoUpdateCloudWorkspace({
      ...eligible,
      lastAttemptedVersion: "micx-0.19.0",
    })).toBe(false);
    expect(shouldAutoUpdateCloudWorkspace({
      ...eligible,
      latestVersion: "micx-0.20.0",
      lastAttemptedVersion: "micx-0.19.0",
    })).toBe(true);
  });
});
