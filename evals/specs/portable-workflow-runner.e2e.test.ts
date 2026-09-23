import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { blockedTitle, field, portableWorkflowRunner, readyTitle, record, rows, runnerTimeZone, runnerUri } from "../worlds/portable-workflow-runner.ts";

const test = spec.world(portableWorkflowRunner, {
  resources: { surfaces: ["web"], services: ["den"] },
  timeout: 600_000,
});

test("a teammate runs a shared Workflow in a reference host while unsafe and ungranted runs stay blocked", async ({ world, user, probe, step, evidence }) => {
  const snapshots = async (configObjectId: string) => {
    const response = await probe.api(world.member, `/v1/workflows/${configObjectId}/snapshots`);
    expect(response.response.status).toBe(200);
    return rows(record(response.body).items);
  };
  const runRequests = () => world.requests.filter(request => request.method === "tools/call" && request.params.name === "run_workflow_readonly");

  await using frame = await step("before: the teammate opens and searches shared Workflows without running one", async () => {
    await user.navigate(world.url("member"));
    await user.see({ text: "Ready" }, { timeoutMs: 60_000 });
    await user.see({ role: "button", label: "Open app" });
    await user.click({ role: "button", label: "Open app" });
    await user.see({ text: "App connected" }, { timeoutMs: 60_000 });
    const frame = await world.frame();
    try {
      const appUser = user.on(frame);
      await appUser.see({ role: "heading", label: "Workflows" });
      await appUser.see({ role: "combobox", label: "Workflow" }, { value: "" });
      expect((await probe.on(frame).dom("button.primary:disabled")).elements).toHaveLength(1);
      const tools = rows(world.requests.find(request => request.method === "tools/list")?.result.tools);
      expect(tools.find(tool => tool.name === "open_workflows")).toMatchObject({ _meta: { ui: { resourceUri: runnerUri } } });
      expect(tools.find(tool => tool.name === "run_workflow_readonly")).toMatchObject({ annotations: { readOnlyHint: true } });
      expect(tools.some(tool => tool.name === "save_artifact_view")).toBe(false);
      const resource = world.requests.find(request => request.method === "resources/read");
      expect(resource?.params).toEqual({ uri: runnerUri });
      expect(resource?.result.contents).toEqual([{ uri: runnerUri, mimeType: "text/html;profile=mcp-app" }]);
      expect(resource?.resourceDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(await world.hostResourceDigest()).toBe(resource?.resourceDigest);
      const catalog = record(world.requests.find(request => request.params.name === "open_workflows")?.result.structuredContent);
      expect(catalog.kind).toBe("workflow_catalog");
      expect(rows(catalog.workflows).find(workflow => workflow.title === readyTitle)).toMatchObject({ ...world.ready, blockedReason: null });
      expect(rows(catalog.workflows).find(workflow => workflow.title === blockedTitle)).toMatchObject({ ...world.blocked, blockedReason: expect.stringContaining("additional caller input") });
      await appUser.type({ label: "Search workflows" }, readyTitle);
      await appUser.click({ role: "button", label: "Search" });
      await probe.eventually(() => world.requests.filter(request => request.params.name === "open_workflows").length, { until: count => count === 2, within: 30_000 });
      await appUser.see({ role: "combobox", label: "Workflow" }, { text: new RegExp(readyTitle) });
      expect(runRequests()).toEqual([]);
      expect(await snapshots(world.ready.configObjectId)).toEqual([]);
      expect(await snapshots(world.blocked.configObjectId)).toEqual([]);
      await appUser.notSee({ role: "heading", label: `Result: ${readyTitle}` });
      await user.screenshot();
      evidence.recordAssertionEvidence("Opening and searching do not execute a Workflow", "Official AppBridge loaded the exact Den resource bytes; two catalog calls, zero run calls and zero saved snapshots, with generated artifact views disabled.", true);
      return frame;
    } catch (error) { await frame[Symbol.asyncDispose](); throw error; }
  });

  const appUser = user.on(frame);
  const appProbe = probe.on(frame);
  const selectWorkflow = async (title: string, ids: typeof world.ready) => {
    const options = (await appProbe.dom("select option")).elements;
    const index = options.findIndex(option => option.text.startsWith(title));
    expect(index).toBeGreaterThan(0);
    await appUser.click({ role: "combobox", label: "Workflow" });
    await appUser.press("Home");
    for (let position = 0; position < index; position += 1) await appUser.press("ArrowDown");
    await appUser.press("Enter");
    await appUser.see({ role: "combobox", label: "Workflow" }, { value: JSON.stringify([ids.pluginId, ids.configObjectId, ids.configObjectVersionId]) });
  };

  const completed = await step("after: one explicit Run displays the teammate’s validated result and receipt", async () => {
    await selectWorkflow(readyTitle, world.ready);
    expect(runRequests()).toEqual([]);
    const startedAt = Date.now();
    await appUser.click({ role: "button", label: "Run workflow" });
    await appUser.see({ role: "heading", label: `Result: ${readyTitle}` }, { timeoutMs: 90_000 });
    expect(await world.clicks(frame)).toEqual({ trusted: 1, untrusted: 0 });
    expect(runRequests()).toHaveLength(1);
    const request = runRequests()[0];
    expect(request.persona).toBe("member");
    expect(request.params).toEqual({ name: "run_workflow_readonly", arguments: { ...world.ready, timeZone: runnerTimeZone } });
    expect(request.result.isError).not.toBe(true);
    const result = record(request.result.structuredContent);
    expect(result).toMatchObject({ schemaVersion: "1", kind: "workflow_result", workflow: world.ready, value: { timeZone: runnerTimeZone } });
    expect(result.resultDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.outputSchemaDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    const value = record(result.value);
    const now = Date.parse(field(value, "now"));
    expect(now).toBeGreaterThanOrEqual(startedAt - 5_000);
    expect(now).toBeLessThanOrEqual(Date.now() + 5_000);
    expect(field(value, "today")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Date.parse(field(value, "dayStart"))).toBeLessThanOrEqual(now);
    expect(Date.parse(field(value, "dayEnd"))).toBeGreaterThan(now);
    await appUser.see({ text: runnerTimeZone });
    await appUser.see({ text: field(value, "today") });
    const saved = await snapshots(world.ready.configObjectId);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ receiptId: field(result, "receiptId"), status: "succeeded", value, resultDigest: result.resultDigest, outputSchemaDigest: result.outputSchemaDigest, toolCalls: [] });
    expect(JSON.stringify(request.result.content)).toContain(field(result, "receiptId"));
    expect(JSON.stringify(request.result.content)).toContain(runnerTimeZone);
    await user.screenshot();
    evidence.recordAssertionEvidence("A trusted Run reaches Den as the granted teammate", `One trusted click, one exact-version call with ${runnerTimeZone}, one durable schema-validated snapshot and zero provider calls. Receipt ${field(result, "receiptId")}.`, true);
    return saved;
  });

  await step("after: a Workflow needing caller input stays visible but cannot run", async () => {
    await appUser.type({ label: "Search workflows" }, blockedTitle, { replace: true });
    await appUser.click({ role: "button", label: "Search" });
    await appUser.see({ role: "combobox", label: "Workflow" }, { text: new RegExp(`${blockedTitle} — Blocked`) });
    await selectWorkflow(blockedTitle, world.blocked);
    await appUser.see({ text: /This Workflow does not accept server-provided input.runtime without additional caller input/ });
    await appUser.see({ role: "heading", label: `Previous result: ${readyTitle}` });
    expect((await appProbe.dom("button.primary:disabled")).elements).toHaveLength(1);
    expect(runRequests()).toHaveLength(1);
    const denied = await world.call("member", "run_workflow_readonly", { ...world.blocked, timeZone: runnerTimeZone });
    expect(denied).toMatchObject({ isError: true, structuredContent: { kind: "workflow_error", error: "workflow_blocked" } });
    expect(await snapshots(world.blocked.configObjectId)).toEqual([]);
    expect(await snapshots(world.ready.configObjectId)).toEqual(completed);
    expect(await world.clicks(frame)).toEqual({ trusted: 1, untrusted: 0 });
    await user.screenshot();
    evidence.recordAssertionEvidence("A disabled control is backed by server enforcement", "The caller-input Workflow is marked Blocked; a direct exact-ID request also returns workflow_blocked, creates zero snapshots and leaves the previous result unchanged.", true);
  });

  await step("after: a teammate without a grant sees no Workflows and cannot reuse the known IDs", async () => {
    await user.navigate(world.url("outsider"));
    await user.see({ text: "Ready" }, { timeoutMs: 60_000 });
    await user.click({ role: "button", label: "Open app" });
    await user.see({ text: "App connected" }, { timeoutMs: 60_000 });
    await using outsiderFrame = await world.frame();
    const outsiderUser = user.on(outsiderFrame);
    await outsiderUser.see({ text: "No workflows found. Change your search or ask a workflow owner to share access." });
    await outsiderUser.notSee({ text: readyTitle });
    expect((await probe.on(outsiderFrame).dom("button.primary:disabled")).elements).toHaveLength(1);
    const catalog = world.requests.find(request => request.persona === "outsider" && request.params.name === "open_workflows");
    expect(catalog?.result.structuredContent).toMatchObject({ kind: "workflow_catalog", workflows: [] });
    const denied = await world.call("outsider", "run_workflow_readonly", { ...world.ready, timeZone: runnerTimeZone });
    expect(denied).toMatchObject({ isError: true, structuredContent: { kind: "workflow_error", error: "workflow_unavailable" } });
    expect(JSON.stringify(denied)).not.toContain(readyTitle);
    expect(record(denied.structuredContent)).not.toHaveProperty("value");
    expect(record(denied.structuredContent)).not.toHaveProperty("receiptId");
    const hidden = await probe.api(world.outsider, `/v1/workflows/${world.ready.configObjectId}/snapshots`);
    expect(hidden.response.status).toBe(403);
    expect(await snapshots(world.ready.configObjectId)).toEqual(completed);
    expect(world.requests.filter(request => request.method === "tools/call").every(request => ["open_workflows", "run_workflow_readonly"].includes(field(request.params, "name")))).toBe(true);
    await user.screenshot();
    evidence.recordAssertionEvidence("Known IDs do not bypass member access", "The ungranted member receives an empty catalog, workflow_unavailable for the exact shared version and HTTP 403 for its snapshots; the granted member still has exactly one successful snapshot.", true);
  });
});
