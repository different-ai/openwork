import { spec } from "@openwork/testkit";
import { expect } from "vitest";
import { modelsAnalyticsWorld } from "../worlds/models-analytics.ts";

// Den exports task analytics only to public HTTPS addresses and has no private-address
// override, so the Langfuse witness must be reachable through a Daytona preview URL.
const test = spec.world(modelsAnalyticsWorld, { resources: { surfaces: ["web"], services: ["den"] }, timeout: 900_000, needs: { placement: "daytona" } });
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected an API object");
  return Object.fromEntries(Object.entries(value));
}
function list(value: unknown): Record<string, unknown>[] { return Array.isArray(value) ? value.map(record) : []; }

test("an opted-in Models organization exports only new task metadata to Langfuse and stops on opt-out", { timeout: 900_000 }, async ({ world, user, probe, evidence }) => {
  const webUser = user.on(world.web);
  const api = (path: string, init?: RequestInit) => probe.api(world.den.admin, path, {
    ...init, headers: { "x-openwork-org-id": world.orgId, "content-type": "application/json" },
  });
  await world.upgradeAnalytics();
  await world.rollout(true);
  expect((await api("/v1/inference/analytics/settings", { method: "PATCH", body: JSON.stringify({ enabled: true, consentVersion: 1 }) })).response.ok).toBe(true);
  // Activity recorded before Langfuse is connected must never be backfilled into the export.
  expect((await world.complete({ sessionId: "existing-conversation", taskId: "before-langfuse" })).status).toBe(200);
  await probe.eventually(async () => list(record((await api("/v1/inference/analytics/activity")).body).events), {
    within: 30_000, label: "pre-connection activity is recorded", until: (rows) => rows.some((row) => row.taskId === "before-langfuse"),
  });

  await webUser.navigate(`${world.den.ref.webUrl}/dashboard/analytics/models`);
  await webUser.see({ role: "tab", label: "Integrations" }, { timeoutMs: 60_000 });
  await webUser.click({ role: "tab", label: "Integrations" });
  await webUser.click({ role: "button", label: "Data region" });
  await webUser.click({ role: "option", label: "Self-hosted" });
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
  expect(serialized).not.toContain("before-langfuse");
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
  evidence.recordAssertionEvidence("The Langfuse UI verifies project access, rejects private addresses, and exports only newly collected metadata", "Private address rejected; HTTPS witness connected; new model usage arrived without prompt text, keys or activity recorded before the connection", true);
  evidence.recordAssertionEvidence("Turning off task analytics stops export while Models keeps responding", "New Models request returned 200 after disable; no extra spans arrived across a full export interval", true);
  evidence.recordAssertionEvidence("Opt-out finishes only after an already-authorized export has finished", "The Langfuse witness held an export response; the UI could not confirm opt-out until the response was released, then no later export arrived", true);
});
