import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { accountDiagnostics } from "../worlds/account-diagnostics.ts";

const test = spec.world(accountDiagnostics, {
  timeout: 300_000,
  resources: { surfaces: ["appWeb"], services: ["den"] },
  needs: { commands: ["bun"] },
});

test("a member can open usable account diagnostics without enabling developer mode", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  await step("given: developer mode is off and the connection needs attention", async () => {
    await user.navigate(world.advancedUrl);
    await user.see({ role: "switch", label: "Developer mode" });
    const switches = await probe.dom('[role="switch"][aria-label="Developer mode"][aria-checked="false"]');
    expect(switches.elements).toHaveLength(1);
    await user.click({ role: "button", label: "Back to app" });
    await user.click({ testId: "account-status-menu" });
    await user.see({ role: "menuitem", label: "Run diagnostics" }, { timeoutMs: 30_000 });
    evidence.recordAssertionEvidence("Diagnostics is offered with developer mode off", "Developer mode unchecked; Run diagnostics menu item visible", switches.elements.length === 1);
    await user.screenshot();
  });

  await step("after: Run diagnostics opens Agent access diagnostics with working refresh controls", async () => {
    await user.click({ role: "menuitem", label: "Run diagnostics" });
    await user.see({ text: "Agent access diagnostics" });
    await user.see({ role: "button", label: "Copy sanitized diagnostic" });
    const section = await probe.dom("#advanced-agent-access");
    expect(section.elements).toHaveLength(1);
    const route = await probe.hash();
    expect(route).toContain("/settings/advanced/agent-access");
    await user.notSee({ text: "Runtime debug report" });
    await user.click({ role: "button", label: /^Refresh$/ });
    await probe.eventually(async () => (await probe.dom("#advanced-agent-access button:disabled")).elements.length, {
      within: 30_000, label: "the diagnostics refresh completes", until: count => count === 0,
    });
    evidence.recordAssertionEvidence("The non-developer destination is usable, not an empty Debug page", `Route ${route}; Agent access diagnostics, Refresh and Copy sanitized diagnostic visible; Runtime debug report absent`, section.elements.length === 1 && route.includes("/settings/advanced/agent-access"));
    await user.screenshot();
  });

  await step("developers still open the full Debug page from the same menu action", async () => {
    await user.navigate(world.advancedUrl);
    await user.click({ role: "switch", label: "Developer mode" });
    await user.click({ role: "button", label: "Back to app" });
    await user.click({ testId: "account-status-menu" });
    await user.click({ role: "menuitem", label: "Run diagnostics" });
    await user.see({ text: "Runtime debug report" });
    const route = await probe.hash();
    expect(route).toContain("/settings/debug");
    evidence.recordAssertionEvidence("Developer diagnostics stay available only after opting in", `Route ${route}; Developer mode enabled; Run diagnostics opens Debug with Runtime debug report`, route.includes("/settings/debug"));
    await user.screenshot();
  });
});
