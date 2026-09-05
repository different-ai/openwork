import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { dashboardAppTool, emptyDashboardWithOneApp } from "../worlds/dashboards.ts";

// Customer report (2026-09-02): a dashboard cannot hold two tiles that call the
// same MCP tool (e.g. two JQL queries). This spec drives the real Den Web
// authoring picker against a witness MCP that exposes exactly ONE App-visible
// launch tool, adds it once, then proves the picker still offers it so a second
// tile with different launch input can be added, both persist, and an identical
// third is refused visibly.
const test = spec.world(emptyDashboardWithOneApp, { timeout: 420_000 });

const firstArguments = { jql: "project = ALPHA ORDER BY created DESC" };
const secondArguments = { jql: "project = BETA AND status = Open" };
// The picker's placeholder names the tool's required input keys.
const launchInput = { placeholder: '{ "jql": "…" }' };
const duplicateRefusal = "This app is already on the dashboard with the same launch input.";

type PersistedElement = { toolName: string; jql: string | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function persistedElements(body: unknown): PersistedElement[] {
  const item = isRecord(body) && isRecord(body.item) ? body.item : null;
  const elements = item && Array.isArray(item.elements) ? item.elements.filter(isRecord) : [];
  return elements.map((element) => {
    const launchArguments = isRecord(element.launchArguments) ? element.launchArguments : {};
    return {
      toolName: typeof element.toolName === "string" ? element.toolName : "",
      jql: typeof launchArguments.jql === "string" ? launchArguments.jql : null,
    };
  });
}

test("an organization dashboard holds two tiles of the same MCP App capability with different launch arguments", async ({ world, user, probe, step, evidence }) => {
  const readElements = () => probe.api(world.den.admin, `/v1/dashboards/${world.dashboardId}`)
    .then((result) => persistedElements(result.body));

  // Witness sanity: exactly one App, so a second tile can only be the same App.
  expect(world.catalogTools).toEqual([dashboardAppTool.name]);
  evidence.recordAssertionEvidence(
    "The witness connection exposes exactly one MCP App launch tool",
    `GET /v1/mcp-connections/${world.connection.id}/mcp-apps returned ${JSON.stringify(world.catalogTools)}`,
    world.catalogTools.length === 1 && world.catalogTools[0] === dashboardAppTool.name,
  );

  await step("add the App once", async () => {
    await user.see({ text: world.dashboardName }, { timeoutMs: 90_000 });
    await user.click("Add app");
    await user.see({ text: dashboardAppTool.title }, { timeoutMs: 90_000 });
    await user.type(launchInput, JSON.stringify(firstArguments), { replace: true });
    await user.click("Add");
  });
  const afterFirstAdd = await probe.eventually(() => readElements(), {
    within: 60_000,
    intervalMs: 1_000,
    label: "first tile persisted in Den",
    until: (elements) => elements.length === 1,
  });
  expect(afterFirstAdd).toEqual([{ toolName: dashboardAppTool.name, jql: firstArguments.jql }]);

  // The reported limitation: after one add the picker must still offer the same
  // App with its launch-input field, not a terminal "Added" state. "Added" may
  // remain as a count hint, but never in place of the Add control.
  await user.see("Add another", { timeoutMs: 15_000 });
  await user.see(launchInput, { editable: true });
  await user.screenshot();
  const secondAddOffer = {
    addAnotherOffered: await probe.has("Add another"),
    addedHintVisible: await probe.has("Added"),
  };
  evidence.recordAssertionEvidence(
    "The Add app picker keeps offering an already-added capability for a second tile with different launch input",
    `Picker row after the first add: ${JSON.stringify(secondAddOffer)}; launch input field still editable`,
    secondAddOffer.addAnotherOffered && secondAddOffer.addedHintVisible,
  );

  await step("add the same App again with different launch input", async () => {
    await user.type(launchInput, JSON.stringify(secondArguments), { replace: true });
    await user.click("Add another");
  });
  const afterSecondAdd = await probe.eventually(() => readElements(), {
    within: 60_000,
    intervalMs: 1_000,
    label: "second same-capability tile persisted in Den",
    until: (elements) => elements.length === 2,
  });
  // Both tiles call the same capability with their own arguments; the first
  // tile is neither replaced nor deduplicated by the second.
  expect(afterSecondAdd).toEqual([
    { toolName: dashboardAppTool.name, jql: firstArguments.jql },
    { toolName: dashboardAppTool.name, jql: secondArguments.jql },
  ]);
  await user.see({ text: "Added ×2" }, { timeoutMs: 15_000 });

  // Negative half: an identical tile (same App, same launch input) is refused
  // with a visible message rather than silently dropped or silently duplicated.
  await step("try to add an identical tile", async () => {
    await user.click("Add another");
  });
  await user.see({ text: duplicateRefusal }, { timeoutMs: 15_000 });
  const afterDuplicateAttempt = await readElements();
  expect(afterDuplicateAttempt).toEqual(afterSecondAdd);
  evidence.recordAssertionEvidence(
    "An identical tile is refused visibly and does not change the saved dashboard",
    `refusal shown=${await probe.has(duplicateRefusal)}; persisted after attempt=${JSON.stringify(afterDuplicateAttempt)}`,
    JSON.stringify(afterDuplicateAttempt) === JSON.stringify(afterSecondAdd),
  );

  await user.click("Done");
  await user.notSee("Done", { timeoutMs: 15_000 });
  await user.see({ text: `${dashboardAppTool.name} · ${JSON.stringify(firstArguments)}` });
  await user.see({ text: `${dashboardAppTool.name} · ${JSON.stringify(secondArguments)}` });
  await user.screenshot();
  evidence.recordAssertionEvidence(
    "Two tiles of the same MCP App capability with different launch arguments coexist on one dashboard",
    `Persisted elements: ${JSON.stringify(afterSecondAdd)}; each element row shows its own launch input`,
    afterSecondAdd.length === 2
      && afterSecondAdd[0].toolName === dashboardAppTool.name
      && afterSecondAdd[1].toolName === dashboardAppTool.name
      && afterSecondAdd[0].jql === firstArguments.jql
      && afterSecondAdd[1].jql === secondArguments.jql,
  );
});
