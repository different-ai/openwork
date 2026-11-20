import { expect, test } from "bun:test";
import { createFeatureAnalytics, nativeSkillAnalyticsIdentity, recordDesktopAutomationLifecycle } from "@openwork/product-analytics";
import { createFeatureToolObserver } from "@openwork/product-analytics";
import type { AnalyticsProperties } from "../src/app/lib/analytics";

function fixture() {
  const events: { event: string; properties: AnalyticsProperties }[] = [];
  const analytics = createFeatureAnalytics((event, properties = {}) => { events.push({ event, properties }); });
  return { events, analytics, observe: createFeatureToolObserver(analytics) };
}

test("skill and connector identities explicitly project safe fields, never names, URLs or non-builtin skill ids", () => {
  const { analytics, events } = fixture();
  const local: { skill_source: "local"; skill_id: string; name: string } = { skill_source: "local", skill_id: "/private/skill", name: "private skill" };
  const organization: { skill_source: "organization"; skill_id: string; name: string } = { skill_source: "organization", skill_id: "private-org-id", name: "private skill" };
  const custom: { connector_kind: "custom"; connector_id: string; name: string; url: string } = { connector_kind: "custom", connector_id: "secret", name: "private connector", url: "https://private.example" };
  analytics.skillInvoked(local);
  analytics.skillCreated(organization);
  analytics.skillInstalled(organization);
  analytics.skillInstalled({ skill_source: "builtin", skill_id: "skill-creator" });
  analytics.connectionAdded(custom);
  analytics.connectionSignInSucceeded(custom);
  analytics.connectionSignInFailed(custom);
  analytics.connectionAdded({ connector_kind: "catalog", connector_id: "public-catalog-id" });
  expect(events).toEqual([
    { event: "skill_invoked", properties: { skill_source: "local" } },
    { event: "skill_created", properties: { skill_source: "organization" } },
    { event: "skill_installed", properties: { skill_source: "organization" } },
    { event: "skill_installed", properties: { skill_source: "builtin", skill_id: "skill-creator" } },
    { event: "connection_added", properties: { connector_kind: "custom" } },
    { event: "connection_sign_in_succeeded", properties: { connector_kind: "custom" } },
    { event: "connection_sign_in_failed", properties: { connector_kind: "custom" } },
    { event: "connection_added", properties: { connector_kind: "catalog", connector_id: "public-catalog-id" } },
  ]);
});

test("feature helpers emit only fixed labels and approved public model/provider identifiers", () => {
  const { analytics, events } = fixture();
  analytics.connectorToolCalled();
  analytics.automationProposed();
  analytics.automationCreated("cloud");
  analytics.automationRunStarted("desktop");
  analytics.automationRunFinished("desktop", "succeeded");
  analytics.automationRunFinished("desktop", "failed");
  analytics.automationRunFinished("desktop", "cancelled");
  analytics.artifactCreated();
  analytics.artifactOpened();
  analytics.browserOpened();
  analytics.browserUsed();
  analytics.computerOpened();
  analytics.computerUsed();
  analytics.filePreviewed("pdf");
  analytics.fileEdited("code");
  analytics.fileDownloaded();
  analytics.modelChanged({ providerID: "openai", modelID: "gpt-4" }, { providerID: "anthropic", modelID: "claude" }, true);
  analytics.modelChanged(null, { providerID: "openai", modelID: "gpt-4" }, false);
  analytics.providerConnected("openai", "api_key");
  analytics.providerConnected("anthropic", "oauth");
  analytics.subagentStarted(true);
  expect(events).toEqual([
    { event: "connector_tool_called", properties: { tool_category: "connector" } },
    { event: "automation_proposed", properties: {} },
    { event: "automation_created", properties: { placement: "cloud" } },
    { event: "automation_run_started", properties: { placement: "desktop" } },
    ...["succeeded", "failed", "cancelled"].map((outcome) => ({ event: "automation_run_finished", properties: { placement: "desktop", outcome } })),
    { event: "artifact_created", properties: {} },
    { event: "artifact_opened", properties: {} },
    { event: "browser_opened", properties: {} },
    { event: "browser_used", properties: { tool_category: "browser" } },
    { event: "computer_opened", properties: {} },
    { event: "computer_used", properties: { tool_category: "computer" } },
    { event: "file_previewed", properties: { file_type: "pdf" } },
    { event: "file_edited", properties: { file_type: "code" } },
    { event: "file_downloaded", properties: {} },
    { event: "model_changed", properties: { from_provider_id: "openai", from_model_id: "gpt-4", to_provider_id: "anthropic", to_model_id: "claude", mid_session: true } },
    { event: "model_changed", properties: { from_provider_id: null, from_model_id: null, to_provider_id: "openai", to_model_id: "gpt-4", mid_session: false } },
    { event: "provider_connected", properties: { provider_id: "openai", method: "api_key" } },
    { event: "provider_connected", properties: { provider_id: "anthropic", method: "oauth" } },
    { event: "subagent_started", properties: { tool_category: "subagent", background: true } },
  ]);
  analytics.modelChanged({ providerID: "openai", modelID: "gpt-4" }, { providerID: "openai", modelID: "gpt-4" }, true);
  expect(events).toHaveLength(21);
});

test("native skill origins never emit their private registry ids", () => {
  expect(nativeSkillAnalyticsIdentity("openwork-cloud-private-team-skill")).toEqual({ skill_source: "organization" });
  expect(nativeSkillAnalyticsIdentity("/private/work/skill")).toEqual({ skill_source: "local" });
  expect(nativeSkillAnalyticsIdentity("skill-creator")).toEqual({ skill_source: "local" });
});

test("desktop lifecycle IPC accepts only fixed phases/outcomes and projects away assignment data", () => {
  const { analytics, events } = fixture();
  recordDesktopAutomationLifecycle(analytics, { phase: "started", instructions: "private instructions", workspaceId: "private" });
  recordDesktopAutomationLifecycle(analytics, { phase: "finished", outcome: "failed", error: "private message" });
  recordDesktopAutomationLifecycle(analytics, { phase: "finished", outcome: "private outcome" });
  recordDesktopAutomationLifecycle(analytics, { phase: "private phase" });
  recordDesktopAutomationLifecycle(analytics, null);
  expect(events).toEqual([
    { event: "automation_run_started", properties: { placement: "desktop" } },
    { event: "automation_run_finished", properties: { placement: "desktop", outcome: "failed" } },
  ]);
});

function part(tool: string, status = "completed", input: unknown = {}, output: unknown = "done") {
  return { id: tool, sessionID: "private-session", messageID: "private-message", tool, state: { status, input, output } };
}

test("live tool observation deduplicates terminal updates, ignores pending/failures, never captures arguments or outputs", () => {
  const { observe, events } = fixture();
  const owner = {};
  const input = { name: "private name", path: "/private/path", prompt: "private prompt", code: "private code" };
  observe(owner, part("browser_open", "running", input));
  observe(owner, part("browser_open", "error", input));
  observe(owner, part("browser_open", "completed", input));
  observe(owner, part("browser_open", "completed", input));
  observe(owner, part("computer_act", "completed", input));
  observe(owner, part("openwork-cloud_create_app", "completed", input, '{"ok":false}'));
  observe(owner, part("openwork-cloud_get_skill", "completed", input));
  observe(owner, part("skill", "completed", input));
  observe(owner, part("private-service_tool", "completed", input));
  expect(events).toEqual([
    { event: "browser_opened", properties: {} },
    { event: "computer_used", properties: { tool_category: "computer" } },
    { event: "skill_invoked", properties: { skill_source: "organization" } },
    { event: "skill_invoked", properties: { skill_source: "local" } },
    { event: "connector_tool_called", properties: { tool_category: "connector" } },
  ]);
});

test("connector discovery is not usage, and semantic MCP failures are not successful feature actions", () => {
  const { observe, events } = fixture();
  const owner = {};
  observe(owner, part("openwork-cloud_search_capabilities"));
  observe(owner, part("openwork-cloud_execute_capability", "completed", { name: "getOrganization", body: { private: true } }));
  observe(owner, { ...part("openwork-cloud_create_app"), state: { status: "completed", input: {}, output: "done", metadata: { openworkMcpResult: { isError: true, content: [{ text: "private error" }] } } } });
  observe(owner, { ...part("openwork-cloud_execute_capability", "completed", { name: "mcp:private-id:private-tool", body: { private: true } }), id: "external-capability" });
  expect(events).toEqual([{ event: "connector_tool_called", properties: { tool_category: "connector" } }]);
});

test("native browser affordances and dotted external tool names use coarse categories", () => {
  const { observe, events } = fixture();
  const owner = {};
  observe(owner, part("openwork_execute", "completed", { id: "browser.open_url", args: { url: "https://private.example" } }, { ok: true }));
  observe(owner, part("private-service.search", "completed", { query: "private" }));
  expect(events).toEqual([
    { event: "browser_opened", properties: {} },
    { event: "connector_tool_called", properties: { tool_category: "connector" } },
  ]);
});

test("Code Mode inner calls count each invocation once, including parallel calls of the same tool", () => {
  const { observe, events } = fixture();
  const owner = {};
  const inner = (invocationId: string, status: string) => ({ invocationId, tool: "openwork-cloud_create_app", status, input: { source: "private source" } });
  const update = (details: unknown[]) => ({ ...part("execute", "running"), state: { status: "running", input: {}, metadata: { openworkToolDetails: details } } });
  observe(owner, update([inner("one", "running"), inner("two", "running")]));
  observe(owner, update([inner("one", "completed"), inner("two", "running")]));
  observe(owner, update([inner("one", "completed"), inner("two", "completed")]));
  observe(owner, update([inner("one", "completed"), inner("two", "completed")]));
  expect(events).toEqual([{ event: "artifact_created", properties: {} }, { event: "artifact_created", properties: {} }]);
});

test("subagent start requires a created child or successful result and is not repeated on completion", () => {
  const { observe, events } = fixture();
  const owner = {};
  observe(owner, part("task", "running", { background: true }));
  observe(owner, { ...part("task", "running", { background: true }), state: { status: "running", input: { background: true }, metadata: { sessionId: "private-child" } } });
  observe(owner, part("task", "completed", { background: true }));
  expect(events).toEqual([{ event: "subagent_started", properties: { tool_category: "subagent", background: true } }]);
});
