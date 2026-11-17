import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { productAnalytics } from "../worlds/product-analytics.ts";

const test = spec.world(productAnalytics, {
  resources: { surfaces: ["appWeb"], services: ["mock"] }, timeout: 300_000,
});

function isRecord(data: unknown): data is Record<string, unknown> {
  return data !== null && typeof data === "object" && !Array.isArray(data);
}

function properties(data: unknown): Record<string, unknown> {
  return isRecord(data) ? data : {};
}

test("a new person's first conversation records coarse launch and run quality without message content", async ({ world, user, probe, step, evidence }) => {
  await step("the new person opens an editable composer with anonymous launch context", async () => {
    await user.see("composer", { editable: true });
    const events = await world.events();
    const opened = properties(events.find(event => event.name === "analytics.app_opened")?.data);
    expect(opened).toMatchObject({ official_build: false, signed_in: false, install_age_days: 0 });
    expect(opened.run_number).toBeGreaterThanOrEqual(1);
    expect(opened.$session_id).toEqual(expect.any(String));
    expect(opened.os).toEqual(expect.any(String));
    expect(opened.arch).toEqual(expect.any(String));
    expect(events.some(event => event.name === "analytics.onboarding_composer_shown")).toBe(true);
    evidence.recordAssertionEvidence("Launch context reaches the local inspector", "Unofficial build; signed out; install age 0; launch counter, OS, architecture and session identifier present", opened.official_build === false && opened.signed_in === false && typeof opened.$session_id === "string");
    await user.screenshot();
  });

  await step("the person changes the model once and one coarse feature event appears", async () => {
    await user.click({ label: "Change model" });
    await user.type({ label: "Search all models" }, "Second fixture model");
    await user.click({ text: /^Second fixture model$/ });
    const events = await world.events();
    const changes = events.filter(event => event.name === "analytics.model_changed");
    expect(changes).toHaveLength(1);
    expect(properties(changes[0]?.data)).toMatchObject({ to_provider_id: "analytics-fixture", to_model_id: "second", mid_session: false });
    evidence.recordAssertionEvidence("One model selection produces one feature event", "1 model_changed event; only provider/model identifiers and a mid-session boolean", changes.length === 1);
    await user.screenshot();
  });

  await step("after: the first message finishes with run quality but no message content in telemetry", async () => {
    await user.type("composer", "Say hello");
    await user.click("Run task");
    await user.see({ text: /^Say hello$/ });
    const events = await probe.eventually(() => world.events(), {
      within: 120_000, label: "the first run completes with analytics",
      until: events => events.some(event => event.name === "analytics.task_run_completed"),
    });
    expect(events.filter(event => event.name === "analytics.task_message_sent")).toHaveLength(1);
    expect(events.filter(event => event.name === "analytics.task_run_completed")).toHaveLength(1);
    expect(events.some(event => event.name === "analytics.onboarding_composer_submitted")).toBe(true);
    expect(events.some(event => event.name === "analytics.onboarding_model_resolved")).toBe(true);
    expect(events.some(event => event.name === "analytics.onboarding_reply_received")).toBe(true);
    const completed = properties(events.find(event => event.name === "analytics.task_run_completed")?.data);
    expect(completed).toMatchObject({ is_first_run_on_install: true, tool_call_count: 0, permission_prompt_count: 0, signed_in: false });
    expect(completed.duration_ms).toBeGreaterThanOrEqual(0);
    expect(completed.time_to_first_output_ms).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(events)).not.toContain("Say hello");
    evidence.recordAssertionEvidence("First-run quality is recorded without private content", `1 sent and 1 completed event; duration ${completed.duration_ms} ms; first output ${completed.time_to_first_output_ms} ms; tools 0; prompts 0; first run true; message content absent`, completed.is_first_run_on_install === true && !JSON.stringify(events).includes("Say hello"));
    await user.screenshot();
  });
});

test("a new person creates a workspace without sending its folder path to analytics", async ({ world, user, agent, probe, step, evidence }) => {
  await step("before: the new person has not created another workspace", async () => {
    await user.see("composer", { editable: true });
    const events = await world.events();
    const count = events.filter(event => event.name === "analytics.onboarding_workspace_started").length;
    expect(count).toBe(0);
    evidence.recordAssertionEvidence("No workspace action is invented at startup", `${count} workspace-started events before creation`, count === 0);
  });
  await step("the person creates a workspace through the app's control action", async () => {
    await agent.run("workspace.create", { path: world.additionalWorkspacePath });
    await user.see("composer", { editable: true });
    const events = await probe.eventually(() => world.events(), {
      within: 30_000, label: "workspace creation is recorded",
      until: events => events.some(event => event.name === "analytics.workspace_created"),
    });
    const started = events.filter(event => event.name === "analytics.onboarding_workspace_started");
    expect(started).toHaveLength(1);
    expect(properties(started[0]?.data)).toMatchObject({ choice: "folder" });
    evidence.recordAssertionEvidence("One workspace creation records one onboarding action", `${started.length} workspace-started event and a workspace-created event`, started.length === 1);
    await user.screenshot();
  });
  await step("after: the new workspace is usable and its folder stays out of telemetry", async () => {
    await user.see("composer", { editable: true });
    const events = await world.events();
    const safe = !JSON.stringify(events).includes(world.additionalWorkspacePath);
    expect(safe).toBe(true);
    evidence.recordAssertionEvidence("The folder path stays on the device", `Workspace composer editable; folder path present in analytics: ${!safe}`, safe);
  });
});
