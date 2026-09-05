import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { toolTesterWorld } from "../worlds/first-run.ts";

const test = spec.world(toolTesterWorld, { timeout: 300_000 });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

test("an admin reaches the Tool Tester from Connectors and can test and govern an MCP tool", { timeout: 300_000 }, async ({ world, user, probe, step }) => {
  await user.see({ text: world.connection.name }, { timeoutMs: 60_000 });
  const connectedAt = new Date().toISOString();
  await user.click("Connect");
  await world.connector.authorizeRequestSince(connectedAt, { timeoutMs: 120_000 });
  await user.click({ testId: `mcp-connection-more-${world.connection.id}` });
  const testToolsHref = await world.testToolsHref();
  expect(testToolsHref).toContain(`/dashboard/tool-tester?connectionId=${encodeURIComponent(world.connection.id)}`);
  await user.notSee({ text: "View tools" });
  expect(await world.toolTesterSidebarPlacement()).toEqual({ inManage: true, inSettings: false });
  await user.click({ testId: `test-mcp-tools-${world.connection.id}` });
  // The sidebar also reads "Tool Tester", so wait on the route and the page description instead of the title.
  const testerHref = await probe.eventually(() => world.location(), {
    timeoutMs: 60_000,
    label: "tool tester route",
    until: (href) => href.includes("/dashboard/tool-tester?connectionId="),
  });
  expect(testerHref).toContain(`connectionId=${encodeURIComponent(world.connection.id)}`);
  await user.see({ text: /Run any tool your connections expose/ }, { timeoutMs: 60_000 });
  await user.see({ text: world.connection.name });
  await user.see({ label: "Search tools" });

  const marker = `tool-tester-${Date.now()}`;
  await step("mock_echo runs from a schema-derived form", async () => {
    await user.type({ label: "Search tools" }, "echo");
    await user.click({ text: /mock_echo/ });
    await user.see("Form");
    await user.see("JSON");
    await user.type({ label: /^text\s*\*?$/i }, marker);
    expect(await world.argumentsEditorModes()).toMatchObject({ Form: "true", JSON: "false" });
    const runStartedAt = new Date().toISOString();
    await user.click("Run tool");
    await user.see({ text: /Tool completed/ }, { timeoutMs: 120_000 });
    await user.see({ text: /OpenWork/ });
    await user.see({ text: /HTTP 200/ });
    await user.see({ text: /Tool result/ });
    await user.see({ text: new RegExp(marker) });
    await user.see("Result");
    await user.see("Request");
    await user.see("Response");
    expect(await world.selectedInspectionTab()).toBe("Result");
    const calls = await probe.toolCalls(world.connector, { name: "mock_echo", atLeast: 1, timeoutMs: 120_000, sinceIso: runStartedAt });
    expect(calls.some((call) => call.args.text === marker)).toBe(true);
    expect(await probe.toolCalls(world.connector, { name: "mock_batch", sinceIso: runStartedAt })).toHaveLength(0);
    await user.see({ text: /Kept in this browser for this session only.*never stores run results/i });
    await user.see({ label: "Tools enabled for your organization" });
    expect(await world.orgToolsSwitchChecked()).toBe("true");
    await user.looks([
      "The dedicated Tool Tester page shows a completed mock_echo run",
      "A clear trace reads OpenWork, HTTP 200, and Tool result",
      "The result is visible with Result, Request, and Response tabs available",
      "No error banner or crash message is visible",
    ]);
  });

  await step("Nested schemas honestly fall back to JSON", async () => {
    // The "echo" filter already matches mock_batch through its description ("Echo a batch of items").
    await user.click({ text: /mock_batch/ });
    await user.see({ text: /schema can't be shown as a form/i });
    await user.see({ role: "textbox", nth: 1 });
    expect(await world.argumentsEditorFallback()).toEqual({ formDisabled: true, jsonChecked: "true" });
  });

  const capabilityName = `mcp:${world.connection.id}:mock_echo`;
  const before = await world.search();
  const match = before.find((entry) => entry.name === capabilityName);
  expect(match).toBeDefined();
  const schemaDigest = match && typeof match.schemaDigest === "string" ? match.schemaDigest : "";
  expect(schemaDigest).toMatch(/^sha256:[a-f0-9]{64}$/);

  await step("Organization policy disables discovery and execution", async () => {
    await user.click({ testId: "tool-policy-switch-mock_echo" });
    await user.see({ text: /Disabled by Sarah/ }, { timeoutMs: 60_000 });
    await user.click({ text: /mock_echo/ });
    await user.see({ text: /Disabled for your organization by Sarah/ });
    await user.see("Enable tool");
    expect(await world.runToolDisabled()).toBe(true);
    const after = await world.search();
    expect(after.some((entry) => entry.name === capabilityName)).toBe(false);
    const blockedAt = new Date().toISOString();
    const blocked = await world.execute(schemaDigest, `blocked-${marker}`);
    const content = isRecord(blocked) && Array.isArray(blocked.content) ? blocked.content.filter(isRecord) : [];
    const payload = content[0] && typeof content[0].text === "string" ? JSON.parse(content[0].text) : {};
    expect(isRecord(blocked) ? blocked.isError : false).toBe(true);
    expect(isRecord(payload) ? payload.error : null).toBe("policy_blocked");
    expect(await probe.toolCalls(world.connector, { name: "mock_echo", sinceIso: blockedAt })).toHaveLength(0);
    await user.looks([
      "The Tool Tester shows mock_echo disabled for the organization",
      "The disabled state visibly attributes the policy change to Sarah",
      "Run tool is disabled and an Enable tool action is available",
      "No generic error or crash message is visible",
    ]);
  });
});
