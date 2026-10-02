import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { field, record } from "../worlds/saved-apps.ts";
import { localLiveApp } from "../worlds/live-workflow-app-lifecycle.ts";

// Validation-only journey: reuse the supported synthetic Den/Electron world.
// No live provider, hosted account, or product source is changed.
const test = spec.world(localLiveApp, { resources: { surfaces: ["desktop"], services: ["den"], nativeReason: "User-requested local native dev app validation exercises Electron authentication, generated MCP App sandbox rendering and trusted Save/Refresh input." }, timeout: 600_000 });

test("live authoring receipt saves a workflow and previews, saves, renders and refreshes its real app", async ({ world, user, probe, step, evidence }) => {
  const title = "Local live briefing";
  const timeZone = "America/Los_Angeles";
  const outputSchema = { type: "object", properties: {
    today: { type: "string" }, now: { type: "string" }, timeZone: { type: "string" }, total: { type: "number" },
  }, required: ["today", "now", "timeZone", "total"], additionalProperties: false };
  const code = "const result = await tools.den.getWorkers({}); return { today: input.runtime.today, now: input.runtime.now, timeZone: input.runtime.timeZone, total: result.workers.length };";
  const discovery = await world.rpc("search_capabilities", { query: "list workers", limit: 5 });
  expect(JSON.stringify(discovery)).toContain("tools.den.getWorkers");
  const tested = await step("live authoring executes a discovered native read using server runtime", () =>
    world.rpc("execute_capability_script", { code, mode: "live", timeZone, outputSchema }));
  const metadata = record(record(tested.structuredContent).metadata);
  expect(metadata).toMatchObject({ mode: "live", executionType: "authoring-test", verification: "schema", timeZone, retention: { canSaveByReceipt: true } });
  const authoringReceipt = field(metadata, "receiptId");
  const savedResponse = await step("saveWorkflow accepts only the authoring receipt and schema", () => world.request("/v1/workflows", { name: title, receiptId: authoringReceipt, outputSchema }));
  expect(savedResponse.response.status, savedResponse.text).toBe(201);
  const saved = record(savedResponse.body);
  const configObjectId = field(saved, "configObjectId");
  const before = await probe.api(world.den.admin, `/v1/workflows/${configObjectId}`);
  expect(record(record(before.body).script).latestSuccessfulSnapshot).toBeNull();
  const runResponse = await step("run the exact saved version in live mode", () => world.request(`/v1/workflows/${configObjectId}/run`, { pluginId: saved.pluginId, configObjectVersionId: saved.configObjectVersionId, mode: "live", timeZone }));
  expect(runResponse.response.status, runResponse.text).toBe(200);
  const run = record(runResponse.body);
  expect(run).toMatchObject({ status: "succeeded", mode: "live", executionType: "saved-workflow", timeZone });
  expect(run.receiptId).not.toBe(authoringReceipt);
  expect(record(run.value).timeZone).toBe(timeZone);
  evidence.recordAssertionEvidence("Real local Den completed live test → receipt-only saveWorkflow → exact saved live run", JSON.stringify({ authoringReceipt, savedReceipt: run.receiptId, configObjectId, timeZone }), true);

  const draft = await world.rpc("save_artifact_view", {
      configObjectId, title, dataMode: "live",
      reactSource: 'export default function Briefing({ data }) { return <article><h1>Local live briefing</h1><p>Today: {data.today}</p><p>Fetched: {data.now}</p><p>Zone: {data.timeZone}</p><p>Workers: {data.total}</p></article> }',
      cssSource: "body{font-family:system-ui,sans-serif;padding:24px;margin:0}",
  });
  const draftView = record(record(draft.structuredContent).view);
  if (!Array.isArray(draftView.revisions) || !draftView.revisions[0]) throw new Error("Missing draft revision");
  const draftRevisionId = field(draftView.revisions[0], "id");
  await step("real desktop renders the MCP-created live draft", async () => {
    await world.open(`/dashboard/apps/${field(draftView, "id")}?revisionId=${draftRevisionId}`);
    try {
      await user.see("Save", { timeoutMs: 60_000 });
      await probe.eventually(() => world.previewText(), { within: 30_000, label: "live generated app preview", until: text => text.includes("Local live briefing") && text.includes("Fetched:") && text.includes("Workers:") });
    } finally { await user.screenshot(); }
  });
  const listed = record((await probe.api(world.den.admin, `/v1/workflows/${configObjectId}/views`)).body).items;
  if (!Array.isArray(listed) || listed.length !== 1) throw new Error("Expected one new live draft");
  const view = record(listed[0]);
  const appId = field(view, "id");
  expect(view).toMatchObject({ dataMode: "live", activeRevisionId: null });
  await step("trusted native Save keeps the live app on the dashboard", async () => {
    await user.click("Save");
    await user.see({ text: "Save to your dashboard" });
    await user.click({ role: "button", label: "Save", nth: 1 });
    await user.see({ text: "Saved to your dashboard. Your app is ready to use." }, { timeoutMs: 30_000 });
    await user.screenshot();
  });
  const rendered = await world.rpc("render_workflow_artifact", { configObjectId });
  expect(rendered._meta).toBeDefined();
  await step("reopen and refresh the saved live app", async () => {
    await world.open(`/dashboard/apps/${appId}`);
    const first = await probe.eventually(() => world.previewText(), { within: 30_000, label: "saved live app render", until: text => text.includes("Fetched:") });
    await user.screenshot();
    await user.hover({ role: "button", label: `App options for ${title}`, nth: 1 });
    await user.click({ role: "button", label: `App options for ${title}`, nth: 1 });
    await user.click({ role: "menuitem", label: `Refresh ${title}` });
    const refreshed = await probe.eventually(() => world.previewText(), { within: 60_000, label: "fresh live runtime on Refresh", until: text => text.includes("Fetched:") && text !== first });
    expect(refreshed).toContain("Workers:");
    await user.screenshot();
    evidence.recordAssertionEvidence("Real Electron live app preview, native Save, MCP render and Refresh", JSON.stringify({ appId, configObjectId, first, refreshed }), true);
  });
});
