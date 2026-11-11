import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { agentConnectionToolsViewSchema, memberAgentViewSchema, workbotProactiveViewSchema } from "@openwork/types/den/workbot-proactive";
import { ANY_CONNECTOR_FIXTURES, workbotAgentAnyConnectorWorld } from "../worlds/workbot-agent-any-connector.ts";

const test = spec.world(workbotAgentAnyConnectorWorld, { resources: { surfaces: ["web"], services: ["den"] }, needs: { placement: "local" }, timeout: 600_000 });

// Any connected connector as a source of Your agent (workbotAgentBrief). DESIGN P1 (state: "2 read tools"), P3 and S3
// (each connection's tools behind a disclosure), P4 (a tool no one can allow, and a connector the admin doesn't allow,
// stay visible with a lock and why), S2 (compact rows), C1 (plain words).
test("every connector is listed with its read tools; an admin reviews one; a member switches a custom one on from chat", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.owner), ownerProbe = probe.on(world.owner);
  const desk = world.connections.desk ?? "";
  const settings = async () => workbotProactiveViewSchema.parse((await ownerProbe.api(world.den.admin, "/v1/org/workbot-settings/proactive")).body);
  const tools = async (connectionId: string) => agentConnectionToolsViewSchema.parse((await ownerProbe.api(world.den.admin, `/v1/org/workbot-settings/proactive/sources/${connectionId}/tools`)).body);
  const agent = async () => memberAgentViewSchema.parse((await probe.api(world.den.members.member, "/v1/me/agent")).body);

  await step("Connectors lists every connection, custom ones, Google Workspace and Slack too, each with its policy and how many read tools agents may use", async () => {
    await owner.see({ testId: "workbot-proactive-sources" }, { timeoutMs: 90_000 });
    await owner.see({ text: /12 connections\. Read only\./ });
    for (const fixture of ANY_CONNECTOR_FIXTURES) await owner.see({ text: fixture.name });
    await owner.see({ text: "Tools agents may use: No read tools" }, { timeoutMs: 60_000 });
    await owner.see({ text: "Tools agents may use: 1 read tool" }, { timeoutMs: 60_000 });
    const view = await settings();
    const other = view.sourceConnections?.other ?? [];
    evidence.recordAssertionEvidence(
      "Every connection is offered under Connectors with its policy (members choose by default), no hand-picked list; mail and chat are read through Google Workspace and Slack",
      `${other.length} connections: ${other.map((entry) => `${entry.name} (${entry.policy})`).join(", ")}`,
      other.length === 12 && other.every((entry) => entry.policy === "members"),
    );
    expect(other.length).toBe(12);
    expect(other.map((entry) => entry.name)).toEqual(expect.arrayContaining(["Google Workspace", "Slack"]));
    await owner.screenshot();
  });

  await step("the admin opens Lumen Support Desk's tools: reads on, writes off, a destructive one locked; they allow ticket_report", async () => {
    await owner.click({ testId: `workbot-agent-tools-${desk}` });
    await owner.see({ role: "switch", label: "Agents may use list_tickets" });
    await owner.see({ text: "Its provider marks it destructive. No one can allow it." });
    await owner.see({ text: "Changes things, by its name" });
    await owner.click({ role: "switch", label: "Agents may use ticket_report" });
    await owner.see({ text: "Tools agents may use: 3 read tools" }, { timeoutMs: 30_000 });
    const view = await probe.eventually(() => tools(desk), { within: 30_000, until: (value) => value.readTools === 3, label: "the choice is saved" });
    evidence.recordAssertionEvidence(
      "Each tool decided on its own; the admin's choice wins; the destructive one stays locked",
      view.tools.map((tool) => `${tool.name}: ${tool.allowed ? "allowed" : "not allowed"} (${tool.reason}${tool.locked ? ", locked" : ""})`).join("; "),
      view.tools.find((tool) => tool.name === "ticket_report")?.override === "allow" && view.tools.find((tool) => tool.name === "purge_queue")?.locked === true,
    );
    expect(view.tools.filter((tool) => tool.allowed).map((tool) => tool.name)).toEqual(["list_tickets", "get_ticket", "ticket_report"]);
    await owner.screenshot();
  });

  await step("a member says \"also use Lumen Support Desk for refund tickets\" in chat; My bot shows it on; a connector with no read tools says so; one not allowed is locked", async () => {
    await world.adminSetsSources({ connections: { [world.connections.analytics ?? ""]: "off" } });
    const said = await world.sayInChat("putMeAgent", { sources: [{ source: "Lumen Support Desk", on: true, instruction: "Refund tickets waiting on me." }] });
    expect(said.ok).toBe(true);
    await user.reload();
    await user.see({ testId: `my-agent-source-${desk}` }, { timeoutMs: 60_000 });
    await user.see({ text: "“Refund tickets waiting on me.”" });
    await user.see({ text: "No read-only tools found. An admin can review its tools." }, { timeoutMs: 60_000 });
    const locked = await probe.eventually(() => probe.dom(`[data-testid="my-agent-source-${world.connections.analytics}"][data-policy="off"] [aria-label="Not allowed by your admin"]`), { within: 30_000, until: (value) => value.elements.length === 1, label: "Juniper Analytics is locked" });
    expect(locked.elements.length).toBe(1);
    const view = await agent();
    const deskSource = view.sources?.find((source) => source.id === desk);
    const ledger = view.sources?.find((source) => source.id === world.connections.ledger);
    const analytics = view.sources?.find((source) => source.id === world.connections.analytics);
    evidence.recordAssertionEvidence(
      "Chat switched the custom connector on; its agent may use its 3 read tools; the one with none still shows; the not-allowed one is locked",
      `desk on=${deskSource?.on} readTools=${deskSource?.readTools}; ledger readTools=${ledger?.readTools}; analytics policy=${analytics?.policy}; sources listed=${view.sources?.length}`,
      deskSource?.on === true && deskSource.readTools === 3 && ledger?.readTools === 0 && analytics?.policy === "off",
    );
    expect(deskSource?.on).toBe(true);
    expect(world.providerCalls).toEqual([]);
    await user.screenshot();
  });
});
