import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { slackMcpDisabled } from "../worlds/slack-mcp-disabled.ts";

// Lightweight classification-to-generated-HTML proof, not a production OAuth
// route test. The world uses the real diagnostic fetch wrapper and callback page.
const test = spec.world(slackMcpDisabled, {
  timeout: 120_000, needs: { placement: "local" }, resources: { surfaces: [], services: [] },
});

test("a member blocked by Slack app settings sees the exact recovery while unrelated refusals stay generic", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1280, height: 960, deviceScaleFactor: 1 });
  await step("after: the failed Slack connection tells the member to ask the app manager to enable Agents > MCP", async () => {
    await user.click({ role: "link", label: "Slack access disabled" });
    await user.see({ role: "heading", label: "Connection failed" });
    await user.see({ text: "MCP access is disabled for this Slack app. Ask the person who manages the Slack app to enable Agents > MCP, then try connecting again." });
    await user.notSee({ text: "HTTP 400" });
    expect(world.diagnostics[0]).toMatchObject({ code: "MCP_SLACK_ACCESS_DISABLED", httpStatus: 400, phase: "MCP_INITIALIZE" });
    const message = (await probe.dom(".status-row small")).elements.map(element => element.text).join(" ");
    evidence.recordAssertionEvidence("Slack's disabled-access response becomes a clear recovery instruction", `HTTP 400 initialize → ${world.diagnostics[0]?.code}; ${message}`, message.includes("enable Agents > MCP"));
    await user.screenshot();
  });
  await step("after: the member can find the Slack app settings link and keep the diagnostic reference", async () => {
    await user.see({ role: "link", label: "Open Slack app settings" });
    await user.see({ text: "Diagnostic reference:" });
    await user.see({ text: "ref-slack-disabled-fixture" });
    const links = await probe.dom('a[href="https://api.slack.com/apps/A0123456789/app-assistant"][target="_blank"][rel="noopener noreferrer"]');
    expect(links.elements).toHaveLength(1);
    const reference = (await probe.dom(".reference code")).elements.map(element => element.text).join(" ");
    expect(reference).toBe("ref-slack-disabled-fixture");
    evidence.recordAssertionEvidence("The recovery points only to the expected Slack app settings and retains a support reference", `href=https://api.slack.com/apps/A0123456789/app-assistant; reference=${reference}`, links.elements.length === 1 && reference === "ref-slack-disabled-fixture");
    await user.screenshot();
  });
  await step("an unrelated HTTP 400 stays generic without Slack setup advice or a settings link", async () => {
    await user.navigate(world.url);
    await user.click({ role: "link", label: "Unknown request" });
    await user.see({ role: "heading", label: "Connection failed" });
    await user.see({ text: "The MCP server refused to start a session (HTTP 400)." });
    await user.notSee({ text: "Agents > MCP" });
    await user.notSee({ text: "MCP access is disabled" });
    await user.notSee({ role: "link", label: "Open Slack app settings" });
    const links = await probe.dom("main a");
    expect(links.elements).toHaveLength(0);
    const message = (await probe.dom(".status-row small")).elements.map(element => element.text).join(" ");
    expect(world.diagnostics[1]?.code).toBe("MCP_HTTP_400");
    evidence.recordAssertionEvidence("Unknown refusals never invent a Slack setup action", `${message} Settings links=${links.elements.length}; reference=ref-generic-fixture`, links.elements.length === 0 && !message.includes("Agents > MCP") && world.diagnostics[1]?.code === "MCP_HTTP_400");
    await user.screenshot();
  });
});
