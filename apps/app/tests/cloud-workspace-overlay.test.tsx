import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { DenCloudInstance } from "../src/app/lib/den";
import { CloudWorkspaceOverlay, CloudWorkspaceStatusPanel } from "../src/react-app/shell/cloud-workspace-overlay";
import {
  cloudWorkspaceStatusHasReadyContent,
  cloudWorkspaceUpdateAvailable,
  mapCloudWorkspaceMainContentDecision,
  mapCloudWorkspaceState,
  shouldRefetchCloudWorkspaceOnReadyTransition,
} from "../src/react-app/shell/cloud-workspace-status";
import type { CloudWorkspaceMainContentDecision, CloudWorkspacePillVariant } from "../src/react-app/shell/cloud-workspace-status";

const originalWindow = globalThis.window;

function instance(input: Partial<DenCloudInstance> = {}): DenCloudInstance {
  return {
    status: input.status ?? "ready",
    url: input.url ?? "https://workspace.example.test",
    imageVersion: "imageVersion" in input ? input.imageVersion ?? null : "openwork-0.18.8",
    ...(typeof input.instanceName === "string" ? { instanceName: input.instanceName } : {}),
    latestVersion: "latestVersion" in input ? input.latestVersion ?? null : "openwork-0.18.8",
  };
}

describe("cloud workspace overlay state", () => {
  test("maps ready and current workers to the quiet Cloud pill", () => {
    const state = mapCloudWorkspaceState({ instance: instance(), updating: false });

    expect(state.variant).toBe("ready");
    expect(state.label).toBe("Cloud · v0.18.8");
    expect(state.statusLine).toBe("Connected · v0.18.8 (latest)");
    expect(state.latestLine).toBe("Latest: v0.18.8 (up to date)");
    expect(state.showUpdate).toBe(false);
  });

  test("maps a sandbox name to a quiet computer diagnostic line", () => {
    const state = mapCloudWorkspaceState({
      instance: instance({ instanceName: "den-daytona-worker-cloud-test" }),
      updating: false,
    });

    expect(state.computerLine).toBe("Computer: den-daytona-worker-cloud-test");
  });

  test("maps stale and legacy workers to Update available", () => {
    const stale = mapCloudWorkspaceState({
      instance: instance({ imageVersion: "openwork-0.18.2", latestVersion: "openwork-0.18.8" }),
      updating: false,
    });
    const legacyInstance = instance({ imageVersion: null, latestVersion: "openwork-0.18.8" });
    const legacy = mapCloudWorkspaceState({
      instance: legacyInstance,
      updating: false,
    });

    expect(stale.variant).toBe("stale");
    expect(stale.label).toBe("Update available");
    expect(stale.statusLine).toBe("Connected · v0.18.2 -> v0.18.8");
    expect(stale.versionLine).toBe("Version: v0.18.2");
    expect(stale.latestLine).toBe("Latest: v0.18.8");
    expect(stale.showUpdate).toBe(true);
    expect(cloudWorkspaceUpdateAvailable(legacyInstance)).toBe(true);
    expect(legacy.label).toBe("Update available");
    expect(legacy.versionLine).toBe("Version: Legacy workspace");
  });

  test("maps not-ready and failed workers to user-facing labels", () => {
    expect(mapCloudWorkspaceState({ instance: instance({ status: "waking" }), updating: false }).label)
      .toBe("Waking your workspace…");
    expect(mapCloudWorkspaceState({ instance: instance({ status: "provisioning" }), updating: false }).label)
      .toBe("Provisioning your workspace…");

    const failed = mapCloudWorkspaceState({ instance: instance({ status: "failed" }), updating: false });
    expect(failed.variant).toBe("failed");
    expect(failed.tone).toBe("amber");
    expect(failed.label).toBe("Workspace needs attention");
    expect(failed.showRetry).toBe(true);
  });

  test("keeps the pill in updating state after the user clicks update", () => {
    const state = mapCloudWorkspaceState({
      instance: instance({ imageVersion: "openwork-0.18.2", latestVersion: "openwork-0.18.8" }),
      updating: true,
    });

    expect(state.variant).toBe("updating");
    expect(state.label).toBe("Updating your workspace…");
    expect(state.showUpdate).toBe(false);
    expect(state.pollMs).toBe(5_000);
  });

  test("maps gateway main content decisions for every worker state", () => {
    const withoutReadyContent: [CloudWorkspacePillVariant, CloudWorkspaceMainContentDecision][] = [
      ["ready", "error"],
      ["stale", "error"],
      ["waking", "takeover"],
      ["provisioning", "takeover"],
      ["updating", "takeover"],
      ["failed", "takeover"],
    ];
    const withReadyContent: [CloudWorkspacePillVariant, CloudWorkspaceMainContentDecision][] = [
      ["ready", "content"],
      ["stale", "content"],
      ["waking", "content"],
      ["provisioning", "content"],
      ["updating", "content"],
      ["failed", "takeover"],
    ];

    for (const [status, decision] of withoutReadyContent) {
      expect(mapCloudWorkspaceMainContentDecision({ status, hasWorkspaces: false, gatewayMode: true })).toBe(decision);
    }
    for (const [status, decision] of withReadyContent) {
      expect(mapCloudWorkspaceMainContentDecision({ status, hasWorkspaces: true, gatewayMode: true })).toBe(decision);
    }
  });

  test("passes all cloud states through outside gateway mode", () => {
    const statuses: CloudWorkspacePillVariant[] = ["ready", "stale", "waking", "provisioning", "updating", "failed"];

    for (const status of statuses) {
      expect(mapCloudWorkspaceMainContentDecision({ status, hasWorkspaces: false, gatewayMode: false })).toBe("content");
      expect(mapCloudWorkspaceMainContentDecision({ status, hasWorkspaces: true, gatewayMode: false })).toBe("content");
    }
  });

  test("does not allow not-found errors before a gateway worker is ready", () => {
    const notReady: CloudWorkspacePillVariant[] = ["waking", "provisioning", "updating", "failed"];

    for (const status of notReady) {
      expect(cloudWorkspaceStatusHasReadyContent(status)).toBe(false);
      expect(mapCloudWorkspaceMainContentDecision({ status, hasWorkspaces: false, gatewayMode: true })).toBe("takeover");
    }
    expect(mapCloudWorkspaceMainContentDecision({ status: "ready", hasWorkspaces: false, gatewayMode: true })).toBe("error");
    expect(mapCloudWorkspaceMainContentDecision({ status: "stale", hasWorkspaces: false, gatewayMode: true })).toBe("error");
  });

  test("fires a refetch callback when gateway workers transition back to ready", () => {
    let refetches = 0;
    if (shouldRefetchCloudWorkspaceOnReadyTransition({
      previousStatus: "waking",
      nextStatus: "ready",
      gatewayMode: true,
    })) {
      refetches += 1;
    }

    expect(refetches).toBe(1);
    expect(shouldRefetchCloudWorkspaceOnReadyTransition({
      previousStatus: "provisioning",
      nextStatus: "stale",
      gatewayMode: true,
    })).toBe(true);
    expect(shouldRefetchCloudWorkspaceOnReadyTransition({
      previousStatus: "waking",
      nextStatus: "ready",
      gatewayMode: false,
    })).toBe(false);
    expect(shouldRefetchCloudWorkspaceOnReadyTransition({
      previousStatus: "ready",
      nextStatus: "ready",
      gatewayMode: true,
    })).toBe(false);
  });
});

describe("cloud workspace overlay gateway gating", () => {
  afterEach(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
  });

  test("renders nothing outside gateway mode", () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: { origin: "https://instance.example.test" } },
    });

    expect(renderToStaticMarkup(<CloudWorkspaceOverlay />)).toBe("");
  });
});

describe("cloud workspace overlay diagnostics", () => {
  test("renders the computer diagnostic in the expanded panel when present", () => {
    const viewModel = mapCloudWorkspaceState({
      instance: instance({ instanceName: "den-daytona-worker-cloud-test" }),
      updating: false,
    });

    const html = renderToStaticMarkup(
      <CloudWorkspaceStatusPanel
        viewModel={viewModel}
        updating={false}
        onRefresh={() => {}}
        onSignOut={() => {}}
        onUpdateNow={() => {}}
      />,
    );

    expect(html).toContain("Computer: den-daytona-worker-cloud-test");
    expect(html).toContain("cloud-workspace-computer-line");
  });

  test("omits the computer diagnostic from the expanded panel when absent", () => {
    const viewModel = mapCloudWorkspaceState({ instance: instance(), updating: false });

    const html = renderToStaticMarkup(
      <CloudWorkspaceStatusPanel
        viewModel={viewModel}
        updating={false}
        onRefresh={() => {}}
        onSignOut={() => {}}
        onUpdateNow={() => {}}
      />,
    );

    expect(html).not.toContain("Computer:");
    expect(html).not.toContain("cloud-workspace-computer-line");
  });
});
