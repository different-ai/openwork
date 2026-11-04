import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { workbotOpenFromWorkspace } from "../worlds/workbot-open-from-workspace.ts";

const test = spec.world(workbotOpenFromWorkspace, {
  timeout: 600_000,
  needs: { commands: ["bun", "pnpm"], placement: "local" },
  resources: { surfaces: ["web"], services: ["den", "mock"] },
});

test("opening Workbot from a workspace's dashboard opens that workspace's Workbot", async ({ world, user, probe, step, evidence }) => {
  const workbotWorkspace = async () => {
    await user.navigate(`${world.url}/v1/workbot/me`);
    const me: unknown = JSON.parse(await probe.text());
    return typeof me === "object" && me !== null && "organizationName" in me ? me.organizationName : null;
  };
  const continueIfAsked = async () => {
    const url = await probe.eventually(() => probe.url(), { within: 60_000, label: "the sign-in returns to Workbot or asks for a workspace", until: value => new URL(value).origin === world.url || value.includes("/mcp/select-organization") });
    if (new URL(url).origin === world.url) return;
    await user.click({ role: "button", label: "Continue to Workbot" });
    await probe.eventually(() => probe.url(), { within: 60_000, label: "the sign-in returns to Workbot", until: value => new URL(value).origin === world.url });
  };

  await step("given the owner already uses Workbot in Acme", async () => {
    await user.navigate(world.url);
    await continueIfAsked();
    expect(await workbotWorkspace()).toBe("Acme");
  });

  await step("before: the owner moves to Other team's dashboard in Den", async () => {
    await user.navigate(world.dashboardIn(world.otherOrganizationId));
    await user.see({ role: "heading", label: "Members" }, { timeoutMs: 90_000 });
    expect((await probe.dom('[data-testid="workspace-switcher-trigger"]')).elements.map(element => element.text).join()).toContain("Other team");
    await user.see({ testId: "dashboard-nav-workbot" });
    const links = await probe.linkTargets('[data-testid="dashboard-nav-workbot"]');
    expect(links.join()).toContain(`organizationId=${world.otherOrganizationId}`);
    await user.screenshot();
  });

  await step("after: clicking Workbot in Den opens Other team's Workbot, not Acme's", async () => {
    await user.click({ testId: "dashboard-nav-workbot" });
    await continueIfAsked();
    expect(new URL(await probe.url()).searchParams.has("organization")).toBe(false);
    const workspace = await workbotWorkspace();
    expect(workspace).toBe("Other team");
    evidence.recordAssertionEvidence("Workbot follows the workspace it was opened from", `Workbot's signed-in workspace after opening it from Other team's dashboard: ${String(workspace)}`, workspace === "Other team");
    await user.navigate(world.url);
    await user.see({ role: "textbox", label: "Message Workbot" }, { timeoutMs: 90_000 });
    await user.screenshot();
  });

  await step("opening Workbot again from the same workspace keeps the sign-in", async () => {
    await user.navigate(`${world.url}/?organization=${encodeURIComponent(world.otherOrganizationId)}`);
    expect(new URL(await probe.url()).pathname).toBe("/");
    expect(await workbotWorkspace()).toBe("Other team");
  });
});
