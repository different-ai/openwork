import { expect } from "vitest";
import { runWorkflow, saveWorkflow } from "@openwork/behaviors";
import { queryDenDatabase } from "@openwork/env";
import { defaultDaytonaExec, execInSandbox } from "@openwork/hosts";
import { spec } from "@openwork/testkit";
import { enterprisePlanNoticeMeasurements } from "../worlds/workflow-run-previews.ts";

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
  const den = await seed.den({ env: { DEN_PLAN_GATING_ENABLED: "true", DEN_ORG_MODE: "multi_org", STRIPE_SECRET_KEY: "" }, org: { name: "Workflow activity", members: { colleague: { name: "Teammate" }, planViewer: { name: "Analytics teammate" } } } });
  const organization = record((await seed.api(den.admin, "/v1/org")).body);
  const organizationId = field(organization.organization, "id");
  if (!Array.isArray(organization.members)) throw new Error("Expected organization members");
  const planViewerMember = organization.members.map(record).find((member) => String(record(member.user).email).toLowerCase() === den.members.planViewer.email.toLowerCase()); // Den stores emails lowercased.
  // A non-owner admin can open Analytics, while the ordinary teammate below
  // keeps their existing billing and run-visibility boundaries.
  const promoted = await seed.api(den.admin, `/v1/members/${encodeURIComponent(field(planViewerMember, "id"))}/role`, {
    method: "POST", headers: { "x-openwork-org-id": organizationId }, body: JSON.stringify({ role: "admin" }),
  });
  if (!promoted.response.ok) throw new Error("Could not arrange the non-owner Analytics viewer");
  const setEnterprise = async (enabled: boolean) => {
    const statement = "UPDATE organization SET metadata = JSON_SET(COALESCE(metadata, JSON_OBJECT()), '$.plan', JSON_OBJECT('tier', ?, 'source', 'manual')) WHERE id = ?";
    const values = [enabled ? "enterprise" : "free", organizationId];
    if (den.placement?.kind === "daytona") {
      const script = `import { createConnection } from "/workspace/ee/packages/den-db/node_modules/mysql2/promise.js";
        const connection = await createConnection("mysql://root:password@127.0.0.1:3306/openwork_den");
        try { await connection.execute(${JSON.stringify(statement)}, ${JSON.stringify(values)}); } finally { await connection.end(); }`;
      const encoded = Buffer.from(script).toString("base64");
      const result = await execInSandbox(defaultDaytonaExec, den.placement.sandboxId, `printf %s ${encoded} | base64 -d | node --input-type=module`, { timeoutMs: 15_000, context: "Arrange isolated workspace plan" });
      if (result.code !== 0) throw new Error("Could not arrange the workspace plan");
    } else {
      if (!den.database) throw new Error("Plan transition proof requires its own database");
      await queryDenDatabase(den.database.url, statement, values);
    }
  };
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
  const code = "const workers = await tools.den.getWorkers({}); let count = 0; for (const worker of workers.workers) { count += 1; } if (input.topic) { return { topic: input.topic, count }; } return { count };";
  const inputSchema = { type: "object", properties: { topic: { type: "string" } }, required: ["topic"] };
  await execute(code);
  const saved = await saveWorkflow(den.admin, { name: "Weekly briefing", code, currentInput: { topic: "Weekly overview" }, inputSchema });
  if (saved.status !== 201) throw new Error(`Saving the setup workflow failed (${saved.status})`);
  const configObjectId = field(saved.body, "configObjectId");
  const pluginId = field(saved.body, "pluginId");
  const configObjectVersionId = field(saved.body, "configObjectVersionId");
  const firstRun = await runWorkflow(den.admin, configObjectId, { pluginId, configObjectVersionId, input: { topic: "Weekly overview" } });
  // Save another version without running it. History must retain the first graph.
  const nextCode = "const workers = await tools.den.getWorkers({}); return { topic: input.topic, revisedCount: workers.workers.length };";
  await execute(nextCode);
  const revised = await saveWorkflow(den.admin, { name: "Weekly briefing", code: nextCode, inputSchema, currentInput: { topic: "Next week" } });
  if (revised.status !== 201) throw new Error(`Revising the setup workflow failed (${revised.status})`);
  const failed = await seed.api(den.admin, `/v1/workflows/${configObjectId}/run`, {
    method: "POST", body: JSON.stringify({ pluginId, configObjectVersionId, input: {} }),
  });
  if (failed.response.ok) throw new Error("Missing workflow input must fail");
  const viewport = { width: 1440, height: 1000 };
  const web = await seed.web({ den, signedInAs: "admin", startPath: "/dashboard/workflow-runs", headless: true, viewport });
  const memberWeb = await seed.web({ den, signedInAs: den.members.colleague, startPath: "/dashboard", headless: true, viewport });
  const planViewerWeb = await seed.web({ den, signedInAs: den.members.planViewer, startPath: "/dashboard/analytics", headless: true, viewport });
  return { den, web, memberWeb, planViewerWeb, planNotice: () => enterprisePlanNoticeMeasurements(web), planViewerNotice: () => enterprisePlanNoticeMeasurements(planViewerWeb), setEnterprise, configObjectId, pluginId, configObjectVersionId, receiptId: field(firstRun, "receiptId"), originalGraph: record(saved.body).graph, revisedGraph: record(revised.body).graph };
}, { timeout: 600_000, resources: { surfaces: ["web"], services: ["den"] } });

test("workflow activity shows linked version diagrams and keeps one-off and inaccessible runs readable", async ({ world, user, probe, seed, evidence, step }) => {
  const readRuns = async (session = world.den.admin) => {
    const response = await probe.api(session, "/v1/workflow-runs");
    expect(response.response.status, response.text).toBe(200);
    return runs(response.body);
  };
  const readPlanLock = async (feature: string, detail: string, actor: "owner" | "teammate" = "owner") => {
    const person = actor === "owner" ? user : user.on(world.planViewerWeb);
    const session = actor === "owner" ? world.den.admin : world.den.members.planViewer;
    await person.see({ testId: "enterprise-plan-notice" }, { timeoutMs: 90_000 });
    await person.see({ role: "link", label: "Talk to us for Enterprise pricing" });
    const context = record((await probe.api(session, "/v1/org")).body);
    expect(record(context.currentMember).isOwner).toBe(actor === "owner");
    const gate = actor === "owner" ? await world.planNotice() : await world.planViewerNotice();
    expect(gate.state.text).toBe(`${feature} is part of the Enterprise plan.`);
    expect(gate.detail.text).toBe(detail);
    expect(gate.guidance.text).toBe(actor === "owner" ? "You can change the plan." : "Your workspace owner can change the plan.");
    expect(gate.guidanceCount).toBe(1);
    expect(gate.text).not.toContain(actor === "owner" ? "Your workspace owner can change the plan." : "You can change the plan.");
    expect(gate.text).not.toMatch(/SCIM|enforced SSO|desktop policies|managed deployment/);
    expect(gate.lockCount).toBe(1);
    expect(gate.lockHiddenFromAssistiveTech).toBe(true);
    expect(gate.tone).toBe("neutral");
    expect(gate.role).toBe("status");
    expect(gate.state.neutral).toBe(true);
    expect(gate.detail.neutral).toBe(true);
    expect(gate.guidance.neutral).toBe(true);
    expect(gate.lock.neutral).toBe(true);
    expect(gate.state.contrast).toBeGreaterThanOrEqual(4.5);
    expect(gate.detail.contrast).toBeGreaterThanOrEqual(4.5);
    expect(gate.guidance.contrast).toBeGreaterThanOrEqual(4.5);
    expect(gate.lock.contrast).toBeGreaterThanOrEqual(3);
    expect(gate.panelPaint).toEqual([0, 0]);
    expect(gate.paragraphCount).toBe(0);
    expect(gate.height).toBeLessThanOrEqual(64);
    expect(gate.action).toMatchObject({ label: "Talk to us for Enterprise pricing", target: "_blank", rel: "noreferrer" });
    expect(gate.action.href).not.toContain("/dashboard/billing");
    return gate;
  };
  await step("before: the owner sees they can change the plan while Workflow run history is locked", async () => {
    for (const path of ["/v1/workflow-runs", "/v1/codemode-runs"]) {
      const blocked = await probe.api(world.den.admin, path);
      expect(blocked.response.status).toBe(402);
      expect(blocked.body).toMatchObject({ error: "enterprise_plan_required", feature: "analytics" });
      expect(record(blocked.body).runs).toBeUndefined();
    }
    // The old URL redirects into Analytics and receives the same gate.
    await user.see({ text: "Workflow run history is part of the Enterprise plan." }, { timeoutMs: 90_000 });
    expect(await probe.eval(world.web, () => location.pathname)).toBe("/dashboard/analytics/workflow-runs");
    await user.navigate(`${world.den.ref.webUrl}/dashboard/script-runs`);
    await user.see({ text: "Workflow run history is part of the Enterprise plan." });
    expect(await probe.eval(world.web, () => location.pathname)).toBe("/dashboard/analytics/workflow-runs");
    await user.see({ role: "link", label: /^Usage & adoption$/ });
    await user.see({ role: "link", label: "Models & usage" });
    await user.notSee({ testId: "nav-workflow-runs" });
    await user.notSee({ role: "link", label: "Workflow Runs" });
    await user.notSee({ testId: `workflow-run-link-${world.receiptId}` });
    await user.navigate(`${world.den.ref.webUrl}/dashboard/analytics/workflow-runs`);
    await user.see({ text: "Workflow run history is part of the Enterprise plan." });
    await user.notSee({ testId: `workflow-run-link-${world.receiptId}` });
    const gate = await readPlanLock("Workflow run history", "Run history is unavailable on this plan.");
    evidence.recordAssertionEvidence("the owner is not sent to another owner to unlock Workflow run history", `Both API aliases return 402 without runs and legacy URLs reach the same gate. ${gate.state.text} ${gate.detail.text} ${gate.guidance.text} One actor instruction and one neutral lock, no SCIM copy or tinted panel; text contrast ${gate.state.contrast.toFixed(2)}:1 / ${gate.detail.contrast.toFixed(2)}:1 / ${gate.guidance.contrast.toFixed(2)}:1; compact row ${gate.height}px; the existing pricing action remains.`, true);
    await user.screenshot();
  });

  await step("before: the owner's Usage analytics lock points to their own plan-change action", async () => {
    await user.click({ role: "link", label: /^Usage & adoption$/ });
    await user.see({ role: "heading", label: "Usage & adoption" });
    const blocked = await probe.api(world.den.admin, "/v1/telemetry/analytics");
    expect(blocked.response.status).toBe(402);
    expect(blocked.body).toMatchObject({ error: "enterprise_plan_required", feature: "analytics" });
    const gate = await readPlanLock("Usage analytics", "Team usage is unavailable on this plan.");
    await user.notSee({ role: "button", label: "Refresh analytics" });
    await user.notSee({ text: "Sessions this week" });
    evidence.recordAssertionEvidence("the owner gets one direct plan instruction for the blocked team usage", `${gate.state.text} ${gate.detail.text} ${gate.guidance.text} Analytics API returns ${blocked.response.status}; one actor instruction and one neutral lock, no warning tint or SCIM copy; text contrast ${gate.state.contrast.toFixed(2)}:1 / ${gate.detail.contrast.toFixed(2)}:1 / ${gate.guidance.contrast.toFixed(2)}:1; ${gate.height}px row with the unchanged pricing action.`, true);
    await user.screenshot();
  });

  await step("a non-owner teammate is directed to the workspace owner on both Analytics locks", async () => {
    const teammate = user.on(world.planViewerWeb);
    await teammate.navigate(`${world.den.ref.webUrl}/dashboard/analytics`);
    await teammate.see({ role: "heading", label: "Usage & adoption" });
    const usageGate = await readPlanLock("Usage analytics", "Team usage is unavailable on this plan.", "teammate");
    await teammate.screenshot();
    await teammate.navigate(`${world.den.ref.webUrl}/dashboard/analytics/workflow-runs`);
    await teammate.see({ role: "heading", label: "Workflow Runs" });
    const runsGate = await readPlanLock("Workflow run history", "Run history is unavailable on this plan.", "teammate");
    const portal = await seed.api(world.den.members.planViewer, "/v1/billing/stripe/portal", { method: "POST" });
    expect(portal.response.status).toBe(403);
    evidence.recordAssertionEvidence("a non-owner admin gets owner guidance, not the owner's instruction or billing portal access", `${usageGate.state.text} ${usageGate.detail.text} ${usageGate.guidance.text} ${runsGate.state.text} ${runsGate.detail.text} ${runsGate.guidance.text} Each lock has one actor instruction and the unchanged pricing action; the non-owner's billing portal request returns ${portal.response.status}.`, true);
    await teammate.screenshot();
  });

  await step("a member without billing access still cannot change the workspace plan", async () => {
    const teammate = user.on(world.memberWeb);
    await teammate.navigate(`${world.den.ref.webUrl}/dashboard/billing`);
    await teammate.see({ testId: "member-dashboard" }, { timeoutMs: 60_000 });
    await teammate.notSee({ role: "heading", label: "Billing" });
    await teammate.notSee({ role: "button", label: "Add paid seats" });
    await teammate.notSee({ role: "button", label: "Manage subscription" });
    await teammate.notSee({ text: "You can change the plan." });
    const colleague = world.den.members.colleague;
    const memberContext = record((await probe.api(colleague, "/v1/org")).body);
    expect(record(memberContext.currentMember).isOwner).toBe(false);
    const billing = await probe.api(colleague, "/v1/billing");
    // Den refuses these actions before any billing provider is called. The
    // isolated world's Stripe key is empty; this cannot make a real purchase.
    const checkout = await seed.api(colleague, "/v1/billing/stripe/checkout", { method: "POST", body: JSON.stringify({ type: "seat" }) });
    const portal = await seed.api(colleague, "/v1/billing/stripe/portal", { method: "POST" });
    const statuses = [billing, checkout, portal].map((result) => result.response.status);
    expect(statuses).toEqual([403, 403, 403]);
    const organization = record((await probe.api(world.den.admin, "/v1/org")).body);
    expect(record(organization.entitlements).analytics).toBe(false);
    evidence.recordAssertionEvidence("actor-aware plan guidance does not give a member billing permissions", `Opening Billing returns the non-owner member to their home without plan-change controls or the owner's “You can change the plan.” instruction; billing read, checkout and portal return ${statuses.join(" / ")}; analytics remains locked and no billing provider is configured.`, true);
    await teammate.screenshot();
  });

  await world.setEnterprise(true);
  await user.reload();
  await user.click({ role: "link", label: /^Usage & adoption$/ });
  await user.click({ role: "link", label: "Workflow Runs" });
  await user.notSee({ text: "Workflow run history is part of the Enterprise plan." });
  await user.notSee({ testId: "nav-workflow-runs" });
  const before = await readRuns();
  evidence.recordAssertionEvidence("An Enterprise upgrade unlocks Workflow Runs inside Analytics with existing history intact", "The upgraded workspace opens Workflow Runs from the shared Analytics navigation and the API returns its pre-upgrade receipts, including the original saved version.", before.some((run) => run.id === world.receiptId));
  const first = before.find((run) => run.id === world.receiptId);
  expect(first).toMatchObject({ workflow: { configObjectId: world.configObjectId, title: "Weekly briefing", graph: world.originalGraph } });
  expect(record(first?.workflow).graph).not.toEqual(world.revisedGraph);
  expect(before.filter((run) => run.source === "adhoc").every((run) => run.workflow === null)).toBe(true);
  const failed = before.find((run) => run.status === "failed" && isRecord(run.workflow) && run.workflow.configObjectId === world.configObjectId);
  expect(failed).toMatchObject({ workflow: { graph: world.originalGraph } });
  const failedReceiptId = field(failed, "id");
  const oneOff = before.find((run) => run.source === "adhoc" && run.status === "succeeded");
  const oneOffReceiptId = field(oneOff, "id");

  await step("read existing diagrams directly in the run list", async () => {
    await user.see({ text: "Workflow Runs" }, { timeoutMs: 90_000 });
    await user.see({ role: "heading", label: "Workflow Runs" });
    for (const receiptId of [world.receiptId, failedReceiptId]) {
      // Scope rendered node text to each receipt; an empty diagram or the latest
      // version (Revised count) must fail even when another card is correct.
      await user.see({ testId: `workflow-run-visualization-${receiptId}` }, {
        text: /^(?![\s\S]*Revised count)(?=[\s\S]*Get workers)(?=[\s\S]*For each item in workers workers)(?=[\s\S]*Topic is set)(?=[\s\S]*Finish with: Topic, Count)[\s\S]*$/,
      });
      await user.see({ testId: `workflow-run-link-${receiptId}` }, { text: "Weekly briefing" });
      await user.see({ testId: `workflow-run-time-${receiptId}` });
    }
    await user.notSee({ testId: "den-workflow-flow-diagram", nth: 2 });
    await user.see({ testId: `workflow-run-link-${world.receiptId}` }, { text: "Weekly briefing" });
    await user.see({ testId: `workflow-run-time-${world.receiptId}` });
    await user.see({ text: "Succeeded" });
    await user.see({ text: "Failed" });
    await user.notSee({ text: `plugin:${world.pluginId}:${world.configObjectId}` });
    await user.see({ testId: `workflow-run-${oneOffReceiptId}` }, { text: /One-off task[\s\S]*Succeeded[\s\S]*Technical details/ });
    await user.see({ testId: `workflow-run-time-${oneOffReceiptId}` });
    await user.notSee({ testId: `workflow-run-link-${oneOffReceiptId}` });
    await user.notSee({ testId: `workflow-run-visualization-${oneOffReceiptId}` });
    await user.click({ testId: `workflow-run-details-${oneOffReceiptId}` });
    await user.see({ testId: `workflow-run-${oneOffReceiptId}` }, { text: /Source[\s\S]*adhoc[\s\S]*Tool calls[\s\S]*den.getWorkers[\s\S]*Duration[\s\S]*\d+(?:\.\d+)? (?:ms|s)/ });
    await user.click({ testId: `workflow-run-details-${oneOffReceiptId}` });
    await user.notSee({ role: "link", label: "One-off task" });
    await user.notSee({ label: "One-off task workflow visualization" });
    await user.screenshot();
  });
  evidence.recordAssertionEvidence("Saved runs show the existing visualization of their executed version", "The API graph matches the original version and differs from the later edit. The activity page renders both saved-run diagrams with a library link, status and time; one-off runs have neither a fabricated link nor a visualization.", true);
  evidence.recordAssertionEvidence("Workflow activity explains reuse and keeps raw run details collapsed", "The introduction is visible and the closed details element keeps raw source values out of the visible run card.", true);

  await step("open the linked workflow in the existing library", async () => {
    await user.click({ testId: `workflow-run-link-${world.receiptId}` });
    await user.see({ testId: "den-workflow-detail" }, { timeoutMs: 60_000 });
    await user.see({ text: "How it works" });
    await user.see({ text: "Weekly briefing" });
    expect(await readRuns()).toEqual(before);
    await user.navigate(`${world.den.ref.webUrl}/dashboard/workflow-runs`);
    await user.see({ text: "Workflow Runs" });
    expect(await probe.eval(world.web, () => location.pathname)).toBe("/dashboard/analytics/workflow-runs");
    await user.click({ testId: `workflow-run-details-${world.receiptId}` });
    await user.see({ text: `plugin:${world.pluginId}:${world.configObjectId}` });

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
    const memberNodes = record(record(visible[0].workflow).graph).nodes;
    if (!Array.isArray(memberNodes)) throw new Error("Expected the shared workflow graph");
    const originalNodes = record(world.originalGraph).nodes;
    if (!Array.isArray(originalNodes)) throw new Error("Expected the authored workflow graph");
    for (const [kind, label] of [["branch", "Condition"], ["loop", "Repeat"], ["return", "Result"]]) {
      const authored = originalNodes.map(record).filter((node) => node.kind === kind);
      const shared = memberNodes.map(record).filter((node) => node.kind === kind);
      expect(authored.length).toBeGreaterThan(0);
      expect(authored.every((node) => node.label !== label)).toBe(true);
      expect(shared.map((node) => node.id)).toEqual(authored.map((node) => node.id));
      expect(shared.map((node) => node.label)).toEqual(authored.map(() => label));
    }
    const removed = await seed.api(world.den.admin, `/v1/config-objects/${world.configObjectId}/access/${field(record(grant.body).item, "id")}`, { method: "DELETE" });
    expect(removed.response.ok, removed.text).toBe(true);
    const revoked = await readRuns(colleague);
    expect(revoked).toHaveLength(1);
    expect(revoked[0]).toMatchObject({ id: memberRun.receiptId, workflow: null });
    expect((await probe.api(colleague, `/v1/workflows/${world.configObjectId}`)).response.status).toBe(403);
  });
  evidence.recordAssertionEvidence("Run previews follow workflow access without widening run visibility", "A member sees none of the admin's runs, then sees a redacted preview of their own shared workflow run. Revoking the workflow grant preserves their receipt but removes its preview and library metadata.", true);

  await step("run the saved workflow from its simple form", async () => {
    await user.navigate(`${world.den.ref.webUrl}/dashboard/library/workflows/${world.configObjectId}`);
    await user.see({ testId: "workflow-overview" }, { text: /Run workflow[\s\S]*Latest result[\s\S]*How it works/, timeoutMs: 60_000 });
    await user.see({ testId: "den-workflow-input-form" });
    await user.notSee({ label: "Run input details" });
    const beforeRun = await readRuns();
    await user.see({ testId: "workflow-overview" }, { text: /^(?![\s\S]*No custom display yet)[\s\S]*Customize result display/ });
    await user.click({ text: "Customize result display" });
    await user.see({ text: /No custom display yet/ });
    await user.click({ text: "Customize result display" });
    await user.see({ testId: "workflow-overview" }, { text: /^(?![\s\S]*No custom display yet)[\s\S]*Customize result display/ });
    await user.type({ role: "textbox", label: /^Topic/ }, "A fresh briefing", { replace: true, verify: true });
    await user.click({ text: "Advanced input" });
    await user.see({ label: "Run input details" }, { value: JSON.stringify({ topic: "A fresh briefing" }, null, 2) });
    await user.click({ text: "Advanced input" });
    await user.notSee({ label: "Run input details" });
    expect(await readRuns()).toEqual(beforeRun);
    await user.click({ role: "button", label: "Run workflow" });
    await user.see({ testId: "den-workflow-artifact-result" }, { text: /A fresh briefing/, timeoutMs: 60_000 });
    const afterRun = await readRuns();
    expect(afterRun).toHaveLength(beforeRun.length + 1);
    const added = afterRun.filter((run) => !beforeRun.some((previous) => previous.id === run.id));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ status: "succeeded", workflow: { configObjectId: world.configObjectId, graph: world.revisedGraph } });
    await user.see({ role: "button", label: "Run workflow" });
    await user.see({ testId: "den-workflow-flow-diagram" });
    await user.screenshot();
  });
  evidence.recordAssertionEvidence("The workflow opens with a simple run form and shows the submitted result", "The form precedes the latest result and existing diagram. Advanced input starts hidden and stays synchronized with the named field; editing and inspecting it create no runs. Submitting creates exactly one successful run of the current saved version and displays the entered topic in its result.", true);

  await step("keep workflow execution working after Enterprise access is removed", async () => {
    await world.setEnterprise(false);
    await user.navigate(`${world.den.ref.webUrl}/dashboard/analytics/workflow-runs`);
    await user.see({ text: "Workflow run history is part of the Enterprise plan." });
    await user.notSee({ testId: `workflow-run-link-${world.receiptId}` });
    await user.notSee({ role: "link", label: "Workflow Runs" });
    expect((await probe.api(world.den.admin, "/v1/workflow-runs")).response.status).toBe(402);
    await user.navigate(`${world.den.ref.webUrl}/dashboard/library/workflows/${world.configObjectId}`);
    await user.see({ role: "button", label: "Run workflow" });
    await user.type({ role: "textbox", label: /^Topic/ }, "Briefing after plan change", { replace: true, verify: true });
    await user.click({ role: "button", label: "Run workflow" });
    await user.see({ testId: "den-workflow-artifact-result" }, { text: /Briefing after plan change/, timeoutMs: 60_000 });
    expect((await probe.api(world.den.admin, "/v1/workflow-runs")).response.status).toBe(402);
    await user.screenshot();
  });
  evidence.recordAssertionEvidence("Removing Enterprise access hides history without breaking workflow execution", "After the downgrade, previously viewed receipts and the Workflow Runs link are absent and the API is locked. Running the saved workflow from the Library still succeeds and displays the newly submitted result.", true);

});
