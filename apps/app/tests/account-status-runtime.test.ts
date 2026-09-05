import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

import { resolveRuntimeStatus } from "@/react-app/domains/session/sidebar/account-status-menu";

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

describe("account status row renders app-scoped facts only", () => {
  test("a connected client is ready even while session-level work is in flight", () => {
    // The old per-session `loading` input no longer exists: one session's
    // pending messages or model verdict must not paint the app as booting.
    const status = resolveRuntimeStatus({
      clientConnected: true,
      openworkServerStatus: "connected",
      initializing: false,
    });
    expect(status.variant).toBe("connected");
  });

  test("first boot still shows preparing while the server is disconnected", () => {
    const status = resolveRuntimeStatus({
      clientConnected: false,
      openworkServerStatus: "disconnected",
      initializing: true,
    });
    expect(status.variant).toBe("loading");
  });

  test("reload busy and reload failure stay visible", () => {
    expect(resolveRuntimeStatus({
      clientConnected: true,
      openworkServerStatus: "connected",
      initializing: false,
      reloadBusy: true,
    }).variant).toBe("loading");
    expect(resolveRuntimeStatus({
      clientConnected: true,
      openworkServerStatus: "connected",
      initializing: false,
      reloadError: "boom",
    }).variant).toBe("disconnected");
  });

  test("a disconnected server after boot reports disconnected, not preparing", () => {
    const status = resolveRuntimeStatus({
      clientConnected: false,
      openworkServerStatus: "disconnected",
      initializing: false,
    });
    expect(status.variant).toBe("disconnected");
  });
});

describe("optimistic model selection wiring", () => {
  const sessionRoute = read("../src/react-app/shell/session-route.tsx");

  test("a pending model verdict never gates task creation or usable-model state", () => {
    // Only a CONFIRMED absence (selectedModelUnavailable, post confirmation
    // gate) may block; the coarse pending flag is gone.
    expect(sessionRoute).not.toContain("selectedModelAvailabilityPending");
    expect(sessionRoute).toContain("!selectedModelUnavailable");
  });

  test("the status bar no longer carries a per-session loading flag", () => {
    expect(sessionRoute).not.toContain("loading: showPreparingStatus");
    expect(sessionRoute).not.toContain("showPreparingStatus");
    const accountMenu = read("../src/react-app/domains/session/sidebar/account-status-menu.tsx");
    expect(accountMenu).not.toContain("input.loading");
  });

  test("send-time re-check of the exact model still blocks a confirmed-missing model", () => {
    expect(sessionRoute).toContain('resolveModelAvailability(sendModel ?? null).status === "unavailable"');
  });
});
