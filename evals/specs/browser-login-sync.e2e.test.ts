import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { createBuiltinBrowserWorld } from "../worlds/browser-panel.ts";

const test = spec.world((seed) => createBuiltinBrowserWorld(seed), {
  resources: {
    surfaces: ["desktop"],
    services: [],
    nativeReason: "The removed login-sync offer lived above Electron's native browser pane and used its preload bridge.",
  },
});

test("a Desktop user browses without being offered browser login sync", async ({ world, user, step, evidence }) => {
  const tab = await world.openTab("without-login-sync", world.session.sessionId);

  await step("after: the browser opens without a login-sync setup prompt", async () => {
    await user.see({ role: "button", label: /Select tab: .*viewport-probe=without-login-sync/ }, { timeoutMs: 30_000 });
    await user.notSee({ role: "button", label: "Set up sync" });
    await user.notSee({ testId: "login-sync-card" });
    expect((await world.readBrowserState()).activeTabId).toBe(tab.tabId);
    evidence.recordAssertionEvidence("The browser opens without offering login sync", "The page is active; Set up sync and the login-sync banner are absent", true);
    await user.screenshot();
  });

  await step("the browser page still accepts clicks and typing", async () => {
    await user.see({ role: "button", label: /Select tab: .*viewport-probe=without-login-sync/ });
    await world.loadInputProbe(tab);
    expect(await world.clickAndType(tab, "browser still works")).toEqual({ clicks: 1, value: "browser still works" });
    evidence.recordAssertionEvidence("Browsing remains usable", "One page click was received and the field contains browser still works", true);
  });

  await step("after: permissions has no browser login-sync controls", async () => {
    await world.openSettingsPanel("permissions");
    await user.see({ text: "Authorized folders" });
    await user.notSee({ text: "Browser login sync" });
    await user.notSee({ testId: "login-sync-setup" });
    await user.notSee({ testId: "login-sync-configured" });
    evidence.recordAssertionEvidence("Permissions no longer offers login sync", "Authorized folders remain available; login-sync setup and configured controls are absent", true);
    await user.screenshot();
  });
});
