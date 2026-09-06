import { clickButton, coworker, evalIn, fill, needs, screenshot, test, waitFor } from "@openwork/testkit";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, onTestFinished } from "vitest";
import { allHandsModel } from "../packages/labs/src/mock-all-hands-model.ts";
const enabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
type App = Awaited<ReturnType<typeof coworker>>;
async function invoke(app: App, command: string, payload: unknown = null) {
  const result = await evalIn(app, `window.__COWORKER__.invoke(${JSON.stringify(command)}, ${JSON.stringify(payload)})`, { awaitPromise: true, timeoutMs: 120_000 });
  if (typeof result !== "object" || result === null || !("ok" in result) || result.ok !== true || !("result" in result)) throw new Error(`Bridge failed: ${command}`);
  return result.result;
}
async function setting(app: App, name: string) {
  return evalIn(app, `(async () => (await window.__COWORKER__.invoke("allHands.get")).result[${JSON.stringify(name)}])()`, { awaitPromise: true });
}
async function openSettings(app: App) {
  await evalIn(app, `document.querySelector('button[title="OpenWork account and settings"]').click(); true`);
  await clickButton(app, "All Hands");
  await waitFor(app, `Boolean(document.querySelector('[aria-label="Enable All Hands"]'))`, { label: "All Hands preferences" });
}

test.skipIf(!enabled)("All Hands is optional, chats with coworkers, remembers focus, and keeps history when disabled", { timeout: 900_000 }, async ({ evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"], commands: ["opencode"] });
  await using model = await allHandsModel();
  // Native engines walk parent folders for configuration. A profile inside
  // the checkout inherits development plugins rather than a person's setup.
  const profileDir = await mkdtemp(path.join(os.tmpdir(), "open-coworker-all-hands-profile-"));
  onTestFinished(() => rm(profileDir, { recursive: true, force: true }));
  await using app = await coworker({ name: "all-hands", profileDir });
  await waitFor(app, `(document.body?.innerText ?? "").toLowerCase().includes("welcome to open coworker")`, { timeoutMs: 120_000, label: "welcome" });
  for (const name of ["Scout", "Editor"]) await invoke(app, "coworkers.create", { name, role: name === "Scout" ? "Research partner" : "Writing partner", mission: "Help the team review the launch.", avatarColor: "blue", avatarGlasses: "round" });
  const runtime = await invoke(app, "runtime.info");
  if (typeof runtime !== "object" || runtime === null || !("serverUrl" in runtime) || !("ownerToken" in runtime)) throw new Error("Runtime unavailable");
  for (const slug of ["scout", "editor", "coordinator"]) {
    const workspace = await invoke(app, slug === "coordinator" ? "coordinator.ensure" : "coworkers.ensureWorkspace", { slug });
    if (typeof workspace !== "object" || workspace === null || !("workspaceId" in workspace)) throw new Error("Workspace unavailable");
    const base = `${runtime.serverUrl}/workspace/${workspace.workspaceId}`;
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${runtime.ownerToken}` };
    expect((await fetch(`${base}/config`, { method: "PATCH", headers, body: JSON.stringify({ opencode: { enabled_providers: ["eval-team"], provider: { "eval-team": { npm: "@ai-sdk/openai-compatible", name: "Team fixture", options: { baseURL: model.baseUrl, apiKey: "eval-key" }, models: { team: { name: "Team", tool_call: true } } } } } }) })).status).toBe(200);
    expect((await fetch(`${base}/engine/reload`, { method: "POST", headers })).status).toBe(200);
    if (slug !== "coordinator") await invoke(app, "coworkers.update", { slug, patch: { model: "eval-team/team" } });
  }
  await evalIn(app, "location.reload(); true");
  await waitFor(app, `Boolean(document.querySelector('[data-testid="coworker-rail"]'))`, { timeoutMs: 240_000, label: "team ready" });
  expect(await setting(app, "enabled")).toBe(false);
  expect(await evalIn(app, `document.querySelectorAll('[data-testid="group-rail-row"][aria-label="All Hands"]').length`)).toBe(0);
  expect(model.prompts).toHaveLength(0);
  await openSettings(app);
  await evalIn(app, `document.querySelector('[aria-label="Enable All Hands"]').click(); true`);
  await waitFor(app, `document.querySelector('[aria-label="Enable All Hands"]')?.checked === true`, { label: "enabled" });
  await fill(app, '[aria-label="All Hands focus"]', "Launch readiness");
  await clickButton(app, "Save focus");
  await evalIn(app, `document.querySelector('[aria-label="Close settings"]').click(); true`);
  await waitFor(app, `Boolean(document.querySelector('[data-testid="group-rail-row"][aria-label="All Hands"]'))`, { label: "All Hands navigation" });
  await evalIn(app, `document.querySelector('[data-testid="group-rail-row"][aria-label="All Hands"]').click(); true`);
  await waitFor(app, `document.querySelector('[data-testid="all-hands-space"]')?.getAttribute("data-active") === "true"`, { label: "team space" });
  expect(await evalIn(app, `document.querySelector('[data-testid="all-hands-current-focus"]')?.textContent`)).toBe("Launch readiness");
  await fill(app, '[data-testid="group-composer"]', "@Scout What should we review first?");
  await evalIn(app, `document.querySelector('[data-testid="group-send"]').click(); true`);
  await waitFor(app, `document.querySelector('[data-message-role="assistant"][data-speaker="scout"]')?.textContent?.includes("customer blockers")`, { timeoutMs: 240_000, label: "coworker reply in All Hands" });
  await waitFor(app, `document.querySelector('[data-testid="group-chat"]')?.getAttribute("data-live") === "false"`, { timeoutMs: 120_000, label: "reply settled" });
  expect(model.prompts.some((prompt) => prompt.includes("Launch readiness"))).toBe(true);
  expect(await evalIn(app, `document.querySelectorAll('[data-message-role="assistant"][data-speaker="editor"]').length`)).toBe(0);
  await fill(app, '[data-testid="group-composer"]', "Focus on customer blockers");
  await evalIn(app, `document.querySelector('[data-testid="group-send"]').click(); true`);
  await waitFor(app, `document.querySelector('[data-testid="all-hands-current-focus"]')?.textContent === "customer blockers"`, { label: "focus remembered from chat" });
  await waitFor(app, `document.querySelectorAll('[data-message-role="user"]').length >= 2 && document.querySelector('[data-testid="group-chat"]')?.getAttribute("data-live") === "false"`, { timeoutMs: 240_000, label: "focus discussion settled" });
  const groupId = await setting(app, "groupId");
  expect(await evalIn(app, `(async () => (await window.__COWORKER__.invoke("groups.get", { id: ${JSON.stringify(groupId)} })).result.turns.at(-1)?.status)()`, { awaitPromise: true })).toBe("succeeded");
  await evalIn(app, "location.reload(); true");
  await waitFor(app, `Boolean(document.querySelector('[data-testid="group-rail-row"][aria-label="All Hands"]'))`, { timeoutMs: 120_000, label: "saved All Hands" });
  expect(await setting(app, "groupId")).toBe(groupId);
  expect(await setting(app, "focus")).toBe("customer blockers");
  await evalIn(app, `document.querySelector('[data-testid="group-rail-row"][aria-label="All Hands"]').click(); true`);
  await waitFor(app, `document.querySelector('[data-testid="group-chat"]')?.textContent?.includes("What should we review first?")`, { label: "conversation survives reload" });
  await waitFor(app, `document.querySelector('[data-testid="group-rail-row"][aria-label="All Hands"]')?.getAttribute("data-active") === "true" && document.querySelector('[data-testid="all-hands-space"]')?.getAttribute("data-active") === "true"`, { label: "All Hands selected in group chats" });
  await evalIn(app, "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))", { awaitPromise: true });
  await screenshot(app);
  await clickButton(app, "Gather the team");
  await waitFor(app, `document.querySelectorAll('[data-message-role="user"]').length >= 3 && document.querySelector('[data-testid="group-chat"]')?.getAttribute("data-live") === "false"`, { timeoutMs: 240_000, label: "manual briefing settled" });
  expect(await evalIn(app, `(async () => (await window.__COWORKER__.invoke("groups.get", { id: ${JSON.stringify(groupId)} })).result.turns.at(-1)?.status)()`, { awaitPromise: true })).toBe("succeeded");
  // Configure a real future slot through the product boundary, then leave the room.
  // The scheduled turn must arrive without clicking Gather or revisiting All Hands.
  const nextTime = String(await evalIn(app, `(() => { const at = new Date(Date.now() + 65_000); return String(at.getHours()).padStart(2, "0") + ":" + String(at.getMinutes()).padStart(2, "0"); })()`));
  await invoke(app, "allHands.update", { frequency: "morning", morning: nextTime });
  await evalIn(app, `document.querySelector('[data-testid="all-hands-source"]').click(); true`);
  // Use the source card to leave All Hands; it opens the coworker's actual conversation.
  await waitFor(app, `document.querySelector('[data-testid="all-hands-space"]')?.getAttribute("data-active") === "false"`, { label: "another conversation remains active" });
  await waitFor(app, `(async () => { const group = (await window.__COWORKER__.invoke("groups.get", { id: ${JSON.stringify(groupId)} })).result; return group.turns.some(turn => turn.clientMessageId.startsWith("all-hands:") && turn.status === "succeeded"); })()`, { awaitPromise: true, timeoutMs: 180_000, label: "scheduled briefing completed in background" }).catch(async (error) => {
    const [group, status, activity] = await Promise.all([invoke(app, "groups.get", { id: groupId }), invoke(app, "groups.status", { id: groupId }), invoke(app, "groups.activity", { id: groupId })]);
    throw new Error(`${String(error)}\nGroup state: ${JSON.stringify({ group, status, activity })}\nFixture prompts: ${JSON.stringify(model.prompts.map((prompt) => prompt.slice(0, 250)))}`);
  });
  expect(await evalIn(app, `document.querySelector('[data-testid="all-hands-space"]')?.getAttribute("data-active")`)).toBe("false");
  const occurrence = await setting(app, "lastOccurrence");
  expect(occurrence).not.toBe("");
  await evalIn(app, "location.reload(); true");
  await waitFor(app, `Boolean(document.querySelector('[data-testid="group-rail-row"][aria-label="All Hands"]'))`, { timeoutMs: 120_000, label: "reopened after scheduled briefing" });
  expect(await invoke(app, "allHands.claim")).toBe(null);
  expect(await setting(app, "lastOccurrence")).toBe(occurrence);
  await invoke(app, "allHands.update", { frequency: "manual" });
  expect(await invoke(app, "allHands.claim")).toBe(null);
  evidence.recordAssertionEvidence("Manual and automatic briefings share one conversation", "Gather the team produced a saved turn. A real future local-time slot completed while the person was in another conversation without stealing navigation, and reopening did not claim that slot again. Manual mode returned no scheduled work.", true);
  await openSettings(app);
  await evalIn(app, `document.querySelector('[aria-label="Enable All Hands"]').click(); true`);
  await waitFor(app, `!document.querySelector('[data-testid="group-rail-row"][aria-label="All Hands"]')`, { label: "disabled space hidden" });
  expect(await setting(app, "enabled")).toBe(false);
  expect(await setting(app, "groupId")).toBe(groupId);
  expect(await invoke(app, "allHands.claim")).toBe(null);
  evidence.recordAssertionEvidence("All Hands opt-in, real chat, customization and persistence", "The packaged app hid All Hands by default without model requests, enabled it from Settings, delivered a named Scout reply through the model witness, saved focus from chat, retained the conversation across reload, and hid the space without deleting its identity when disabled.", true);
});
