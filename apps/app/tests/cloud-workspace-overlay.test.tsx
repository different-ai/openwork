import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { DenApiError, type DenCloudInstance } from "../src/app/lib/den";
import {
  CloudWorkspaceBootTakeover,
  CloudWorkspaceOverlay,
  CloudWorkspaceStatusContext,
  CloudWorkspaceStatusPanel,
  cloudWorkspaceRequestFailureLogFields,
} from "../src/react-app/shell/cloud-workspace-overlay";
import {
  CLOUD_WORKSPACE_SLOW_BOOT_MS,
  cloudWorkspaceBootIsSlow,
  cloudWorkspaceBootStages,
  cloudWorkspaceFailureLogFields,
  cloudWorkspaceStatusHasReadyContent,
  cloudWorkspaceTakeoverCopy,
  cloudWorkspaceUpdateAvailable,
  formatCloudWorkspaceElapsed,
  mapCloudWorkspaceMainContentDecision,
  mapCloudWorkspaceState,
  shouldShowCloudWorkspaceStatusPill,
  shouldRefetchCloudWorkspaceOnReadyTransition,
  shouldSuppressBootOverlayForGateway,
} from "../src/react-app/shell/cloud-workspace-status";
import type { CloudWorkspaceMainContentDecision, CloudWorkspacePillVariant } from "../src/react-app/shell/cloud-workspace-status";
import { PlatformProvider, type Platform } from "../src/react-app/kernel/platform";
import { BootStateProvider } from "../src/react-app/shell/boot-state";

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

function testPlatform(openLink: (url: string) => void = () => {}): Platform {
  return {
    platform: "web",
    capabilities: {
      nativeFilePicker: false,
      revealInFileManager: false,
      terminal: false,
      autoUpdate: false,
      osNotifications: false,
      localRuntimeControl: false,
      desktopBootstrap: false,
    },
    openLink,
    async restart() {},
    async notify() {},
  };
}

describe("cloud workspace overlay state", () => {
  test("formats safe browser diagnostics without raw response details", () => {
    expect(cloudWorkspaceFailureLogFields({
      code: "runtime_health_timeout",
      stage: "recovery",
      reference: "cwf_test",
      occurredAt: "2026-08-28T12:00:00.000Z",
    })).toEqual({
      failure_code: "runtime_health_timeout",
      failure_stage: "recovery",
      failure_reference: "cwf_test",
      failure_occurred_at: "2026-08-28T12:00:00.000Z",
    });
    expect(cloudWorkspaceRequestFailureLogFields(new DenApiError(
      503,
      "workspace_not_ready",
      "raw response with Bearer secret",
      { token: "secret" },
    ))).toEqual({ failure_code: "workspace_not_ready", http_status: 503 });
  });

  test("maps ready and current workers to a quiet status", () => {
    const state = mapCloudWorkspaceState({ instance: instance(), updating: false, accessRequired: false });

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
      accessRequired: false,
    });

    expect(state.computerLine).toBe("Computer: den-daytona-worker-cloud-test");
  });

  test("maps stale and legacy workers to Update available", () => {
    const stale = mapCloudWorkspaceState({
      instance: instance({ imageVersion: "openwork-0.18.2", latestVersion: "openwork-0.18.8" }),
      updating: false,
      accessRequired: false,
    });
    const legacyInstance = instance({ imageVersion: null, latestVersion: "openwork-0.18.8" });
    const legacy = mapCloudWorkspaceState({
      instance: legacyInstance,
      updating: false,
      accessRequired: false,
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
    expect(mapCloudWorkspaceState({ instance: instance({ status: "waking" }), updating: false, accessRequired: false }).label)
      .toBe("Waking your workspace…");
    expect(mapCloudWorkspaceState({ instance: instance({ status: "provisioning" }), updating: false, accessRequired: false }).label)
      .toBe("Provisioning your workspace…");

    const failed = mapCloudWorkspaceState({ instance: instance({ status: "failed" }), updating: false, accessRequired: false });
    expect(failed.variant).toBe("failed");
    expect(failed.tone).toBe("amber");
    expect(failed.label).toBe("Workspace needs attention");
    expect(failed.showRetry).toBe(true);

    const unavailable = mapCloudWorkspaceState({ instance: null, updating: false, accessRequired: false, requestFailed: true });
    expect(unavailable.variant).toBe("unavailable");
    expect(unavailable.label).toBe("Couldn’t check workspace");
    expect(unavailable.statusLine).toBe("Couldn’t check workspace status");
    expect(cloudWorkspaceTakeoverCopy({ variant: unavailable.variant, slow: false }).body)
      .toContain("sandbox may still be running");
  });

  test("prioritizes access-required state over request failure and stops polling", () => {
    const accessRequired = mapCloudWorkspaceState({
      instance: null,
      updating: false,
      accessRequired: true,
      requestFailed: true,
    });

    expect(accessRequired.variant).toBe("access-required");
    expect(accessRequired.label).toBe("OpenWork Web plan required");
    expect(accessRequired.showRetry).toBe(true);
    expect(accessRequired.pollMs).toBeNull();
  });

  test("uses active-plan guidance for access-required takeover copy", () => {
    expect(cloudWorkspaceTakeoverCopy({ variant: "access-required", slow: false })).toEqual({
      title: "OpenWork Web needs an active plan",
      body: "Your organization does not have an active OpenWork Web subscription or complimentary access. Get OpenWork Web in Den to start your cloud workspace.",
    });
  });

  test("shows the corner pill only for resolved degraded states", () => {
    expect(shouldShowCloudWorkspaceStatusPill({ variant: "waking", hasInstance: false, requestFailed: false })).toBe(false);
    expect(shouldShowCloudWorkspaceStatusPill({ variant: "waking", hasInstance: true, requestFailed: false })).toBe(true);
    expect(shouldShowCloudWorkspaceStatusPill({ variant: "provisioning", hasInstance: true, requestFailed: false })).toBe(true);
    expect(shouldShowCloudWorkspaceStatusPill({ variant: "failed", hasInstance: false, requestFailed: true })).toBe(true);
    expect(shouldShowCloudWorkspaceStatusPill({ variant: "unavailable", hasInstance: false, requestFailed: true })).toBe(true);
    expect(shouldShowCloudWorkspaceStatusPill({ variant: "ready", hasInstance: true, requestFailed: false })).toBe(false);
    expect(shouldShowCloudWorkspaceStatusPill({ variant: "stale", hasInstance: true, requestFailed: false })).toBe(false);
    expect(shouldShowCloudWorkspaceStatusPill({ variant: "updating", hasInstance: true, requestFailed: false })).toBe(false);
  });

  test("keeps the workspace status updating after the user clicks update", () => {
    const state = mapCloudWorkspaceState({
      instance: instance({ imageVersion: "openwork-0.18.2", latestVersion: "openwork-0.18.8" }),
      updating: true,
      accessRequired: false,
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
      ["access-required", "takeover"],
      ["unavailable", "takeover"],
      ["failed", "takeover"],
    ];
    const withReadyContent: [CloudWorkspacePillVariant, CloudWorkspaceMainContentDecision][] = [
      ["ready", "content"],
      ["stale", "content"],
      ["waking", "content"],
      ["provisioning", "content"],
      ["updating", "content"],
      ["access-required", "takeover"],
      ["unavailable", "content"],
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
    const statuses: CloudWorkspacePillVariant[] = ["ready", "stale", "waking", "provisioning", "updating", "access-required", "unavailable", "failed"];

    for (const status of statuses) {
      expect(mapCloudWorkspaceMainContentDecision({ status, hasWorkspaces: false, gatewayMode: false })).toBe("content");
      expect(mapCloudWorkspaceMainContentDecision({ status, hasWorkspaces: true, gatewayMode: false })).toBe("content");
    }
  });

  test("does not allow not-found errors before a gateway worker is ready", () => {
    const notReady: CloudWorkspacePillVariant[] = ["waking", "provisioning", "updating", "access-required", "unavailable", "failed"];

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

describe("cloud workspace boot stages", () => {
  test("derives one active checkpoint per booting state and none once ready", () => {
    const provisioning = cloudWorkspaceBootStages("provisioning");
    const waking = cloudWorkspaceBootStages("waking");

    // A provisioning sandbox is still being reserved; a waking one demonstrably
    // exists already, so its first checkpoint is genuinely done.
    expect(provisioning.map((stage) => stage.state)).toEqual(["active", "pending", "pending"]);
    expect(waking.map((stage) => stage.state)).toEqual(["done", "active", "pending"]);
    expect(provisioning[0].label).toBe("Reserving your computer");
    expect(waking[1].label).toBe("Restoring your files");

    expect(cloudWorkspaceBootStages("ready")).toEqual([]);
    expect(cloudWorkspaceBootStages("stale")).toEqual([]);
    expect(cloudWorkspaceBootStages("failed")).toEqual([]);
  });

  test("gives the update path its own checkpoint labels", () => {
    const updating = cloudWorkspaceBootStages("updating");

    expect(updating.map((stage) => stage.label)).toEqual([
      "Saving your session",
      "Applying the latest image",
      "Reconnecting the app",
    ]);
    expect(updating.map((stage) => stage.state)).toEqual(["done", "active", "pending"]);
  });

  test("never reports more than one active checkpoint", () => {
    for (const variant of ["provisioning", "waking", "updating"] as const) {
      const active = cloudWorkspaceBootStages(variant).filter((stage) => stage.state === "active");
      expect(active.length).toBe(1);
    }
  });
});

describe("cloud workspace slow boot escalation", () => {
  test("escalates copy only once the under-a-minute promise stops being true", () => {
    expect(cloudWorkspaceBootIsSlow(0)).toBe(false);
    expect(cloudWorkspaceBootIsSlow(CLOUD_WORKSPACE_SLOW_BOOT_MS - 1)).toBe(false);
    expect(cloudWorkspaceBootIsSlow(CLOUD_WORKSPACE_SLOW_BOOT_MS)).toBe(true);

    const early = cloudWorkspaceTakeoverCopy({ variant: "provisioning", slow: false });
    const late = cloudWorkspaceTakeoverCopy({ variant: "provisioning", slow: true });

    expect(early.title).toBe("Starting your workspace…");
    expect(late.title).toBe("Still working on it…");
    expect(late.body).toContain("check again");
  });

  test("keeps the failure message even when the wait has gone long", () => {
    const failed = cloudWorkspaceTakeoverCopy({ variant: "failed", slow: true });

    expect(failed.title).toBe("Workspace needs attention");
  });

  test("formats elapsed time for both short and long waits", () => {
    expect(formatCloudWorkspaceElapsed(0)).toBe("0s elapsed");
    expect(formatCloudWorkspaceElapsed(48_000)).toBe("48s elapsed");
    expect(formatCloudWorkspaceElapsed(125_000)).toBe("2m 05s elapsed");
  });
});

function renderTakeover(status: DenCloudInstance["status"], retrying = false) {
  const viewModel = mapCloudWorkspaceState({ instance: instance({ status }), updating: false, accessRequired: false });

  return renderToStaticMarkup(
    <PlatformProvider value={testPlatform()}>
      <CloudWorkspaceStatusContext.Provider
        value={{
          gatewayMode: true,
          visible: true,
          instance: instance({ status }),
          accessRequired: false,
          requestFailed: false,
          updating: false,
          retrying,
          viewModel,
          refresh: async () => {},
          retry: async () => {},
          signOut: () => {},
          updateNow: () => {},
          takeoverActive: true,
          setTakeoverActive: () => {},
        }}
      >
        <CloudWorkspaceBootTakeover decision="takeover" />
      </CloudWorkspaceStatusContext.Provider>
    </PlatformProvider>,
  );
}

describe("cloud workspace boot takeover", () => {
  // Render as a true server pass. Other suites leave a partial `window` stub on
  // the global, and motion's reduced-motion hook needs a real one to subscribe to.
  let stashedWindow: typeof globalThis.window | undefined;

  beforeEach(() => {
    stashedWindow = globalThis.window;
    Object.defineProperty(globalThis, "window", { configurable: true, value: undefined });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "window", { configurable: true, value: stashedWindow });
  });

  test("shows the checkpoint ladder instead of a progress bar that cannot complete", () => {
    const html = renderTakeover("provisioning");

    expect(html).toContain("cloud-workspace-boot-stages");
    expect(html).toContain("Reserving your computer");
    expect(html).toContain("Restoring your files");
    expect(html).toContain("Connecting the app");
    // The old bar was hardcoded to two thirds and pulsed there forever.
    expect(html).not.toContain("w-2/3");
    expect(html).not.toContain("animate-pulse");
  });

  test("keeps a single wait indicator on the takeover card", () => {
    const html = renderTakeover("provisioning");
    // One 3x3 ticker lives in the header; checkpoints use a static dot.
    expect(html.split("ow-dot-ticker").length - 1).toBe(9);
  });

  test("does not stack the generic boot overlay on top of the gateway takeover", () => {
    expect(shouldSuppressBootOverlayForGateway({
      gatewayMode: true,
      signedIn: true,
      variant: "provisioning",
    })).toBe(true);
    expect(shouldSuppressBootOverlayForGateway({
      gatewayMode: true,
      signedIn: true,
      variant: "waking",
    })).toBe(true);
    expect(shouldSuppressBootOverlayForGateway({
      gatewayMode: true,
      signedIn: true,
      variant: "ready",
    })).toBe(false);
    expect(shouldSuppressBootOverlayForGateway({
      gatewayMode: false,
      signedIn: true,
      variant: "waking",
    })).toBe(false);
  });

  test("keeps the wait calm until the promised minute is at risk", () => {
    const html = renderTakeover("waking");

    expect(html).toContain('data-cloud-workspace-wait="normal"');
    expect(html).toContain("We’ll open your workspace automatically when it’s ready.");
    expect(html).not.toContain("Retry");
  });

  test("drops the ladder and offers recovery when the sandbox failed", () => {
    const html = renderTakeover("failed");

    expect(html).not.toContain("cloud-workspace-boot-stages");
    expect(html).toContain("Workspace needs attention");
    expect(html).toContain("Retry");
    expect(html).toContain("Sign out");
  });

  test("disables repeated recovery requests while retry is already in flight", () => {
    const html = renderTakeover("failed", true);

    expect(html).toContain("Retrying…");
    expect(html).toContain("disabled");
  });

  test("offers Den purchase, recheck, and sign-out actions when Web access is required", async () => {
    const registeredDom = typeof globalThis.window === "undefined" || typeof globalThis.document === "undefined";
    if (registeredDom) GlobalRegistrator.register({ url: "https://web.openworklabs.com/session" });
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    const openedUrls: string[] = [];
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const viewModel = mapCloudWorkspaceState({
      instance: null,
      updating: false,
      accessRequired: true,
      requestFailed: false,
    });

    try {
      await act(async () => {
        root.render(
          <PlatformProvider value={testPlatform((url) => openedUrls.push(url))}>
            <CloudWorkspaceStatusContext.Provider
              value={{
                gatewayMode: true,
                visible: true,
                instance: null,
                accessRequired: true,
                requestFailed: false,
                updating: false,
                retrying: false,
                viewModel,
                refresh: async () => {},
                retry: async () => {},
                signOut: () => {},
                updateNow: () => {},
                takeoverActive: true,
                setTakeoverActive: () => {},
              }}
            >
              <CloudWorkspaceBootTakeover decision="takeover" />
            </CloudWorkspaceStatusContext.Provider>
          </PlatformProvider>,
        );
      });

      const buttons = Array.from(container.querySelectorAll("button"));
      const purchase = buttons.find((button) => button.textContent?.includes("Get OpenWork Web"));
      if (!purchase) throw new Error("Expected Get OpenWork Web action");
      expect(buttons.some((button) => button.textContent?.includes("Check again"))).toBe(true);
      expect(buttons.some((button) => button.textContent?.includes("Sign out"))).toBe(true);

      await act(async () => purchase.click());
      const [openedUrl] = openedUrls;
      if (!openedUrl) throw new Error("Expected Den billing URL to open");
      expect(new URL(openedUrl).pathname).toBe("/dashboard/web");
    } finally {
      await act(async () => root.unmount());
      container.remove();
      if (registeredDom) await GlobalRegistrator.unregister();
    }
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

    expect(renderToStaticMarkup(
      <BootStateProvider>
        <CloudWorkspaceOverlay />
      </BootStateProvider>,
    )).toBe("");
  });
});

describe("cloud workspace overlay diagnostics", () => {
  test("renders the computer diagnostic in the expanded panel when present", () => {
    const viewModel = mapCloudWorkspaceState({
      instance: instance({ instanceName: "den-daytona-worker-cloud-test" }),
      updating: false,
      accessRequired: false,
    });

    const html = renderToStaticMarkup(
      <CloudWorkspaceStatusPanel
        viewModel={viewModel}
        updating={false}
        retrying={false}
        onRefresh={() => {}}
        onRetry={() => {}}
        onSignOut={() => {}}
        onUpdateNow={() => {}}
      />,
    );

    expect(html).toContain("Computer: den-daytona-worker-cloud-test");
    expect(html).toContain("cloud-workspace-computer-line");
  });

  test("omits the computer diagnostic from the expanded panel when absent", () => {
    const viewModel = mapCloudWorkspaceState({ instance: instance(), updating: false, accessRequired: false });

    const html = renderToStaticMarkup(
      <CloudWorkspaceStatusPanel
        viewModel={viewModel}
        updating={false}
        retrying={false}
        onRefresh={() => {}}
        onRetry={() => {}}
        onSignOut={() => {}}
        onUpdateNow={() => {}}
      />,
    );

    expect(html).not.toContain("Computer:");
    expect(html).not.toContain("cloud-workspace-computer-line");
  });
});
