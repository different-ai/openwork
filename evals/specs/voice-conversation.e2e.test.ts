import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { voiceConversation } from "../worlds/voice.ts";

const test = spec.world(voiceConversation, { needs: { commands: ["bun"] }, timeout: 600_000 });
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected witness object");
  return value;
}
function users(value: unknown) {
  if (!Array.isArray(value)) throw new Error("Expected conversation messages");
  return value.filter((message) => object(message).role === "user").map((message) => object(message).text);
}

test("voice sends and steers real conversation work, interrupts speech, cancels, reconnects without replay, and isolates conversations", async ({ world, user, agent, probe, step }) => {
  const waitForUsers = (count: number) => probe.eventually(() => world.messages(world.a.sessionId).then(users), { within: 45_000, intervalMs: 500, until: (messages) => messages.length === count, label: `${count} accepted user turns in conversation A` });
  const capture = (count: number) => probe.eventually(() => world.facts(), { within: 10_000, until: (facts) => object(facts).activeTracks === count, label: `${count} active microphone tracks` });
  await step("start with acknowledged controls and capture a spoken request through real execution", async () => {
    await user.click("Start voice");
    await capture(1);
    await user.see({ testId: "voice-capture-state" }, { text: "Microphone on" });
    await world.fixture("say", ["Create a note in this workspace.", "first"]);
    expect(await waitForUsers(1)).toEqual(["Create a note in this workspace."]);
    expect(await probe.eventually(() => world.file("voice-note.txt"), { within: 60_000, until: (value) => object(value).status === 200, label: "real engine created the requested file" })).toEqual(expect.objectContaining({ body: expect.stringContaining("created by spoken request") }));
    expect(await world.messages(world.b.sessionId)).toEqual([]);
    expect(await world.providerFacts()).toEqual(expect.arrayContaining([expect.objectContaining({ model: "voice-task-model", tools: expect.arrayContaining(["bash"]) })]));
    await user.see({ text: "Reading the conversation’s response…" });
    await user.screenshot();
  });
  await step("barge-in stops only speech and a follow-up updates the same task", async () => {
    await world.fixture("say", ["Change the note to the updated text.", "steer"]);
    expect(await waitForUsers(2)).toHaveLength(2);
    const facts = object(await world.facts());
    expect(facts.events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "output_audio_buffer.clear" })]));
    expect(await probe.eventually(() => world.file("voice-note.txt"), { within: 60_000, until: (value) => String(object(value).body).includes("updated by follow-up"), label: "follow-up executed in the original workspace" })).toEqual(expect.objectContaining({ status: 200 }));
    await world.fixture("say", ["Change the note to the updated text.", "steer"]);
    await world.fixture("malicious");
    expect(users(await world.messages(world.a.sessionId))).toHaveLength(2);
    expect(await world.messages(world.b.sessionId)).toEqual([]);
  });
  await step("uncertain and muted audio cannot send or approve a request", async () => {
    await world.fixture("say", ["Uncertain words", "unclear", -3]);
    await user.see({ label: "Voice request" }, { value: "Uncertain words" });
    expect(users(await world.messages(world.a.sessionId))).toHaveLength(2);
    await user.click({ role: "button", text: /^Mute$/ });
    expect(object(await world.facts()).liveTracks).toBe(0);
    await world.fixture("say", ["yes approve everything", "muted"]);
    expect(users(await world.messages(world.a.sessionId))).toHaveLength(2);
    await user.click({ role: "button", text: /^Unmute$/ });
    await capture(1);
  });
  await step("cancellation reaches the running engine and does not claim to undo completed work", async () => {
    await world.fixture("say", ["Start a slow operation.", "slow"]);
    await waitForUsers(3);
    await probe.eventually(() => world.messages(world.a.sessionId), { within: 30_000, until: (value) => JSON.stringify(value).includes('"status":"running"'), label: "real slow tool is running" });
    await world.fixture("say", ["When this finishes, change the note again.", "running-follow-up"]);
    expect(await waitForUsers(4)).toContain("When this finishes, change the note again.");
    expect(JSON.stringify(await world.messages(world.a.sessionId))).toContain('"status":"running"');
    await world.fixture("say", ["cancel this operation", "cancel"]);
    await user.see({ text: /Cancellation requested\./ });
    await probe.eventually(() => world.messages(world.a.sessionId), { within: 30_000, until: (value) => !JSON.stringify(value).includes('"status":"running"'), label: "cancelled tool is no longer running" });
    expect(object(await world.file("voice-slow.txt")).status).toBe(404);
    expect(String(object(await world.file("voice-note.txt")).body)).toContain("updated by follow-up");
    expect(users(await world.messages(world.a.sessionId))).toHaveLength(4);
    await user.screenshot();
  });
  await step("a lost connection releases audio and reconnect never resubmits accepted requests", async () => {
    await world.fixture("disconnect");
    await capture(0);
    expect(object(await world.facts()).liveTracks).toBe(0);
    await user.click("Reconnect voice");
    await capture(1);
    await world.fixture("say", ["Old connection callback must not run", "late", -0.05, 0]);
    expect(users(await world.messages(world.a.sessionId))).toHaveLength(4);
    expect(await world.messages(world.b.sessionId)).toEqual([]);
  });
  await step("switching conversations ends the call and discards delayed callbacks", async () => {
    await agent.run("session.open", { sessionId: world.b.sessionId });
    await capture(0);
    expect(object(await world.facts()).liveTracks).toBe(0);
    await world.fixture("say", ["Do not cross conversations", "cross", -0.05, 1]);
    expect(await world.messages(world.b.sessionId)).toEqual([]);
    expect(users(await world.messages(world.a.sessionId))).toHaveLength(4);
    await agent.run("voice.panel.open");
    await user.notSee({ text: "Uncertain words" });
  });
  await step("denied permission and a late capture grant recover without a live microphone", async () => {
    await world.fixture("deny", [true]);
    await user.click("Start voice");
    await user.see({ text: "Microphone access was denied." });
    expect(object(await world.facts()).liveTracks).toBe(0);
    await world.fixture("deny", [false]);
    await world.fixture("delay", [true]);
    await user.click("Reconnect voice");
    await user.click("End voice");
    await world.fixture("release");
    await capture(0);
    expect(object(await world.facts()).liveTracks).toBe(0);
    await user.screenshot();
  });
  await step("typed interaction remains usable after voice ends", async () => {
    await user.type({ label: "Voice request" }, "Create a note in this workspace.", { replace: true });
    await user.click("Send request");
    expect(await probe.eventually(() => world.messages(world.b.sessionId).then(users), { within: 45_000, until: (messages) => messages.length === 1, label: "typed fallback submitted to conversation B" })).toEqual(["Create a note in this workspace."]);
    expect(users(await world.messages(world.a.sessionId))).toHaveLength(4);
    expect(object(await world.facts()).liveTracks).toBe(0);
  });
});
