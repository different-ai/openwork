import { expect } from "vitest";
import { go } from "@openwork/behaviors";
import { observeTranscript, spec, type Probe, type Target, type User } from "@openwork/testkit";
import { workspaceEngineUpgrade } from "../worlds/chat.ts";

// Fresh-engine chat journeys cannot witness ownership after an upgrade.
const test = spec.world(workspaceEngineUpgrade, { timeout: 600_000 });
const reply = "Hello. Your upgrade conversation is working.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function routeSessionId(hash: string): string | null {
  return /\/session\/(ses_[^/?#]+)/.exec(hash)?.[1] ?? null;
}

/**
 * The sidebar New session controls open the workspace's empty composer at once
 * (#4577); the session itself is created by the first send. "Opened" is the
 * empty New task route with no session surface and a prompt-ready composer.
 */
async function openEmptyNewTask(user: User, probe: Probe, workspaceId: string, control: Target) {
  await user.click(control);
  await probe.eventually(async () => ({
    hash: await probe.hash(),
    surface: await probe.eval(() => document.querySelector("[data-session-surface-id]") !== null),
  }), {
    within: 30_000, label: `empty New task route for ${workspaceId} without a session surface`,
    until: ({ hash, surface }) => new RegExp(`/workspace/${workspaceId}/session/?$`).test(hash) && surface === false,
  });
  await user.see("composer", { timeoutMs: 30_000 });
  await user.see("Run task", { timeoutMs: 30_000 });
}

/**
 * Sends "hi", then returns the session the send landed in. It must be one no
 * earlier turn of this journey used, so an empty composer that reused an old
 * session (or a palette chat that never navigated) fails here.
 */
async function greet(user: User, probe: Probe, usedSessionIds: Set<string>): Promise<string> {
  await using transcript = await observeTranscript(probe, [
    { role: "user", text: "hi" }, { role: "assistant", text: reply },
  ]);
  await user.type("composer", "hi");
  await user.click("Run task");
  // Observe the user row itself: text left in the composer cannot satisfy this.
  await probe.eventually(() => transcript.read(), {
    within: 2_000, label: "sent hi visible in the user transcript",
    until: (state) => isRecord(state) && Array.isArray(state.seen) && state.seen[0] === true,
  });
  const route = await probe.eventually(() => probe.hash(), {
    within: 30_000, label: "the send lands on a session route",
    until: (hash) => routeSessionId(hash) !== null,
  });
  const sessionId = routeSessionId(route);
  if (!sessionId) throw new Error(`Session route omitted its ID: ${route}`);
  expect(usedSessionIds.has(sessionId), `send landed in a distinct new session (${sessionId})`).toBe(false);
  usedSessionIds.add(sessionId);
  await user.screenshot();
  await user.see({ text: reply }, { timeoutMs: 90_000 });
  await user.see("Run task", { timeoutMs: 30_000 });
  expect(await transcript.finish()).toMatchObject({ seen: [true, true], violations: [], stopped: false });
  await user.reload();
  await user.see({ text: /^hi$/ }, { timeoutMs: 30_000 });
  await user.see({ text: reply });
  return sessionId;
}

test("existing workspaces create usable sessions after changing chat engines", async ({ world, user, probe, step }) => {
  const usedSessionIds = new Set([world.original.sessionId, world.otherOriginal.sessionId]);
  const macPlatform = await probe.eval(() => (/Mac|iPhone|iPad|iPod/.test(navigator.platform)));
  const paletteShortcut = macPlatform ? "Meta+K" : "Control+K";
  const createPaletteChat = async () => {
    const previousRoute = await probe.hash();
    const paletteInput = { placeholder: "Search actions, settings, and sessions…" };
    await user.press(paletteShortcut);
    await user.see(paletteInput);
    await user.type(paletteInput, "New session", { replace: true });
    await user.click({ role: "option", label: /^New session\b/ });
    await probe.eventually(() => probe.hash(), {
      within: 30_000, label: "palette opens a new chat in the selected workspace",
      until: (hash) => hash !== previousRoute && hash.includes(`/workspace/${world.primary.workspaceId}/session/ses_`),
    });
    await user.notSee(paletteInput);
    await user.see("Run task", { timeoutMs: 30_000 });
    await user.notSee({ text: /SessionNotFoundError|Session not found|Session could not be loaded/ });
    await greet(user, probe, usedSessionIds);
  };

  expect((await probe.desktopApi("/experimental/engine-v2-preview/status")).body).toMatchObject({ chatRouting: false });
  await go(world.app, `/workspace/${world.primary.workspaceId}/settings/advanced`);
  await user.see({ text: "OpenCode v2 (preview)" }, { timeoutMs: 30_000 });
  await user.click({ text: "OpenCode v2 (preview)" });
  await probe.eventually(() => probe.desktopApi("/experimental/engine-v2-preview/status"), {
    within: 120_000, label: "v2 configured and running",
    until: (response) => isRecord(response.body) && response.body.running === true && response.body.chatRouting === true,
  });
  await step("the Settings command palette creates a usable chat after enabling v2", createPaletteChat);
  await go(world.app, `/workspace/${world.primary.workspaceId}/session`);
  await user.reload();
  await user.see("composer", { timeoutMs: 60_000 });

  await step("a new chat in the selected existing workspace keeps the first message visible", async () => {
    await openEmptyNewTask(user, probe, world.primary.workspaceId, { role: "button", label: "New session" });
    await greet(user, probe, usedSessionIds);
  });

  await step("the chat command palette creates another usable v2 chat", createPaletteChat);

  await step("a sidebar new session opens and runs in the configured engine", async () => {
    if (!world.otherName) throw new Error("Existing workspace name missing");
    await user.hover({ role: "button", label: world.otherName });
    await openEmptyNewTask(user, probe, world.other.workspaceId, { role: "button", label: `New session · ${world.otherName}` });
    await user.notSee({ text: /SessionNotFoundError|Session not found|Session could not be loaded/ });
    const sessionId = await greet(user, probe, usedSessionIds);
    expect(await probe.hash()).toContain(`/workspace/${world.other.workspaceId}/session/${sessionId}`);
    const prefix = `/workspace/${world.other.workspaceId}`;
    expect((await probe.desktopApi(`${prefix}/opencode2/api/session/${sessionId}`)).status).toBe(200);
    expect((await probe.desktopApi(`${prefix}/opencode/session/${sessionId}`)).status).toBe(404);
    await user.notSee({ text: /SessionNotFoundError|Session not found|Session could not be loaded/ });
  });

  await step("switching back preserves v1 history and v1 can still create and run a chat", async () => {
    await go(world.app, `/workspace/${world.primary.workspaceId}/settings/advanced`);
    await user.click({ text: "OpenCode v1 (default)" });
    await probe.eventually(() => probe.desktopApi("/experimental/engine-v2-preview/status"), {
      within: 60_000, label: "v1 routing restored",
      until: (response) => isRecord(response.body) && response.body.enabled === false && response.body.chatRouting === false,
    });
    await go(world.app, `/workspace/${world.primary.workspaceId}/session/${world.original.sessionId}`);
    await user.see({ text: world.original.title }, { timeoutMs: 30_000 });
    expect((await probe.desktopApi(`/workspace/${world.other.workspaceId}/opencode/session/${world.otherOriginal.sessionId}`)).status).toBe(200);
    await user.notSee({ text: /SessionNotFoundError|Session not found|Session could not be loaded/ });
    await openEmptyNewTask(user, probe, world.primary.workspaceId, { role: "button", label: "New session" });
    const sessionId = await greet(user, probe, usedSessionIds);
    expect((await probe.desktopApi(`/workspace/${world.primary.workspaceId}/opencode/session/${sessionId}`)).status).toBe(200);
  });

  await step("the chat command palette still creates a usable chat after returning to v1", createPaletteChat);
  await go(world.app, `/workspace/${world.primary.workspaceId}/settings/advanced`);
  await user.see({ text: "OpenCode v1 (default)" }, { timeoutMs: 30_000 });
  await step("the Settings command palette still creates a usable v1 chat", createPaletteChat);
});
