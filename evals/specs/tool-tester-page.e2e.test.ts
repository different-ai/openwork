import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { toolTesterWorld } from "../worlds/first-run.ts";

const test = spec.world(toolTesterWorld, { timeout: 300_000 });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

test("an admin can test and govern an MCP tool from the dedicated Tool Tester page", { timeout: 300_000 }, async ({ world, user, probe, step }) => {
  await user.see({ text: world.connection.name }, { timeoutMs: 60_000 });
  const connectedAt = new Date().toISOString();
  await user.click("Connect");
  await world.connector.authorizeRequestSince(connectedAt, { timeoutMs: 120_000 });
  // TODO(primitive): read a visible link destination by test id.
  const wrenchHref = await probe.eval(`(connectionId) => document.querySelector('[data-testid="toggle-mcp-tool-runner-' + connectionId + '"]')?.getAttribute("href") ?? ""`, {
    args: [world.connection.id],
  });
  expect(wrenchHref).toContain(`/dashboard/tool-tester?connectionId=${encodeURIComponent(world.connection.id)}`);
  await user.click({ testId: `toggle-mcp-tool-runner-${world.connection.id}` });
  await user.navigate(world.toolTesterUrl);
  await user.see({ text: "Tool Tester" }, { timeoutMs: 60_000 });
  await user.see({ label: "Search tools" });

  const marker = `tool-tester-${Date.now()}`;
  await step("mock_echo runs from a schema-derived form", async () => {
    await user.type({ label: "Search tools" }, "echo");
    await user.click({ text: /mock_echo/ });
    await user.see("Form");
    await user.see("JSON");
    await user.type({ label: /^text$/i }, marker);
    // TODO(primitive): assert selected and unselected radio state.
    expect(await probe.eval(`(() => {
      const editor = document.querySelector('[role="radiogroup"][aria-label="Arguments editor mode"]');
      const radios = editor ? [...editor.querySelectorAll('[role="radio"]')] : [];
      return Object.fromEntries(radios.map((radio) => [(radio.textContent ?? "").trim(), radio.getAttribute("aria-checked")]));
    })()`)).toMatchObject({ Form: "true", JSON: "false" });
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
    // TODO(primitive): assert the selected result tab state.
    expect(await probe.eval(`document.querySelector('[aria-label="Tool call inspection"] [role="tab"][aria-selected="true"]')?.textContent?.trim() ?? ""`)).toBe("Result");
    const calls = await probe.toolCalls(world.connector, { name: "mock_echo", atLeast: 1, timeoutMs: 120_000, sinceIso: runStartedAt });
    expect(calls.some((call) => call.args.text === marker)).toBe(true);
    expect(await probe.toolCalls(world.connector, { name: "mock_batch", sinceIso: runStartedAt })).toHaveLength(0);
    await user.see({ text: /Kept in this browser for this session only.*never stores run results/i });
    await user.see({ label: "Tools enabled for your organization" });
    // TODO(primitive): assert a visible switch's checked state.
    expect(await probe.eval(`document.querySelector('[role="switch"][aria-label="Tools enabled for your organization"]')?.getAttribute("aria-checked")`)).toBe("true");
    await user.looks([
      "The dedicated Tool Tester page shows a completed mock_echo run",
      "A clear trace reads OpenWork, HTTP 200, and Tool result",
      "The result is visible with Result, Request, and Response tabs available",
      "No error banner or crash message is visible",
    ]);
  });

  await step("Nested schemas honestly fall back to JSON", async () => {
    await user.type({ label: "Search tools" }, "batch", { replace: true });
    await user.click({ text: /mock_batch/ });
    await user.see({ text: /schema can't be shown as a form/i });
    await user.see({ role: "textbox", nth: 1 });
    // TODO(primitive): assert disabled and selected radio state.
    expect(await probe.eval(`(() => {
      const editor = document.querySelector('[role="radiogroup"][aria-label="Arguments editor mode"]');
      const radios = editor ? [...editor.querySelectorAll('[role="radio"]')] : [];
      const form = radios.find((radio) => (radio.textContent ?? "").trim() === "Form");
      const json = radios.find((radio) => (radio.textContent ?? "").trim() === "JSON");
      return { formDisabled: form?.hasAttribute("disabled") ?? false, jsonChecked: json?.getAttribute("aria-checked") ?? "" };
    })()`)).toEqual({ formDisabled: true, jsonChecked: "true" });
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
    // TODO(primitive): assert a visible button's disabled state.
    expect(await probe.eval(`[...document.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Run tool" && button.disabled)`)).toBe(true);
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
