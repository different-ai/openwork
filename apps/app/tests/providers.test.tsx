import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { act, useEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { initializeDenBootstrapConfig, readDenSettings } from "../src/app/lib/den";
import { dispatchDenSettingsChanged } from "../src/app/lib/den-session-events";
import { usePersistedBrowserLoginsStore } from "../src/react-app/domains/browser-logins/browser-logins-store";
import { DenAuthProvider } from "../src/react-app/domains/cloud/den-auth-provider";
import { useDesktopConfig } from "../src/react-app/domains/cloud/desktop-config-provider";
import { useEnterpriseActivationRequired } from "../src/react-app/domains/cloud/enterprise-activation-gate";
import { useRestrictionNotice } from "../src/react-app/domains/cloud/restriction-notice-provider";
import * as globalQueueDrainer from "../src/react-app/domains/session/sync/global-queue-drainer";
import { DesktopUpdaterProvider } from "../src/react-app/domains/settings/state/desktop-updater-provider";
import { useLocal } from "../src/react-app/kernel/local-provider";
import { ServerProvider } from "../src/react-app/kernel/server-provider";
import { BootStateProvider, useBootState } from "../src/react-app/shell/boot-state";
import { EnterpriseAwareAppProviders } from "../src/react-app/shell/providers";
import { useReloadCoordinator } from "../src/react-app/shell/reload-coordinator";

// Mirrors ENTERPRISE_DESKTOP_DISTRIBUTION from the desktop shell: the flavor
// that gates every feature behind Den activation.
const ENTERPRISE_DISTRIBUTION = {
  flavor: "enterprise",
  appName: "OpenWork Enterprise",
  appIdentifier: "com.differentai.openwork",
  protocolScheme: "openwork",
  requireSignin: true,
  requireActivation: true,
} as const;

const DEN_BASE_URL = "https://den.example.test";

// The preload snapshot an activated enterprise install boots with.
const ACTIVATED_BOOTSTRAP = {
  baseUrl: DEN_BASE_URL,
  requireSignin: true,
  requireActivation: true,
  enterpriseActivation: { activatedAt: "2026-09-10T00:00:00.000Z", denBaseUrl: DEN_BASE_URL },
};

// Desktop IPC commands only the activation-gated bridges issue: the runtime
// boot (DesktopRuntimeBoot) and the Automation runner registration
// (AutomationRunnerBridge). Everything else in the tree may talk to the shell
// before activation, exactly as it does today.
const GATED_DESKTOP_COMMANDS = new Set([
  "workspaceBootstrap",
  "runtimeBootstrap",
  "openworkServerRestart",
  "engineStart",
  "automationRunnerConfigure",
]);

// Minimal Electron preload stand-in. Every desktop command is recorded and
// resolves to nothing, so effects run against the bridge without a shell. No
// gateway marker is installed, so readDenBootstrapConfig falls back to its
// module default (no enterpriseActivation) — exactly the pre-activation state.
function installElectronBridge() {
  const commands: string[] = [];
  const meta: { distribution: typeof ENTERPRISE_DISTRIBUTION; desktopBootstrap?: typeof ACTIVATED_BOOTSTRAP } = {
    distribution: ENTERPRISE_DISTRIBUTION,
  };
  Reflect.set(window, "__OPENWORK_ELECTRON__", {
    meta,
    invokeDesktop: async (command: string) => {
      commands.push(command);
      return undefined;
    },
    // Present so BrowserLoginSyncAccessBridge has a bridge to observe.
    browserLogins: { disableForManagedContext: async () => undefined },
  });
  return {
    commands,
    // Activation lands the way the desktop shell reports it: an activated
    // bootstrap snapshot, re-read by the renderer, then the Den
    // settings-changed event.
    async activate() {
      meta.desktopBootstrap = ACTIVATED_BOOTSTRAP;
      await initializeDenBootstrapConfig();
      dispatchDenSettingsChanged({ settings: readDenSettings() });
    },
  };
}

function gatedCommands(commands: readonly string[]) {
  return commands.filter((command) => GATED_DESKTOP_COMMANDS.has(command));
}

// The real AppRoot-level consumer that renders before activation completes
// (added in #4482). Its useUpdater() hook pulls in the full context chain the
// provider tree must supply in every activation state.
function UpdaterProbe() {
  return (
    <DesktopUpdaterProvider>
      <div data-testid="updater-probe">updater-context-ok</div>
    </DesktopUpdaterProvider>
  );
}

const probeMounts: string[] = [];

// Reads every context the full tree provides and reports the activation and
// boot state, so the DOM tells which tree is mounted.
function TreeProbe() {
  useLocal();
  useDesktopConfig();
  useRestrictionNotice();
  useReloadCoordinator();
  const activationRequired = useEnterpriseActivationRequired();
  const boot = useBootState();
  useEffect(() => {
    probeMounts.push("mount");
  }, []);
  return (
    <div data-testid="tree-probe">
      tree-contexts-ok activation={activationRequired ? "required" : "complete"} boot={boot.phase}
    </div>
  );
}

function ProductionTree({ children }: { children: ReactNode }) {
  return (
    <BootStateProvider>
      <ServerProvider defaultUrl="http://127.0.0.1:4096">
        <DenAuthProvider>
          <EnterpriseAwareAppProviders>{children}</EnterpriseAwareAppProviders>
        </DenAuthProvider>
      </ServerProvider>
    </BootStateProvider>
  );
}

describe("EnterpriseAwareAppProviders", () => {
  let actEnvironment: unknown;

  beforeEach(() => {
    GlobalRegistrator.register({ url: "http://localhost:5173/" });
    actEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    probeMounts.length = 0;
  });

  afterEach(async () => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment);
    await GlobalRegistrator.unregister();
  });

  test("supports AppRoot-level updater consumers before enterprise activation", () => {
    installElectronBridge();
    let markup = "";
    expect(() => {
      markup = renderToStaticMarkup(
        <DenAuthProvider>
          <EnterpriseAwareAppProviders>
            <UpdaterProbe />
          </EnterpriseAwareAppProviders>
        </DenAuthProvider>,
      );
    }).not.toThrow();
    expect(markup).toContain("updater-context-ok");
  });

  test("mounts one tree: no gated bridge runs before activation, all of them run after, providers persist", async () => {
    const bridge = installElectronBridge();
    const startDrainer = spyOn(globalQueueDrainer, "startGlobalQueueDrainer").mockImplementation(() => () => {});
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <ProductionTree>
            <UpdaterProbe />
            <TreeProbe />
          </ProductionTree>,
        );
      });

      // Pre-activation: the full provider chain is up, the bridges are not.
      expect(container.textContent).toContain("updater-context-ok");
      expect(container.textContent).toContain("tree-contexts-ok activation=required boot=idle");
      expect(gatedCommands(bridge.commands)).toEqual([]);
      expect(startDrainer).toHaveBeenCalledTimes(0);
      expect(usePersistedBrowserLoginsStore.getState().lastEffectiveAllowed).toBe(null);
      expect(probeMounts).toEqual(["mount"]);

      await act(async () => {
        await bridge.activate();
      });

      // Post-activation: same tree, every runtime bridge now active.
      expect(container.textContent).toContain("tree-contexts-ok activation=complete");
      expect(container.textContent).not.toContain("boot=idle");
      expect(gatedCommands(bridge.commands)).toContain("workspaceBootstrap");
      expect(gatedCommands(bridge.commands)).toContain("automationRunnerConfigure");
      expect(startDrainer).toHaveBeenCalledTimes(1);
      expect(usePersistedBrowserLoginsStore.getState().lastEffectiveAllowed).toBe(true);
      // The providers above the children never remounted across activation.
      expect(probeMounts).toEqual(["mount"]);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      startDrainer.mockRestore();
    }
  });
});
