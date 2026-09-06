import { spec } from "@openwork/testkit";
import { expect } from "vitest";
import { denFetch, sendComposerMessage, waitForAssistantReply, selectModel } from "@openwork/behaviors";
import { modelsAnalyticsWorld } from "../worlds/models-analytics.ts";

const test = spec.world(modelsAnalyticsWorld, { timeout: 900_000, needs: {} });
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected an API object");
  return Object.fromEntries(Object.entries(value));
}
function list(value: unknown): Record<string, unknown>[] { return Array.isArray(value) ? value.map(record) : []; }

test("an existing Models subscriber can decline, enable and disable task analytics without losing Models", { timeout: 1_800_000 }, async ({ world, user, probe, evidence }) => {
  {
  const api = (path: string, init?: RequestInit, session = world.den.admin) => denFetch(session, path, {
    ...init, headers: { authorization: `Bearer ${session.token}`, "x-openwork-org-id": world.orgId, "content-type": "application/json" },
  });
  const settings = async () => record((await api("/v1/inference/analytics/settings")).body);
  const activity = async () => list(record((await api("/v1/inference/analytics/activity")).body).events);
  const baseline = record(record((await api("/v1/inference")).body).inference);
  expect(baseline).toMatchObject({ enabled: true, subscribed: true, tier: "tier1" });
  await user.see({ role: "button", label: "Manage subscription" }, { timeoutMs: 90_000 });
  await user.notSee({ text: "Unlock custom insights" });
  expect(await settings()).toMatchObject({ available: false, enabled: false });
  const beforeRollout = await world.complete({ sessionId: "existing-conversation", taskId: "before-rollout" });
  expect(beforeRollout.status).toBe(200);
  expect(beforeRollout.body).toContain("working.");
  expect((await api("/v1/inference/analytics/activity")).response.status).toBe(403);
  evidence.recordAssertionEvidence("An existing paid Models organization keeps model access while analytics is unreleased and inaccessible", "Managed model request returned 200; subscription remained enabled; analytics was absent from the UI and read API returned 403", true);

  const unupgraded = await world.anotherOrganization();
  const legacyDeletion = await denFetch(unupgraded.admin, "/v1/org", { method: "DELETE", headers: { authorization: `Bearer ${unupgraded.admin.token}`, "x-openwork-org-id": unupgraded.orgId } });
  expect(legacyDeletion.response.status).toBe(200);
  evidence.recordAssertionEvidence("Existing workspace deletion remains available before the analytics migration", "A separate workspace was deleted through the public API while the analytics tables were absent", true);

  await world.upgradeAnalytics();
  expect(record(record((await api("/v1/inference")).body).inference)).toEqual(baseline);
  expect((await world.complete({ sessionId: "existing-conversation", taskId: "after-schema-upgrade" })).status).toBe(200);
  evidence.recordAssertionEvidence("Applying the analytics migration preserves an existing paid subscription and model key", "The real Models API served the existing key before the new tables existed and after the additive migration; subscription status stayed identical", true);

  await world.rollout(true);
  await user.reload();
  await user.see({ text: "Unlock custom insights" }, { timeoutMs: 60_000 });
  await user.see({ text: /Prompts, responses and file contents are excluded\./ });
  await user.screenshot();
  expect(await settings()).toMatchObject({ enabled: false, subscribed: true, consentedAt: null });
  expect((await api("/v1/inference/analytics/settings", { method: "PATCH", body: JSON.stringify({ enabled: true }) })).response.status).toBe(400);
  await user.click({ role: "button", label: "Not now" });
  await user.see({ text: "Task analytics is off." });
  expect(await settings()).toMatchObject({ enabled: false });
  const declined = await world.complete({ sessionId: "existing-conversation", taskId: "declined" });
  expect(declined.status).toBe(200);
  await user.reload();
  await user.see({ role: "button", label: "Enable task analytics" }, { timeoutMs: 60_000 });
  await user.notSee({ role: "button", label: "Not now" });
  evidence.recordAssertionEvidence("Existing subscribers are asked for an explicit choice; Not now persists and leaves Models working", "No consent by default, missing confirmation rejected with 400, decline survives reload, same model key still returns 200", true);
  await user.screenshot();

  await user.click({ role: "button", label: "Enable task analytics" });
  await user.see({ role: "tab", label: "Activity" });
  expect(await settings()).toMatchObject({ enabled: true, consentVersion: 1 });
  expect(await activity()).toHaveLength(0);
  const subscription = record(record((await api("/v1/inference")).body).inference);
  expect(subscription).toEqual(baseline);

  const first = await world.complete({ sessionId: "existing-conversation", taskId: "enabled-task" });
  const second = await world.complete({ sessionId: "existing-conversation", taskId: "enabled-task", model: "minimax/minimax-m3", stream: false });
  expect(first.status).toBe(200); expect(first.body).toContain("data: [DONE]");
  expect(second.status).toBe(200); expect(JSON.parse(second.body).choices[0].message.content).toBe("Models are working.");
  const calls = await probe.eventually(activity, { within: 30_000, label: "two Models calls in one task", until: (rows) => rows.filter((row) => row.type === "model.call").length === 2 });
  expect(calls.map((call) => call.model).sort()).toEqual(["minimax/minimax-m3", "z-ai/glm-5.2"]);
  expect(calls.every((call) => call.usageComplete === true && call.costUsd === 0.0123 && call.inputTokens === 120 && call.outputTokens === 30 && call.cacheReadTokens === 20)).toBe(true);
  expect(JSON.stringify(calls)).not.toContain("A private task prompt");
  const now = new Date().toISOString();
  const events = [
    { id: "skill-one", type: "skill.loaded", skill: "briefing", skillVersion: "v1", timestamp: now, sessionId: "existing-conversation", taskId: "enabled-task" },
    { id: "skill-two", type: "skill.loaded", skill: "research", skillVersion: "v2", timestamp: now, sessionId: "existing-conversation", taskId: "enabled-task" },
    { id: "tool-one", type: "tool.executed", tool: "fixture_lookup", mcp: "fixture", status: "completed", durationMs: 40, timestamp: now, sessionId: "existing-conversation", taskId: "enabled-task", metadata: { workflow: "briefing" } },
    { id: "task-finished", type: "task.completed", status: "completed", durationMs: 1200, timestamp: now, sessionId: "existing-conversation", taskId: "enabled-task" },
  ];
  for (let attempt = 0; attempt < 2; attempt++) expect((await api("/v1/inference/analytics/events", { method: "POST", body: JSON.stringify({ events }) })).response.status).toBe(202);
  expect(await activity()).toHaveLength(6);
  expect((await api("/v1/inference/analytics/events", { method: "POST", body: JSON.stringify({ events: [{ ...events[0], prompt: "must not be collected" }] }) })).response.status).toBe(400);
  expect((await api("/v1/inference/analytics/events", { method: "POST", body: JSON.stringify({ events: [{ ...events[0], costUsd: 100 }] }) })).response.status).toBe(400);
  const forged = await api("/v1/inference/analytics/events", { method: "POST", body: JSON.stringify({ events }) }, world.den.members.teammate);
  expect(record(forged.body).acceptedIds).toEqual([]);
  expect((await api("/v1/inference/analytics/activity", undefined, world.den.members.teammate)).response.status).toBe(403);
  expect((await api("/v1/inference/analytics/settings", { method: "PATCH", body: JSON.stringify({ enabled: true, consentVersion: 1 }) }, world.den.members.teammate)).response.status).toBe(403);
  evidence.recordAssertionEvidence("The ingestion API preserves submitted metadata, deduplicates retries and excludes content", "No pre-consent backfill; 2 real inference calls plus 4 events submitted through the ingestion API after retry; private prompt absent; content and client-supplied costs rejected", true);
  evidence.recordAssertionEvidence("Members cannot view organization analytics, change the choice or attach events to another member's task", "Read/write settings returned 403; forged task batch accepted zero events", true);
  const other = await world.anotherSubscriber();
  const isolated = await denFetch(other.admin, "/v1/inference/analytics/activity", { headers: { authorization: `Bearer ${other.admin.token}`, "x-openwork-org-id": other.orgId } });
  expect(isolated.response.status).toBe(200);
  expect(record(isolated.body).events).toEqual([]);
  evidence.recordAssertionEvidence("A second paid, opted-in organization cannot see the first organization's activity", "The second organization has analytics access, returns HTTP 200, and sees zero events", true);

  await user.click({ role: "button", label: "Refresh analytics" });
  await user.see({ text: "completed" });
  await user.click({ role: "tab", label: "Consumption" });
  await user.see({ text: "$0.0123" });
  await user.screenshot();
  const missing = await world.complete({ sessionId: "existing-conversation", taskId: "incomplete-task", prompt: "fixture:missing-usage" });
  expect(missing.status).toBe(200);
  const failed = await world.complete({ sessionId: "existing-conversation", taskId: "failed-task", prompt: "fixture:error" });
  expect(failed.status).toBe(503);
  const recorded = await probe.eventually(activity, { within: 30_000, label: "incomplete and failed call accounting", until: (rows) => rows.length === 8 });
  expect(recorded.find((row) => row.taskId === "incomplete-task")).toMatchObject({ usageComplete: false });
  expect(recorded.find((row) => row.taskId === "incomplete-task")).not.toHaveProperty("costUsd");
  expect(recorded.find((row) => row.taskId === "failed-task")).toMatchObject({ status: "failed", usageComplete: false });
  evidence.recordAssertionEvidence("Streaming and JSON responses remain usable; failed or incomplete calls do not invent zero-cost usage", "Both response formats returned their expected text; missing usage has no cost; upstream 503 remains 503 and is recorded as failed", true);

  await user.click({ role: "button", label: "Turn off analytics" });
  await user.see({ role: "button", label: "Enable task analytics" });
  expect(await settings()).toMatchObject({ enabled: false, exportEnabled: false });
  const afterDisable = await world.complete({ sessionId: "existing-conversation", taskId: "after-disable" });
  expect(afterDisable.status).toBe(200);
  expect(record(record((await api("/v1/inference")).body).inference)).toEqual(baseline);
  expect((await api("/v1/inference/analytics/activity")).response.status).toBe(403);
  await user.click({ role: "button", label: "Enable task analytics" });
  await user.see({ role: "tab", label: "Activity" });
  expect(await activity()).toHaveLength(8);
  await world.subscription(false);
  expect(await settings()).toMatchObject({ enabled: false, subscribed: false });
  expect((await api("/v1/inference/analytics/activity")).response.status).toBe(403);
  expect((await api("/v1/inference/analytics/events", { method: "POST", body: JSON.stringify({ events }) })).response.status).toBe(204);
  await world.subscription(true);
  expect(await activity()).toHaveLength(8);
  await world.rollout(false);
  expect((await api("/v1/inference/analytics/consumption")).response.status).toBe(403);
  expect((await world.complete({ sessionId: "existing-conversation", taskId: "after-rollout-disabled" })).status).toBe(200);
  evidence.recordAssertionEvidence("Turning analytics off preserves the Models subscription and existing key; downgrade and rollout removal stop analytics", "Same key returns 200 after disable and rollout removal; subscription status is unchanged; reads are denied and no disabled-period events reappear", true);
  }
  {
  const webUser = user.on(world.web);
  await world.rollout(true);
  await webUser.reload();
  await webUser.see({ role: "tab", label: "Integrations" }, { timeoutMs: 60_000 });
  await webUser.click({ role: "tab", label: "Integrations" });
  await webUser.click({ text: /^Data region/ });
  await webUser.press("End"); await webUser.press("Enter");
  await webUser.type({ role: "textbox", label: "Langfuse address" }, "https://127.0.0.1", { replace: true });
  await webUser.type({ role: "textbox", label: "Public key" }, "fixture-public", { replace: true });
  await webUser.type({ label: "Secret key" }, "fixture-secret", { replace: true });
  await webUser.click({ role: "button", label: "Test connection" });
  await webUser.see({ text: "Could not connect." });
  await webUser.type({ role: "textbox", label: "Langfuse address" }, world.witnessUrl, { replace: true });
  await webUser.click({ role: "button", label: "Test connection" });
  await webUser.see({ text: "Connection verified." });
  await webUser.click({ role: "button", label: "Connect Langfuse" });
  await webUser.see({ role: "button", label: "Disconnect Langfuse" });
  const snapshot = async () => record(await fetch(`${world.witnessUrl}/fixture/requests`, { signal: AbortSignal.timeout(5_000) }).then((response) => response.json()));
  const spans = (snapshot: Record<string, unknown>) => list(snapshot.exports).flatMap((batch) => list(batch.resourceSpans).flatMap((resource) => list(resource.scopeSpans).flatMap((scope) => list(scope.spans))));
  expect(spans(await snapshot())).toEqual([]);
  await webUser.screenshot();
  expect((await fetch(`${world.witnessUrl}/fixture/export-hold`, { method: "POST" })).ok).toBe(true);
  expect((await world.complete({ sessionId: "export-conversation", taskId: "exported-task", prompt: "This private text must never reach Langfuse" })).status).toBe(200);
  const exported = await probe.eventually(async () => spans(await snapshot()), { within: 70_000, label: "new metadata reaches the Langfuse witness", until: (spans) => spans.length > 0 });
  const serialized = JSON.stringify(exported);
  expect(serialized).toContain("exported-task");
  expect(serialized).toContain("0.0123");
  expect(serialized).not.toContain("enabled-task");
  expect(serialized).not.toContain("This private text");
  expect(serialized).not.toContain("fixture-secret");
  expect((await snapshot()).exportInFlight).toBe(true);
  await webUser.click({ role: "button", label: "Turn off analytics" });
  let disabled = false;
  const disabledChoice = webUser.see({ role: "button", label: "Enable task analytics" }).then(() => { disabled = true; });
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(disabled).toBe(false);
  expect((await fetch(`${world.witnessUrl}/fixture/export-release`, { method: "POST" })).ok).toBe(true);
  await disabledChoice;
  expect((await world.complete({ sessionId: "export-conversation", taskId: "disabled-export" })).status).toBe(200);
  // Cover a full export interval; a negative assertion needs an observation window.
  await new Promise((resolve) => setTimeout(resolve, 35_000));
  expect(spans(await snapshot())).toHaveLength(exported.length);
  evidence.recordAssertionEvidence("The Langfuse UI verifies project access, rejects private addresses, and exports only newly collected metadata", "Private address rejected; HTTPS witness connected; new model usage arrived without prompt text, keys or historical activity", true);
  evidence.recordAssertionEvidence("Turning off task analytics stops export while Models keeps responding", "New Models request returned 200 after disable; no extra spans arrived across a full export interval", true);
  evidence.recordAssertionEvidence("Opt-out finishes only after an already-authorized export has finished", "The Langfuse witness held an export response; the UI could not confirm opt-out until the response was released, then no later export arrived", true);
  }
  {
  const webUser = user.on(world.web);
  const api = (path: string, init?: RequestInit) => denFetch(world.den.admin, path, { ...init,
    headers: { authorization: `Bearer ${world.den.admin.token}`, "x-openwork-org-id": world.orgId, "content-type": "application/json" },
  });
  await world.rollout(true);
  expect((await api("/v1/inference/analytics/settings", { method: "PATCH", body: JSON.stringify({ enabled: false }) })).response.ok).toBe(true);
  const { app, session, analyticsTransport, upgradeDenApi } = await world.desktop();
  await selectModel(app, "z-ai/glm-5.2", { provider: "OpenWork Models" });
  let replies = 0;
  async function send(prompt: string) {
    await sendComposerMessage(app, prompt);
    const reply = await probe.eventually(() => waitForAssistantReply(app, { timeoutMs: 30_000 }), {
      within: 60_000, label: "a new assistant reply", until: (reply) => reply.assistantMessageCount > replies && reply.text.includes("Models are working."),
    });
    replies = reply.assistantMessageCount;
    await user.on(app).see({ role: "button", label: "Run task" }, { timeoutMs: 60_000 });
    await user.on(app).notSee({ testId: "session-error-card" });
  }
  const activity = async () => list(record((await api(`/v1/inference/analytics/activity?sessionId=${session.sessionId}`)).body).events);
  await send("Summarize the plan before enabling task analytics.");
  const legacyRequests = await probe.eventually(async () => (await analyticsTransport.admin.requests()).requests, {
    within: 30_000, label: "the desktop encounters an unavailable analytics endpoint",
    until: (requests) => requests.some((request) => request.path.endsWith("/inference/analytics/settings") && request.status === 404 && request.faulted),
  });
  expect(legacyRequests.some((request) => request.method === "POST" && request.path.endsWith("/inference/analytics/events"))).toBe(false);
  evidence.recordAssertionEvidence("A newer desktop keeps Models working when Den has no analytics endpoint", "The real desktop received an injected HTTP 404 for analytics settings, still produced the assistant reply, and never attempted to upload task events", true);
  await upgradeDenApi();
  await webUser.reload();
  await webUser.see({ role: "button", label: "Enable task analytics" }, { timeoutMs: 60_000 });
  await webUser.click({ role: "button", label: "Enable task analytics" });
  await webUser.see({ role: "tab", label: "Activity" });
  expect(await activity()).toEqual([]);
  await send("Continue the same conversation after enabling task analytics.");
  await user.on(app).screenshot();
  const events = await probe.eventually(activity, { within: 90_000, label: "live task correlated with its model call", until: (events) => events.some((event) => event.type === "model.call") && events.some((event) => typeof event.type === "string" && ["task.completed", "task.failed", "task.cancelled"].includes(event.type)) });
  expect(events.filter((event) => event.type === "task.completed")).toHaveLength(1);
  expect(new Set(events.map((event) => event.taskId)).size).toBe(1);
  expect(events.filter((event) => event.type === "task.started")).toHaveLength(1);
  expect(JSON.stringify(events)).not.toContain("Continue the same conversation");
  await selectModel(app, "minimax/minimax-m3", { provider: "OpenWork Models" });
  await send("Continue with another OpenWork model.");
  const switched = await probe.eventually(activity, { within: 90_000, label: "model switch keeps the conversation's task history", until: (events) => events.filter((event) => event.type === "task.completed").length === 2 });
  expect(new Set(switched.filter((event) => event.type === "model.call").map((event) => event.model))).toEqual(new Set(["z-ai/glm-5.2", "minimax/minimax-m3"]));
  await user.on(app).see({ text: "Summarize the plan before enabling task analytics." });
  await user.on(app).screenshot();
  evidence.recordAssertionEvidence("Real desktop tasks correlate with inference usage after opt-in without replacing the conversation or collecting earlier prompts", "The same conversation produced new replies before and after opt-in; runtime task start/completion joined the model call by task ID; two models and two tasks retained; prompt text absent", true);
  await send("Load the analytics fixture skill, find its file, and report whether Models are working.");
  const withSkill = await probe.eventually(activity, { within: 90_000, label: "native skill and tool activity reaches Models analytics", until: (rows) => rows.some((row) => row.type === "skill.loaded" && row.skill === "analytics-fixture") && rows.some((row) => row.type === "tool.executed" && row.tool === "glob") && rows.filter((row) => row.type === "task.completed").length === 3 });
  expect(withSkill.find((row) => row.skill === "analytics-fixture")).toMatchObject({ type: "skill.loaded", tool: "skill", status: "completed" });
  evidence.recordAssertionEvidence("A real desktop skill invocation produces task analytics", "The model invoked the native skill tool; OpenCode loaded the arranged skill and the resulting skill.loaded event reached the API without a handcrafted ingestion event", true);
  expect(withSkill.find((row) => row.tool === "glob")).toMatchObject({ type: "tool.executed", status: "completed", taskId: withSkill.find((row) => row.skill === "analytics-fixture")?.taskId });
  evidence.recordAssertionEvidence("A real desktop file search produces tool activity within the same task", "The model invoked the native glob tool; its completed tool.executed event reached analytics with the skill invocation's task ID, without a handcrafted ingestion event", true);
  await webUser.click({ role: "button", label: "Turn off analytics" });
  await webUser.see({ role: "button", label: "Enable task analytics" });
  await analyticsTransport.admin.phase("analytics-disabled");
  await send("Keep working after turning off task analytics.");
  const providerCalls = list(record(await fetch(`${world.witnessUrl}/fixture/requests`).then((response) => response.json())).calls);
  expect(providerCalls.at(-1)).toMatchObject({ model: "minimax/minimax-m3", authenticated: true, kind: "success" });
  await webUser.click({ role: "button", label: "Enable task analytics" });
  await webUser.see({ role: "tab", label: "Activity" });
  // Observe beyond background reporting and the cached settings interval so a
  // delayed upload cannot make the disabled-period task appear after this check.
  await new Promise((resolve) => setTimeout(resolve, 40_000));
  expect(await activity()).toHaveLength(withSkill.length);
  const afterOptOut = (await analyticsTransport.admin.requests()).requests.filter((request) => request.phase === "analytics-disabled");
  expect(afterOptOut.some((request) => request.method === "POST" && request.path.endsWith("/inference/analytics/events"))).toBe(false);
  await user.on(app).see({ text: "Keep working after turning off task analytics." });
  evidence.recordAssertionEvidence("Turning analytics off leaves the existing desktop conversation and selected model usable", "A new assistant reply arrived from the same selected model after disable; the independent HTTP witness observed no task-event uploads across opt-out, re-enable and 40 seconds of background reporting, the disabled-period task was absent, and the earlier conversation was still visible", true);
  expect((await api("/v1/org", { method: "DELETE" })).response.status).toBe(200);
  await world.verifyErasure();
  evidence.recordAssertionEvidence("Deleting a workspace erases its task analytics and stored export credentials", "Workspace deletion returned 200; an independent data-store witness found no retained history or analytics configuration", true);
  }
});
