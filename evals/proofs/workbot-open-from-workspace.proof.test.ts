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
  const inWorkbot = (value: string) => { const url = new URL(value); return url.origin === world.url && !url.pathname.startsWith("/auth/") && !url.searchParams.has("organization"); };
  const choosing = async () => (await probe.dom("button:not(:disabled)")).elements.some(button => button.text.trim() === "Continue to Workbot" && button.rect.width > 0);
  const continueIfAsked = async (workspace?: string) => {
    const asked = await probe.eventually(async () => ({ done: inWorkbot(await probe.url()), choose: await choosing() }), { within: 90_000, label: "the sign-in returns to Workbot or asks for a workspace", until: value => value.done || value.choose });
    if (asked.done) return false;
    if (workspace) await user.click({ text: workspace });
    await user.click({ role: "button", label: "Continue to Workbot" });
    await probe.eventually(() => probe.url(), { within: 60_000, label: "the sign-in returns to Workbot", until: inWorkbot });
    return true;
  };

  await step("given the owner last used Workbot in Other team", async () => {
    await user.navigate(`${world.url}/auth/login?return=%2F`);
    await user.see({ role: "textbox", label: "Email" }, { timeoutMs: 60_000 });
    await user.type({ role: "textbox", label: "Email" }, world.person.email);
    await user.click({ role: "button", label: "Next" });
    await user.see({ role: "textbox", label: "Password" }, { timeoutMs: 30_000 });
    await user.type({ role: "textbox", label: "Password" }, world.person.password, { sensitive: true });
    await user.click({ role: "button", label: "Sign in" });
    await continueIfAsked("Other team");
    expect(await workbotWorkspace()).toBe("Other team");
  });

  await step("before: the owner moves to Acme Robotics' dashboard in Den", async () => {
    await user.navigate(world.dashboardIn(world.acmeOrganizationId));
    await user.see({ role: "heading", label: "Members" }, { timeoutMs: 90_000 });
    expect((await probe.dom('[data-testid="workspace-switcher-trigger"]')).elements.map(element => element.text).join()).toContain("Acme Robotics");
    await user.see({ testId: "dashboard-nav-workbot" });
    const links = await probe.linkTargets('[data-testid="dashboard-nav-workbot"]');
    await user.screenshot();
  });

  await step("after: clicking Workbot in Den opens Acme Robotics' Workbot, not Other team's", async () => {
    await user.click({ testId: "dashboard-nav-workbot" });
    await continueIfAsked("Acme Robotics");
    expect(new URL(await probe.url()).searchParams.has("organization")).toBe(false);
    const workspace = await workbotWorkspace();
    expect(workspace).toBe("Acme Robotics");
    evidence.recordAssertionEvidence("Workbot follows the workspace it was opened from", `Workbot's signed-in workspace after opening it from Acme Robotics' dashboard: ${String(workspace)}`, workspace === "Acme Robotics");
    await user.navigate(world.url);
    await user.see({ role: "textbox", label: "Message Workbot" }, { timeoutMs: 90_000 });
    await user.screenshot();
  });

  await step("opening Workbot again from the same workspace keeps the sign-in", async () => {
    await user.navigate(`${world.url}/?organization=${encodeURIComponent(world.acmeOrganizationId)}`);
    expect(new URL(await probe.url()).pathname).toBe("/");
    expect(await workbotWorkspace()).toBe("Acme Robotics");
  });
});
