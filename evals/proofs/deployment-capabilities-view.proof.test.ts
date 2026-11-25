import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { deploymentCapabilitiesViewWorld } from "../worlds/deployment-capabilities-view.ts";

const test = spec.world(deploymentCapabilitiesViewWorld, {
  timeout: 600_000,
  resources: { surfaces: ["web"], services: ["den"] },
});

const IDS = ["workbot", "slackAssistant", "automations", "aiGateway", "cloudComputers"];

test("a workspace admin sees what is installed next to which members may use it", async ({ world, user, probe, step, evidence }) => {
  const text = async (selector: string) => (await probe.dom(selector)).elements.map((element) => element.text.replace(/\s+/g, " ").trim());
  const cell = async (kind: "infrastructure" | "access", id: string) => (await text(`[data-testid="capability-${kind}-${id}"]`)).join(" ");
  const table = async () => Object.fromEntries(await Promise.all(IDS.map(async (id) => [id, `${await cell("infrastructure", id)} | ${await cell("access", id)}`])));

  await step("before: with the feature off the page is locked and Settings does not list it", async () => {
    await user.see({ testId: "capabilities-screen" }, { timeoutMs: 90_000 });
    await user.see({ text: "The capabilities view isn't enabled in this workspace." }, { timeoutMs: 60_000 });
    const rows = await text('[data-testid="capabilities-table"]');
    const nav = await text('a[href$="/dashboard/capabilities"]');
    await user.screenshot();
    const ok = rows.length === 0 && nav.length === 0;
    evidence.recordAssertionEvidence("With the feature off there is no capability list and no Settings entry", `capability tables: ${rows.length}; Settings links to the page: ${nav.length}`, ok);
    expect(ok).toBe(true);
  });

  await step("after: Workbot reads Installed, and its member access reads Off because the organization's switch is off", async () => {
    await world.turnOnCapabilitiesView();
    await user.reload();
    await user.see({ testId: "capabilities-table" }, { timeoutMs: 90_000 });
    await user.see({ testId: "capabilities-installed-but-off" }, { timeoutMs: 60_000 });
    const rows = await table();
    const notice = (await text('[data-testid="capabilities-installed-but-off"]')).join(" ");
    const nav = await text('a[href$="/dashboard/capabilities"]');
    await user.screenshot();
    const ok = rows.workbot === "Installed: Set up on this deployment. | Off"
      && notice === "Workbot and Slack assistant are installed, but no member can use them yet."
      && nav.includes("Capabilities");
    evidence.recordAssertionEvidence("Workbot is installed while no member may use it, and the page names every capability in that state", `${JSON.stringify(rows)}; notice: ${notice}`, ok);
    expect(ok).toBe(true);
  });

  await step("each capability shows its own infrastructure state and where its member access comes from", async () => {
    const rows = await table();
    const manage = await probe.linkTargets('[data-testid="capability-manage-workbot"]');
    const ok = rows.automations === "Installed: Set up on this deployment. | Everyone"
      && rows.aiGateway === "Needs installation: Its service is not installed in this deployment yet. | —"
      && rows.slackAssistant === "Installed: Set up on this deployment. | Off, Slack is not connected"
      && rows.cloudComputers === "Off: Installed, and waiting for a feature that is off for this workspace. | Off"
      && (manage[0] ?? "").endsWith("/dashboard/members/teams/everyone?tab=workbot");
    evidence.recordAssertionEvidence("Automations, the AI Gateway, the Slack assistant and cloud computers each report both answers; Manage access opens Workbot's setting", `${JSON.stringify(rows)}; Workbot manage link: ${manage[0] ?? "none"}`, ok);
    expect(ok).toBe(true);
  });

  await step("once Workbot is on for everyone, its member access reads Everyone and the warning is gone", async () => {
    await world.setWorkbotForEveryone(true);
    await user.reload();
    await user.see({ testId: "capabilities-table" }, { timeoutMs: 90_000 });
    await user.see({ text: "Everyone" }, { timeoutMs: 60_000 });
    const rows = await table();
    const notice = await text('[data-testid="capabilities-installed-but-off"]');
    await user.screenshot();
    const ok = rows.workbot === "Installed: Set up on this deployment. | Everyone" && rows.cloudComputers.endsWith("| Everyone") && !notice.some((entry) => entry.includes("Workbot"));
    evidence.recordAssertionEvidence("Workbot is installed and on for everyone; cloud computers follow Workbot's access", `${JSON.stringify(rows)}; notices: ${notice.join(" | ") || "none"}`, ok);
    expect(ok).toBe(true);
  });

  await step("a managed deployment's page lists what that deployment has installed", async () => {
    await user.navigate(world.deploymentUrl);
    await user.see({ testId: "deployment-capabilities" }, { timeoutMs: 90_000 });
    await user.see({ testId: "deployment-capability-automations" }, { timeoutMs: 60_000 });
    const states = Object.fromEntries(await Promise.all(IDS.map(async (id) => [id, (await text(`[data-testid="deployment-capability-state-${id}"]`)).join(" ")])));
    await user.screenshot();
    const ok = states.automations === "Installed: Set up on this deployment."
      && states.workbot === "Needs installation: It needs the headless runner, which is not installed in this deployment yet."
      && states.aiGateway === "Needs installation: Its service is not installed in this deployment yet.";
    evidence.recordAssertionEvidence("The deployment's recorded target decides its list: Automations installed, Workbot and the AI Gateway need installation", JSON.stringify(states), ok);
    expect(ok).toBe(true);
  });
});
