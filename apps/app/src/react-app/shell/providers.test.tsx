/** @jsxImportSource react */
declare const describe: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;
declare const expect: (value: unknown) => {
  toBe: (expected: unknown) => void;
  toContain: (expected: string) => void;
  toEqual: (expected: unknown) => void;
  not: { toThrow: () => void };
};

import { renderToStaticMarkup } from "react-dom/server";

import { DenAuthProvider } from "@/react-app/domains/cloud/den-auth-provider";
import { DesktopUpdaterProvider } from "@/react-app/domains/settings/state/desktop-updater-provider";
import { EnterpriseAwareAppProviders } from "./providers";

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

// Minimal browser stand-in: the renderer reads distribution from the preload
// bridge and persists local prefs through localStorage. No gateway marker is
// installed, so readDenBootstrapConfig falls back to its module default
// (no enterpriseActivation) — exactly the pre-activation state.
// Returns a restore function so the stub never leaks into other test files
// sharing this bun test process.
function installFakeWindow() {
  const globals = globalThis as Record<string, unknown>;
  const previousWindow = globals.window;
  const storage = new Map<string, string>();
  globals.window = {
    __OPENWORK_ELECTRON__: { meta: { distribution: ENTERPRISE_DISTRIBUTION } },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    location: { origin: "http://localhost:5173" },
  };
  return () => {
    if (previousWindow === undefined) delete globals.window;
    else globals.window = previousWindow;
  };
}

// The real AppRoot-level consumer that renders before activation completes
// (added in #4482). Its useUpdater() hook pulls in the full context chain the
// pre-activation branch must provide.
function UpdaterProbe() {
  return (
    <DesktopUpdaterProvider>
      <div data-testid="updater-probe">updater-context-ok</div>
    </DesktopUpdaterProvider>
  );
}

describe("EnterpriseAwareAppProviders pre-activation branch", () => {
  test("supports AppRoot-level updater consumers before enterprise activation", () => {
    const restoreWindow = installFakeWindow();
    try {
      let markup = "";
      expect(() => {
        markup = renderToStaticMarkup(
          // DenAuthProvider sits outside EnterpriseAwareAppProviders in the
          // production AppProviders tree; mirror that nesting here.
          <DenAuthProvider>
            <EnterpriseAwareAppProviders>
              <UpdaterProbe />
            </EnterpriseAwareAppProviders>
          </DenAuthProvider>,
        );
      }).not.toThrow();
      expect(markup).toContain("updater-context-ok");
    } finally {
      restoreWindow();
    }
  });
});
