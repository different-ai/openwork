import { expect } from "vitest";
import { go } from "@openwork/behaviors";
import { observeTranscript, spec, type Probe, type User } from "@openwork/testkit";
import { workspaceEngineUpgrade } from "../worlds/chat.ts";

// Fresh-engine chat journeys cannot witness ownership after an upgrade.
const test = spec.world(workspaceEngineUpgrade, { timeout: 420_000 });
const reply = "Hello. Your upgrade conversation is working.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function greet(user: User, probe: Probe) {
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
  await user.screenshot();
  await user.see({ text: reply }, { timeoutMs: 90_000 });
  await user.see("Run task", { timeoutMs: 30_000 });
  expect(await transcript.finish()).toMatchObject({ seen: [true, true], violations: [], stopped: false });
  await user.reload();
  await user.see({ text: /^hi$/ }, { timeoutMs: 30_000 });
  await user.see({ text: reply });
}

test("existing workspaces create usable sessions after changing chat engines", async ({ world, user, probe, step }) => {
  expect((await probe.desktopApi("/experimental/engine-v2-preview/status")).body).toMatchObject({ chatRouting: false });
  await go(world.app, `/workspace/${world.primary.workspaceId}/settings/advanced`);
  await user.see({ text: "OpenCode v2 (preview)" }, { timeoutMs: 30_000 });
  await user.click({ text: "OpenCode v2 (preview)" });
  await probe.eventually(() => probe.desktopApi("/experimental/engine-v2-preview/status"), {
    within: 120_000, label: "v2 configured and running",
    until: (response) => isRecord(response.body) && response.body.running === true && response.body.chatRouting === true,
  });
  await go(world.app, `/workspace/${world.primary.workspaceId}/session`);
  await user.reload();
  await user.see("composer", { timeoutMs: 60_000 });

  await step("a new chat in the selected existing workspace keeps the first message visible", async () => {
    await user.click({ role: "button", label: "New session" });
    await probe.eventually(() => probe.hash(), { within: 30_000,
      label: "new session route", until: (hash) => hash.includes("/session/ses_") });
    await user.see("composer", { timeoutMs: 30_000 });
    await greet(user, probe);
  });

  await step("a sidebar new session opens and runs in the configured engine", async () => {
    if (!world.otherName) throw new Error("Existing workspace name missing");
    await user.hover({ role: "button", label: world.otherName });
    await user.click({ role: "button", label: `New session · ${world.otherName}` });
    const route = await probe.eventually(() => probe.hash(), { within: 30_000,
      label: "other workspace new session route",
      until: (hash) => hash.includes(`/workspace/${world.other.workspaceId}/session/ses_`),
    });
    const sessionId = route.split("/session/")[1]?.split(/[?#/]/)[0];
    if (!sessionId) throw new Error("Created session route omitted its ID");
    const prefix = `/workspace/${world.other.workspaceId}`;
    expect((await probe.desktopApi(`${prefix}/opencode2/api/session/${sessionId}`)).status).toBe(200);
    expect((await probe.desktopApi(`${prefix}/opencode/session/${sessionId}`)).status).toBe(404);
    await user.notSee({ text: /SessionNotFoundError|Session not found|Session could not be loaded/ });
    await greet(user, probe);
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
    await user.click({ role: "button", label: "New session" });
    await probe.eventually(() => probe.hash(), { within: 30_000,
      label: "new v1 session route",
      until: (hash) => hash.includes("/session/ses_") && !hash.includes(world.original.sessionId),
    });
    await greet(user, probe);
  });
});
