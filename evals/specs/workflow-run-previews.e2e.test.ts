import { expect } from "vitest";
import { runWorkflow, saveWorkflow } from "@openwork/behaviors";
import { spec } from "@openwork/testkit";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected an object response");
  return value;
}

function field(value: unknown, name: string): string {
  const result = record(value)[name];
  if (typeof result !== "string") throw new Error(`Expected ${name}`);
  return result;
}

function runs(value: unknown): Record<string, unknown>[] {
  const items = record(value).runs;
  if (!Array.isArray(items)) throw new Error("Expected workflow runs");
  return items.map(record);
}

// New journey: browse organization workflow activity and open the saved workflow
// from the visualization of the version that produced a particular run.
const test = spec.world(async (seed) => {
  const den = await seed.den({ org: { name: "Workflow activity", members: { colleague: { name: "Teammate" } } } });
  const organizationId = field(record((await seed.api(den.admin, "/v1/org")).body).organization, "id");
  const token = field((await seed.api(den.admin, "/v1/mcp/token", {
    method: "POST", headers: { "x-openwork-org-id": organizationId }, body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }),
  })).body, "token");
  let requestId = 0;
  const execute = async (code: string) => {
    const response = await fetch(`${den.ref.apiUrl}/mcp/agent`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method: "tools/call", params: {
        name: "execute_capability_script", arguments: { code, input: { topic: "Weekly overview" } },
      } }),
      signal: AbortSignal.timeout(90_000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Workflow setup failed (${response.status})`);
    const data = text.split("\n").find((line) => line.startsWith("data:"));
    const message = record(JSON.parse(data ? data.slice(5) : text));
    if (message.error || record(message.result).isError) throw new Error("The setup execution failed");
  };
  const code = "const workers = await tools.den.getWorkers({}); return { topic: input.topic, count: workers.workers.length };";
  const inputSchema = { type: "object", properties: { topic: { type: "string" } }, required: ["topic"] };
  await execute(code);
  const saved = await saveWorkflow(den.admin, { name: "Weekly briefing", code, currentInput: { topic: "Weekly overview" }, inputSchema });
  if (saved.status !== 201) throw new Error(`Saving the setup workflow failed (${saved.status})`);
  const configObjectId = field(saved.body, "configObjectId");
  const pluginId = field(saved.body, "pluginId");
  const configObjectVersionId = field(saved.body, "configObjectVersionId");
  const firstRun = await runWorkflow(den.admin, configObjectId, { pluginId, configObjectVersionId, input: { topic: "Weekly overview" } });
  // Save another version without running it. History must retain the first graph.
  const nextCode = "const workers = await tools.den.getWorkers({}); return { revisedCount: workers.workers.length };";
  await execute(nextCode);
  const revised = await saveWorkflow(den.admin, { name: "Weekly briefing", code: nextCode, inputSchema, currentInput: { topic: "Next week" } });
  if (revised.status !== 201) throw new Error(`Revising the setup workflow failed (${revised.status})`);
  const failed = await seed.api(den.admin, `/v1/workflows/${configObjectId}/run`, {
    method: "POST", body: JSON.stringify({ pluginId, configObjectVersionId, input: {} }),
  });
  if (failed.response.ok) throw new Error("Missing workflow input must fail");
  const web = await seed.web({ den, signedInAs: "admin", startPath: "/dashboard/workflow-runs", headless: true, viewport: { width: 1440, height: 1000 } });
  return { den, web, configObjectId, pluginId, configObjectVersionId, receiptId: field(firstRun, "receiptId"), originalGraph: record(saved.body).graph, revisedGraph: record(revised.body).graph };
}, { timeout: 600_000 });

test("workflow activity shows linked version diagrams and keeps one-off and inaccessible runs readable", async ({ world, user, probe, seed, evidence, step }) => {
  const readRuns = async (session = world.den.admin) => {
    const response = await probe.api(session, "/v1/workflow-runs");
    expect(response.response.status, response.text).toBe(200);
    return runs(response.body);
  };
  const before = await readRuns();
  const first = before.find((run) => run.id === world.receiptId);
  expect(first).toMatchObject({ workflow: { configObjectId: world.configObjectId, title: "Weekly briefing", graph: world.originalGraph } });
  expect(record(first?.workflow).graph).not.toEqual(world.revisedGraph);
  expect(before.filter((run) => run.source === "adhoc").every((run) => run.workflow === null)).toBe(true);
  expect(before.some((run) => run.status === "failed" && record(run.workflow).configObjectId === world.configObjectId)).toBe(true);

  await step("read existing diagrams directly in the run list", async () => {
    await user.see({ text: "Workflow Runs" }, { timeoutMs: 90_000 });
    await user.see({ text: "Workflows are repeatable tasks you and your team can save, share, and run again. See their recent activity here." });
    await probe.eventually(() => probe.eval(`Boolean(document.querySelector('[data-run-id="${world.receiptId}"] [data-testid="den-workflow-flow-diagram"]'))`), { within: 30_000, label: "saved run diagram", until: (value) => value === true });
    const rendered = await probe.eval(`(() => {
      const row = document.querySelector('[data-run-id="${world.receiptId}"]');
      const diagram = row.querySelector('[data-testid="den-workflow-flow-diagram"]');
      const details = row.querySelector('details');
      return {
        title: row.querySelector('h2 a')?.textContent,
        href: row.querySelector('h2 a')?.getAttribute('href'),
        nodes: [...diagram.querySelectorAll('[data-node-id]')].map(node => node.getAttribute('data-node-id')),
        status: row.innerText.includes('Succeeded'),
        time: Boolean(row.querySelector('time')?.dateTime),
        detailsClosed: !details.open,
        rawSourceHidden: details.querySelector('dd').getClientRects().length === 0,
      };
    })()`);
    const graphNodes = record(world.originalGraph).nodes;
    if (!Array.isArray(graphNodes)) throw new Error("Expected graph nodes");
    expect(rendered).toEqual({ title: "Weekly briefing", href: `/dashboard/library/workflows/${world.configObjectId}`, nodes: graphNodes.map((node) => field(node, "id")), status: true, time: true, detailsClosed: true, rawSourceHidden: true });
    await user.see({ text: "One-off task" });
    const adhoc = before.find((run) => run.source === "adhoc");
    expect(adhoc).toBeDefined();
    expect(await probe.eval(`Boolean(document.querySelector('[data-run-id="${adhoc?.id}"] a, [data-run-id="${adhoc?.id}"] [data-testid="den-workflow-flow-diagram"]'))`)).toBe(false);
    await user.screenshot();
  });
  evidence.recordAssertionEvidence("Saved runs show the existing visualization of their executed version", "The API graph matches the original version and differs from the later edit. The rendered run includes every original graph node, a library link, status and time; one-off runs have neither a fabricated link nor a diagram.", true);
  evidence.recordAssertionEvidence("Workflow activity explains reuse and keeps raw run details collapsed", "The introduction is visible and the closed details element keeps raw source values out of the visible run card.", true);

  await step("open the linked workflow in the existing library", async () => {
    await user.click({ testId: `workflow-run-link-${world.receiptId}` });
    await user.see({ testId: "den-workflow-detail" }, { timeoutMs: 60_000 });
    expect(await probe.eval("location.pathname")).toBe(`/dashboard/library/workflows/${world.configObjectId}`);
    expect(await readRuns()).toEqual(before);
    await user.navigate(`${world.den.ref.webUrl}/dashboard/workflow-runs`);
    await user.see({ text: "Workflow Runs" });
    await user.click({ testId: `workflow-run-details-${world.receiptId}` });
    await user.see({ text: `plugin:${world.pluginId}:${world.configObjectId}` });
    expect(await probe.eval(`document.querySelector('[data-run-id="${world.receiptId}"] details').open`)).toBe(true);
  });
  evidence.recordAssertionEvidence("The run opens its library workflow and technical details remain available", "Clicking the workflow name opens the existing library detail without creating any new runs. Expanding Technical details reveals its saved source.", true);

  await step("respect member access when enriching activity", async () => {
    const colleague = world.den.members.colleague;
    expect(await readRuns(colleague)).toEqual([]);
    const org = record((await probe.api(world.den.admin, "/v1/org")).body);
    if (!Array.isArray(org.members)) throw new Error("Expected organization members");
    const member = org.members.map(record).find((entry) => record(entry.user).email === colleague.email);
    const grant = await seed.api(world.den.admin, `/v1/config-objects/${world.configObjectId}/access`, {
      method: "POST", body: JSON.stringify({ orgMembershipId: field(member, "id"), role: "editor" }),
    });
    expect(grant.response.status, grant.text).toBe(201);
    const memberRun = await runWorkflow(colleague, world.configObjectId, { pluginId: world.pluginId, configObjectVersionId: world.configObjectVersionId, input: { topic: "Member briefing" } });
    const visible = await readRuns(colleague);
    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatchObject({ id: memberRun.receiptId, workflow: { configObjectId: world.configObjectId } });
    expect(JSON.stringify(visible[0].workflow)).not.toContain("workers.workers.length");
    const removed = await seed.api(world.den.admin, `/v1/config-objects/${world.configObjectId}/access/${field(record(grant.body).item, "id")}`, { method: "DELETE" });
    expect(removed.response.ok, removed.text).toBe(true);
    const revoked = await readRuns(colleague);
    expect(revoked).toHaveLength(1);
    expect(revoked[0]).toMatchObject({ id: memberRun.receiptId, workflow: null });
    expect((await probe.api(colleague, `/v1/workflows/${world.configObjectId}`)).response.status).toBe(403);
  });
  evidence.recordAssertionEvidence("Run previews follow workflow access without widening run visibility", "A member sees none of the admin's runs, then sees a redacted preview of their own shared workflow run. Revoking the workflow grant preserves their receipt but removes its preview and library metadata.", true);
});
