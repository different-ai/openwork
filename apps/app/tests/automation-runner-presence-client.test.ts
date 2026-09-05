import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createDenClient } from "../src/app/lib/den";

const originalFetch = globalThis.fetch;
const originalElectronBridge = typeof window === "undefined" ? undefined : (window as Window).__OPENWORK_ELECTRON__;

function stubFetch(fetchMock: typeof fetch) {
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchMock });
}

/**
 * Desktops outlive the Den they were released against, and self-hosted Dens
 * lag further still. Presence has to degrade to unknown on a Den without the
 * route, because reporting an absent desktop on that basis would warn about a
 * desktop that is sitting right there and running Automations fine.
 */
describe("Automation desktop runner presence client", () => {
  beforeEach(() => {
    // Suite files that exercise the Electron bridge leave the desktop marker
    // set, which would route these requests through the main-process proxy
    // instead of the stubbed fetch. This client behaves identically on both
    // paths; pin the plain-fetch one so the stub observes the request.
    if (typeof window !== "undefined") (window as Window).__OPENWORK_ELECTRON__ = undefined;
  });
  afterEach(() => {
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
    if (typeof window !== "undefined") (window as Window).__OPENWORK_ELECTRON__ = originalElectronBridge;
  });

  test("reports presence a Den can answer", async () => {
    const requested: string[] = [];
    stubFetch(async (input) => {
      requested.push(String(input));
      return new Response(JSON.stringify({ connected: true, lastSeenAt: 1_760_000_000_000 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const presence = await createDenClient({ baseUrl: "https://den.test", token: "tok_test" })
      .getAutomationDesktopRunnerPresence("org_test");

    expect(presence).toEqual({ connected: true, lastSeenAt: 1_760_000_000_000 });
    expect(requested[0]).toContain("/v1/automation-runners/presence");
  });

  test("leaves presence unknown on a Den without the route", async () => {
    stubFetch(async () => new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    }));

    const presence = await createDenClient({ baseUrl: "https://den.test", token: "tok_test" })
      .getAutomationDesktopRunnerPresence("org_test");

    expect(presence).toBeNull();
  });

  test("still surfaces a Den that fails for another reason", async () => {
    stubFetch(async () => new Response(JSON.stringify({ error: "internal_error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    }));

    await expect(
      createDenClient({ baseUrl: "https://den.test", token: "tok_test" })
        .getAutomationDesktopRunnerPresence("org_test"),
    ).rejects.toThrow();
  });
});
