import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { sessionHome } from "../worlds/session-home.ts";

const test = spec.world(sessionHome, {
  timeout: 240_000, resources: { surfaces: ["appWeb"], services: ["mock"] },
});

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  return Object.fromEntries(Object.entries(value));
}

function sessionInfo(value: unknown) {
  const data = record(record(value).body).data;
  const info = record(data);
  return record(info.info ?? info);
}

test("HOME-01 a working-directory move preserves the chat, Stop, draft, and next turn", async ({ world, user, agent, probe, step, evidence }) => {
  await agent.run("session.open", { sessionId: world.session.sessionId });
  await user.see("composer", { editable: true });
  const route = await probe.hash();
  const runtime = await world.runtime();
  await step("the running conversation stays in its original folder after a native move", async () => {
    await user.type("composer", world.prompt, { replace: true, verify: true });
    await user.click("Run task");
    await probe.eventually(() => world.sessionState(), { within: 60_000, label: "native session moved but home stayed fixed",
      until: value => record(sessionInfo(value).location).directory === world.destination
        && sessionInfo(value).openworkHomeDirectory === world.home });
    expect(await world.recoverUnindexedHome()).toBe(world.home);
    await user.see({ text: /sleep 120/ }, { timeoutMs: 45_000 });
    await user.type("composer", world.followup, { replace: true, verify: true });
    expect(await probe.hash()).toBe(route);
    const list = record((await world.sessions()).body).data;
    expect(Array.isArray(list) && list.some(item => record(item).id === world.session.sessionId)).toBe(true);
    await user.screenshot();
  });
  await step("Stop reaches the moved task and preserves the unsent draft", async () => {
    await user.click({ role: "button", label: "Stop" });
    await user.see("Run task", { timeoutMs: 30_000 });
    expect(record((await world.active()).body).data).toEqual({});
    expect(await probe.hash()).toBe(route);
    await user.screenshot();
  });
  await step("the preserved draft sends once and the same chat reopens after reload", async () => {
    await world.prepareFollowup();
    // No retyping: this must send the draft entered before Stop.
    await user.click("Run task");
    await user.see({ text: world.reply }, { timeoutMs: 45_000 });
    await user.see("Run task", { timeoutMs: 30_000 });
    expect((await world.requests()).filter(call => call.kind === "final")).toHaveLength(1);
    await user.reload();
    await user.see({ text: world.reply }, { timeoutMs: 30_000 });
    expect(await probe.hash()).toBe(route);
    const info = sessionInfo(await world.sessionState());
    expect(info.openworkHomeDirectory).toBe(world.home);
    expect(record(info.location).directory).toBe(world.destination);
    expect(await world.runtime()).toEqual(runtime);
    await user.screenshot();
  });
  evidence.recordAssertionEvidence("Conversation home survives a native move",
    "The real v2 code-mode session_move tool changes the working folder during a turn. The chat remains at its original route and in its original workspace list; Stop settles, the preserved draft completes once, and history reopens after reload without restarting the engine. Model decisions are synthetic.", true);
});
