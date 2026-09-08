import { browserScript, clickButton, coworker, evalIn, fill, needs, screenshot, test, waitFor } from "@openwork/testkit";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, onTestFinished } from "vitest";
import { allHandsModel } from "../packages/labs/src/mock-all-hands-model.ts";
const enabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
type App = Awaited<ReturnType<typeof coworker>>;
declare global {
  interface Window {
    __COWORKER__: { invoke(command: string, payload?: unknown): Promise<{ ok: boolean; result?: unknown; error?: string }> };
  }
}

async function invoke(app: App, command: string, payload: unknown = null) {
  const result = await evalIn(app, browserScript((command, payload) => window.__COWORKER__.invoke(command, payload), [command, payload]), { timeoutMs: 120_000 });
  if (typeof result !== "object" || result === null || !("ok" in result) || result.ok !== true || !("result" in result)) throw new Error(`Bridge failed: ${command}`);
  return result.result;
}
async function setting(app: App, name: string): Promise<unknown> {
  const settings = await invoke(app, "allHands.get");
  if (typeof settings !== "object" || settings === null || !(name in settings)) throw new Error(`Missing All Hands setting: ${name}`);
  return Reflect.get(settings, name);
}
async function click(app: App, selector: string) {
  await evalIn(app, browserScript((selector) => {
    const button = document.querySelector(selector);
    if (!(button instanceof HTMLElement)) throw new Error(`Missing control: ${selector}`);
    button.click();
  }, [selector]));
}
async function pressKey(app: App, key: string, held = false) {
  const code = key.length === 1 ? `Key${key.toUpperCase()}` : key;
  await app.client.send("Input.dispatchKeyEvent", { type: "keyDown", key, code });
  if (held) await app.client.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, autoRepeat: true });
  await app.client.send("Input.dispatchKeyEvent", { type: "keyUp", key, code });
}
async function assignmentFeedback(app: App) {
  // Observe the next paint only. No retry, engine read, focus(), click helper,
  // or scrolling can make an initially hidden/unfocused chooser pass.
  return evalIn(app, async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const card = document.querySelector('[data-testid="group-assignment-owner"]');
    const choice = document.querySelector('[data-testid="group-assignment-choice"]');
    const bounds = card?.getBoundingClientRect();
    let top = 0, bottom = innerHeight, left = 0, right = innerWidth;
    for (let parent = card?.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      const rect = parent.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) { top = Math.max(top, rect.top); bottom = Math.min(bottom, rect.bottom); }
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) { left = Math.max(left, rect.left); right = Math.min(right, rect.right); }
    }
    return {
      present: Boolean(card),
      visible: Boolean(bounds && bounds.height > 0 && bounds.width > 0 && bounds.top >= top - 1 && bounds.bottom <= bottom + 1 && bounds.left >= left - 1 && bounds.right <= right + 1),
      focused: Boolean(choice?.contains(document.activeElement)),
      composerFocused: document.activeElement === document.querySelector('[data-testid="group-composer"]'),
    };
  }, { timeoutMs: 2_000, reattachAttempts: 0 });
}
async function openSettings(app: App) {
  await click(app, 'button[title="OpenWork account and settings"]');
  await clickButton(app, "All Hands");
  await waitFor(app, () => Boolean(document.querySelector('[aria-label="Enable All Hands"]')), { label: "All Hands preferences" });
}

test.skipIf(!enabled)("All Hands is optional, chats with coworkers, remembers focus, and keeps history when disabled", { timeout: 900_000 }, async ({ evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"], commands: ["opencode"] });
  await using model = await allHandsModel();
  // Native engines walk parent folders for configuration. A profile inside
  // the checkout inherits development plugins rather than a person's setup.
  const profileDir = await mkdtemp(path.join(os.tmpdir(), "open-coworker-all-hands-profile-"));
  onTestFinished(() => rm(profileDir, { recursive: true, force: true }));
  const provider = { "eval-team": { npm: "@ai-sdk/openai-compatible", name: "Team fixture", options: { baseURL: model.baseUrl, apiKey: "eval-key" }, models: { team: { name: "Team", tool_call: true } } } };
  // Seed the native allowlist before the engine's first config read. Runtime
  // workspace patches cannot stand in for engine-global provider restrictions.
  await using app = await coworker({ name: "all-hands", profileDir, env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ enabled_providers: ["eval-team"], provider }) } });
  await waitFor(app, () => (document.body?.innerText ?? "").toLowerCase().includes("welcome to open coworker"), { timeoutMs: 120_000, label: "welcome" });
  for (const name of ["Scout", "Editor"]) await invoke(app, "coworkers.create", { name, role: name === "Scout" ? "Research partner" : "Writing partner", mission: "Help the team review the launch.", avatarColor: "blue", avatarGlasses: "round" });
  const runtime = await invoke(app, "runtime.info");
  if (typeof runtime !== "object" || runtime === null || !("serverUrl" in runtime) || typeof runtime.serverUrl !== "string" || !("ownerToken" in runtime) || typeof runtime.ownerToken !== "string") throw new Error("Runtime unavailable");
  const workspaces = new Map<string, string>();
  for (const slug of ["scout", "editor", "coordinator"]) {
    const workspace = await invoke(app, slug === "coordinator" ? "coordinator.ensure" : "coworkers.ensureWorkspace", { slug });
    if (typeof workspace !== "object" || workspace === null || !("workspaceId" in workspace) || typeof workspace.workspaceId !== "string") throw new Error("Workspace unavailable");
    const base = `${runtime.serverUrl}/workspace/${workspace.workspaceId}`;
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${runtime.ownerToken}` };
    const connected: unknown = await (await fetch(`${base}/opencode/provider`, { headers })).json();
    expect(connected).toMatchObject({ connected: ["eval-team"] });
    if (slug !== "coordinator") {
      workspaces.set(slug, workspace.workspaceId);
      await invoke(app, "coworkers.update", { slug, patch: { model: "eval-team/team" } });
    }
  }
  const teamSessions = async () => Promise.all([...workspaces].map(async ([slug, workspaceId]) => {
    const response = await fetch(`${runtime.serverUrl}/workspace/${encodeURIComponent(workspaceId)}/opencode/session`, { headers: { Authorization: `Bearer ${runtime.ownerToken}` }, signal: AbortSignal.timeout(10_000) });
    expect(response.ok).toBe(true);
    const sessions: unknown = await response.json();
    if (!Array.isArray(sessions)) throw new Error("Native sessions unavailable");
    return { slug, ids: sessions.map((session: unknown) => {
      if (typeof session !== "object" || session === null || !("id" in session) || typeof session.id !== "string") throw new Error("Native session id unavailable");
      return session.id;
    }).sort() };
  }));
  await evalIn(app, () => { location.reload(); });
  await waitFor(app, () => Boolean(document.querySelector('[data-testid="coworker-rail"]')), { timeoutMs: 240_000, label: "team ready" });
  expect(await setting(app, "enabled")).toBe(false);
  expect(await evalIn(app, () => document.querySelectorAll('[data-testid="group-rail-row"][aria-label="All Hands"]').length)).toBe(0);
  expect(model.prompts).toHaveLength(0);
  await invoke(app, "allHands.update", { frequency: "manual" });
  await openSettings(app);
  await click(app, '[aria-label="Enable All Hands"]');
  await waitFor(app, () => document.querySelector<HTMLInputElement>('[aria-label="Enable All Hands"]')?.checked === true, { label: "enabled" });
  await fill(app, '[aria-label="All Hands focus"]', "Launch readiness");
  await clickButton(app, "Save focus");
  await click(app, '[aria-label="Close settings"]');
  await waitFor(app, () => Boolean(document.querySelector('[data-testid="group-rail-row"][aria-label="All Hands"]')), { label: "All Hands navigation" });
  await click(app, '[data-testid="group-rail-row"][aria-label="All Hands"]');
  await waitFor(app, () => document.querySelector('[data-testid="all-hands-space"]')?.getAttribute("data-active") === "true", { label: "team space" });
  await invoke(app, "groups.update", { id: await setting(app, "groupId"), patch: { facilitatorModel: "eval-team/team" } });
  expect(await evalIn(app, () => document.querySelector('[data-testid="all-hands-current-focus"]')?.textContent)).toBe("Launch readiness");
  await fill(app, '[data-testid="group-composer"]', "@Scout What should we review first?");
  await click(app, '[data-testid="group-send"]');
  await waitFor(app, () => document.querySelector('[data-message-role="assistant"][data-speaker="scout"]')?.textContent?.includes("customer blockers"), { timeoutMs: 240_000, label: "coworker reply in All Hands" });
  await waitFor(app, () => document.querySelector('[data-testid="group-chat"]')?.getAttribute("data-live") === "false", { timeoutMs: 120_000, label: "reply settled" });
  expect(model.prompts.some((prompt) => prompt.includes("Launch readiness"))).toBe(true);
  expect(await evalIn(app, () => document.querySelectorAll('[data-message-role="assistant"][data-speaker="editor"]').length)).toBe(0);
  await fill(app, '[data-testid="group-composer"]', "Focus on customer blockers");
  await click(app, '[data-testid="group-send"]');
  await waitFor(app, () => document.querySelector('[data-testid="all-hands-current-focus"]')?.textContent === "customer blockers", { label: "focus remembered from chat" });
  await waitFor(app, () => document.querySelectorAll('[data-message-role="user"]').length >= 2 && document.querySelector('[data-testid="group-chat"]')?.getAttribute("data-live") === "false", { timeoutMs: 240_000, label: "focus discussion settled" });
  const groupId = await setting(app, "groupId");
  if (typeof groupId !== "string") throw new Error("All Hands group id unavailable");
  expect(await invoke(app, "groups.get", { id: groupId })).toMatchObject({ turns: expect.arrayContaining([expect.objectContaining({ prompt: "Focus on customer blockers", status: "succeeded" })]) });
  await evalIn(app, () => { location.reload(); });
  await waitFor(app, () => Boolean(document.querySelector('[data-testid="group-rail-row"][aria-label="All Hands"]')), { timeoutMs: 120_000, label: "saved All Hands" });
  expect(await setting(app, "groupId")).toBe(groupId);
  expect(await setting(app, "focus")).toBe("customer blockers");
  await click(app, '[data-testid="group-rail-row"][aria-label="All Hands"]');
  await waitFor(app, () => document.querySelector('[data-testid="group-chat"]')?.textContent?.includes("What should we review first?"), { label: "conversation survives reload" });
  await waitFor(app, () => document.querySelector('[data-testid="group-rail-row"][aria-label="All Hands"]')?.getAttribute("data-active") === "true" && document.querySelector('[data-testid="all-hands-space"]')?.getAttribute("data-active") === "true", { label: "All Hands selected in group chats" });
  await evalIn(app, () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await screenshot(app);

  // Real saved history creates overflow; the test never scrolls to the chooser.
  for (let index = 0; index < 24; index++) await invoke(app, "groups.appendEvent", { id: groupId, event: { kind: "status", text: `Earlier team update ${index + 1}: the review remains read-only.` } });
  await waitFor(app, () => [...document.querySelectorAll('[data-testid="group-status"]')].some((line) => line.textContent?.includes("Earlier team update 24:")), { label: "overflowing saved group history" });
  expect(await evalIn(app, () => {
    for (let node = document.querySelector('[data-testid="group-status"]')?.parentElement; node; node = node.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(node).overflowY)) return node.scrollHeight > node.clientHeight;
    }
    return false;
  })).toBe(true);
  const sessionsBeforeAssignment = await teamSessions();
  const promptsBeforeAssignment = model.prompts.length;
  const outcome = "Research sources for the release note.";
  await click(app, '[data-testid="group-assignment-toggle"]');
  await fill(app, '[data-testid="group-composer"]', outcome);
  await pressKey(app, "Enter", true);
  expect(await assignmentFeedback(app)).toEqual({ present: true, visible: true, focused: true, composerFocused: false });
  expect(model.prompts).toHaveLength(promptsBeforeAssignment);
  expect(await teamSessions()).toEqual(sessionsBeforeAssignment);
  await pressKey(app, "Escape");
  expect(await assignmentFeedback(app)).toMatchObject({ present: false, composerFocused: true });
  expect(await teamSessions()).toEqual(sessionsBeforeAssignment);
  expect(model.prompts).toHaveLength(promptsBeforeAssignment);
  await pressKey(app, "Enter");
  const ownerChoice = await evalIn(app, () => {
    const options = [...document.querySelectorAll('[data-testid="group-assignment-owner"] [data-testid="interaction-option"]')];
    const editor = options.find((option) => option.textContent?.includes("Editor"));
    return { suggested: options.find((option) => option.getAttribute("aria-selected") === "true")?.textContent, editorSuggested: editor?.getAttribute("aria-selected"), letter: editor?.getAttribute("data-letter") };
  });
  expect(ownerChoice.suggested).toContain("Scout");
  expect(ownerChoice.editorSuggested).toBe("false");
  if (!ownerChoice.letter) throw new Error("Editor's owner shortcut unavailable");
  await pressKey(app, ownerChoice.letter, true);
  const assignmentThread = await waitFor(app, browserScript((outcome) => {
    const action = [...document.querySelectorAll('[data-testid="group-action-line"][data-action="assignment"]')].find((line) => line.textContent?.includes(outcome));
    return action?.getAttribute("data-speaker") === "editor" && action.getAttribute("data-thread-id");
  }, [outcome]), { timeoutMs: 30_000, label: "explicitly chosen Editor owns the assignment" });
  expect(typeof assignmentThread).toBe("string");
  expect(await teamSessions()).toEqual(sessionsBeforeAssignment.map((entry) => ({ ...entry, ids: entry.slug === "editor" ? [...entry.ids, assignmentThread].sort() : entry.ids })));
  expect(await invoke(app, "groups.readTimeline", { id: groupId })).toEqual(expect.arrayContaining([expect.objectContaining({ action: "assignment", slug: "editor", threadId: assignmentThread, title: outcome })]));
  expect(await evalIn(app, () => document.querySelectorAll('[data-testid="group-action-line"][data-action="assignment"]').length)).toBe(1);
  evidence.recordAssertionEvidence("Assignment choice is immediate and explicit", "With overflowing saved history, Enter revealed and focused the owner card by the next paint without inference or a native session. Escape created nothing. Choosing Editor instead of suggested Scout, including a held-key repeat, created exactly one Editor session and one saved assignment action, leaving Scout unchanged.", true);
  await clickButton(app, "Gather the team");
  await waitFor(app, () => document.querySelectorAll('[data-message-role="user"]').length >= 3 && document.querySelector('[data-testid="group-chat"]')?.getAttribute("data-live") === "false", { timeoutMs: 240_000, label: "manual briefing settled" });
  expect(await invoke(app, "groups.get", { id: groupId })).toMatchObject({ turns: expect.arrayContaining([expect.objectContaining({ prompt: expect.stringContaining("Give us a read-only All Hands briefing"), status: "succeeded" })]) });
  // Configure a real future slot through the product boundary, then leave the room.
  // The scheduled turn must arrive without clicking Gather or revisiting All Hands.
  const nextTime = await evalIn(app, () => { const at = new Date(Date.now() + 65_000); return String(at.getHours()).padStart(2, "0") + ":" + String(at.getMinutes()).padStart(2, "0"); });
  await invoke(app, "allHands.update", { frequency: "morning", morning: nextTime });
  await click(app, '[data-testid="all-hands-source"]');
  // Use the source card to leave All Hands; it opens the coworker's actual conversation.
  await waitFor(app, () => document.querySelector('[data-testid="all-hands-space"]')?.getAttribute("data-active") === "false", { label: "another conversation remains active" });
  await waitFor(app, browserScript(async (groupId) => {
    const group = (await window.__COWORKER__.invoke("groups.get", { id: groupId })).result;
    if (typeof group !== "object" || group === null || !("turns" in group) || !Array.isArray(group.turns)) return false;
    return group.turns.some((turn: unknown) => typeof turn === "object" && turn !== null && "clientMessageId" in turn && typeof turn.clientMessageId === "string" && turn.clientMessageId.startsWith("all-hands:") && "status" in turn && turn.status === "succeeded");
  }, [groupId]), { timeoutMs: 180_000, label: "scheduled briefing completed in background" }).catch(async (error) => {
    const [group, status, activity] = await Promise.all([invoke(app, "groups.get", { id: groupId }), invoke(app, "groups.status", { id: groupId }), invoke(app, "groups.activity", { id: groupId })]);
    throw new Error(`${String(error)}\nGroup state: ${JSON.stringify({ group, status, activity })}\nFixture prompts: ${JSON.stringify(model.prompts.map((prompt) => prompt.slice(0, 250)))}`);
  });
  expect(await evalIn(app, () => document.querySelector('[data-testid="all-hands-space"]')?.getAttribute("data-active"))).toBe("false");
  const occurrence = await setting(app, "lastOccurrence");
  expect(occurrence).not.toBe("");
  await evalIn(app, () => { location.reload(); });
  await waitFor(app, () => Boolean(document.querySelector('[data-testid="group-rail-row"][aria-label="All Hands"]')), { timeoutMs: 120_000, label: "reopened after scheduled briefing" });
  expect(await invoke(app, "allHands.claim")).toBe(null);
  expect(await setting(app, "lastOccurrence")).toBe(occurrence);
  expect(model.prompts.some((prompt) => prompt.includes("You are the facilitator of the group chat"))).toBe(true);
  await invoke(app, "allHands.update", { frequency: "manual" });
  expect(await invoke(app, "allHands.claim")).toBe(null);
  evidence.recordAssertionEvidence("Manual and automatic briefings share one conversation", "Gather the team produced a saved turn. A real future local-time slot completed while the person was in another conversation without stealing navigation, and reopening did not claim that slot again. Manual mode returned no scheduled work.", true);
  await openSettings(app);
  await click(app, '[aria-label="Enable All Hands"]');
  await waitFor(app, () => !document.querySelector('[data-testid="group-rail-row"][aria-label="All Hands"]'), { label: "disabled space hidden" });
  expect(await setting(app, "enabled")).toBe(false);
  expect(await setting(app, "groupId")).toBe(groupId);
  expect(await invoke(app, "allHands.claim")).toBe(null);
  evidence.recordAssertionEvidence("All Hands opt-in, real chat, customization and persistence", "The packaged app hid All Hands by default without model requests, enabled it from Settings, delivered a named Scout reply through the model witness, saved focus from chat, retained the conversation across reload, and hid the space without deleting its identity when disabled.", true);
});
