import { afterEach, describe, expect, test } from "bun:test";

import { canCreateWorkspaces } from "../src/app/lib/workspace-creation-policy";

const originalWindow = globalThis.window;

function installWindow(options: {
  origin: string;
  gateway?: boolean;
  electronInfo?: {
    baseUrl: string;
    ownerToken: string;
  };
}) {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      location: { origin: options.origin },
      __MICX_GATEWAY__: options.gateway ? { version: 1 } : undefined,
      __MICX_ELECTRON__: options.electronInfo
        ? {
            invokeDesktop: async () => ({
              running: true,
              baseUrl: options.electronInfo?.baseUrl,
              ownerToken: options.electronInfo?.ownerToken,
            }),
          }
        : undefined,
    },
  });
}

afterEach(() => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: originalWindow,
  });
});

describe("workspace creation policy", () => {
  test("disables workspace creation in gateway runtime", () => {
    installWindow({ origin: "https://web.micxlabs.com", gateway: true });
    expect(canCreateWorkspaces()).toBe(false);
  });

  test("allows workspace creation in plain web runtime", () => {
    installWindow({ origin: "https://self-hosted.example" });
    expect(canCreateWorkspaces()).toBe(true);
  });

  test("allows workspace creation in desktop runtime", () => {
    installWindow({
      origin: "http://localhost:3000",
      electronInfo: { baseUrl: "http://localhost:8787", ownerToken: "owner-token" },
    });
    expect(canCreateWorkspaces()).toBe(true);
  });
});
