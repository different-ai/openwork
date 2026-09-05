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

test("voice sends and steers real conversation work, interrupts speech, cancels, reconnects without replay, and isolates conversations", async ({ world, user, agent, probe, step, place, evidence }) => {
  const waitForUsers = (count: number) => probe.eventually(() => world.messages(world.a.sessionId).then(users), { within: 45_000, intervalMs: 500, until: (messages) => messages.length === count, label: `${count} accepted user turns in conversation A` });
  const capture = (count: number) => probe.eventually(() => world.facts(), { within: 10_000, until: (facts) => object(facts).activeTracks === count, label: `${count} active microphone tracks` });
  const spoken = async () => {
    const events = object(await world.facts()).events;
    if (!Array.isArray(events)) throw new Error("Missing audio transport witness");
    return events.filter(event => object(event).type === "response.create").map(event => {
      const response = object(object(event).response);
      expect(response.tools).toEqual([]);
      expect(response.tool_choice).toBe("none");
      return JSON.stringify(response.input);
    });
  };
  await step("start with acknowledged controls and capture a spoken request through real execution", async () => {
    await user.see({ testId: "voice-task-title" }, { text: "Attached to Voice conversation A" });
    await user.click("Start voice");
    await capture(1);
    await user.see({ testId: "voice-capture-state" }, { text: "Microphone on" });
    expect(object(await world.facts()).sessions).toEqual([{ model: "gpt-realtime-2.1" }]);
    expect(object(await world.facts()).events).toEqual(expect.arrayContaining([expect.objectContaining({
      type: "session.update", session: expect.objectContaining({
        include: ["item.input_audio_transcription.logprobs"],
        audio: expect.objectContaining({ input: expect.objectContaining({ transcription: { model: "gpt-4o-transcribe" } }) }),
      }),
    })]));
    await world.fixture("say", ["Create a note in this workspace.", "first"]);
    expect(await waitForUsers(1)).toEqual(["Create a note in this workspace."]);
    expect(await probe.eventually(() => world.file("voice-note.txt"), { within: 60_000, until: (value) => object(value).status === 200, label: "real engine created the requested file" })).toEqual(expect.objectContaining({ body: expect.stringContaining("created by spoken request") }));
    expect(await world.messages(world.b.sessionId)).toEqual([]);
    expect(await world.providerFacts()).toEqual(expect.arrayContaining([expect.objectContaining({ model: "voice-task-model", tools: expect.arrayContaining(["bash"]) })]));
    await probe.eventually(spoken, { within: 15_000, until: replies => replies.some(reply => reply.includes("Your task has a response.")), label: "default speech is only a response notification" });
    expect(JSON.stringify(await spoken())).not.toContain("The note was created in this workspace.");
    expect(JSON.stringify(await spoken())).not.toContain("Create a note in this workspace.");
    evidence.recordAssertionEvidence("A spoken request uses Realtime 2.1 for audio and the selected task model for real execution; the other conversation stays empty", JSON.stringify({ audioSessions: object(await world.facts()).sessions, userTurns: await waitForUsers(1), file: await world.file("voice-note.txt"), otherConversation: await world.messages(world.b.sessionId), model: await world.providerFacts() }), true);
    await user.screenshot();
  });
  await step("barge-in stops only speech and a follow-up updates the same task", async () => {
    await user.click({ role: "checkbox", label: /Read replies aloud/ });
    await world.fixture("say", ["Change the note to the updated text.", "steer"]);
    expect(await waitForUsers(2)).toHaveLength(2);
    const facts = object(await world.facts());
    expect(facts.events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "output_audio_buffer.clear" })]));
    expect(await probe.eventually(() => world.file("voice-note.txt"), { within: 60_000, until: (value) => String(object(value).body).includes("updated by follow-up"), label: "follow-up executed in the original workspace" })).toEqual(expect.objectContaining({ status: 200 }));
    const playback = await probe.eventually(spoken, { within: 15_000, until: replies => replies.some(reply => reply.includes("The note now contains the updated text.")), label: "playback receives the completed engine response" });
    expect(JSON.stringify(playback)).not.toContain("Change the note to the updated text.");
    await world.fixture("say", ["Change the note to the updated text.", "steer"]);
    await world.fixture("malicious");
    expect(users(await world.messages(world.a.sessionId))).toHaveLength(2);
    expect(await world.messages(world.b.sessionId)).toEqual([]);
    evidence.recordAssertionEvidence("Interruption clears playback and the follow-up changes the same workspace without duplicating its user turn", JSON.stringify({ userTurns: users(await world.messages(world.a.sessionId)), file: await world.file("voice-note.txt"), audioCleared: true, completedResponsePlayback: playback, otherConversation: await world.messages(world.b.sessionId) }), true);
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
    evidence.recordAssertionEvidence("Uncertain and muted audio stay unsubmitted; unmute reacquires capture", "Reviewed textarea value was Uncertain words; mute left zero live tracks; muted approval produced no turn; user count stayed 2; unmute restored one active track.", true);
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
    evidence.recordAssertionEvidence("A follow-up enters the running conversation; cancellation stops the real tool without undoing completed work", JSON.stringify({ messages: await world.messages(world.a.sessionId), cancelledFile: await world.file("voice-slow.txt"), completedFile: await world.file("voice-note.txt") }), true);
    await user.screenshot();
  });
  await step("a lost connection releases audio and reconnect never resubmits accepted requests", async () => {
    await world.fixture("disconnect");
    await capture(0);
    expect(object(await world.facts()).liveTracks).toBe(0);
    await user.click({ text: "Audio and privacy" });
    await user.see({ testId: "voice-audio-model" }, { value: "gpt-realtime-2.1" });
    await user.click({ testId: "voice-audio-model" });
    await user.press("End");
    await user.press("Enter");
    await user.see({ testId: "voice-audio-model" }, { value: "gpt-realtime-2.1-mini" });
    await user.click("Reconnect voice");
    await capture(1);
    expect(object(await world.facts()).sessions).toEqual([{ model: "gpt-realtime-2.1" }, { model: "gpt-realtime-2.1-mini" }]);
    await user.click({ text: "Audio and privacy" });
    await world.fixture("say", ["Old connection callback must not run", "late", -0.05, 0]);
    expect(users(await world.messages(world.a.sessionId))).toHaveLength(4);
    expect(await world.messages(world.b.sessionId)).toEqual([]);
    evidence.recordAssertionEvidence("Reconnect uses the chosen Realtime 2.1 Mini audio model without replay or task-model changes", JSON.stringify({ audioSessions: object(await world.facts()).sessions, userTurns: users(await world.messages(world.a.sessionId)), otherConversation: await world.messages(world.b.sessionId), activeTracks: object(await world.facts()).activeTracks }), true);
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
    await user.see({ label: "Voice request" }, { value: "" });
    evidence.recordAssertionEvidence("Switching conversations releases audio and isolates pending input", "Zero live tracks after navigation; the old peer's transcript created no turn in B; A retained 4 turns; B's voice textarea was empty.", true);
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
    evidence.recordAssertionEvidence("Denied permission and capture granted after End leave no microphone live", "Denied access showed recovery; after a delayed permission grant and End, both active and live track counts were zero.", true);
  });
  await step("typed interaction remains usable after voice ends", async () => {
    await user.type({ label: "Voice request" }, "Create a note in this workspace.", { replace: true });
    await user.click("Send request");
    expect(await probe.eventually(() => world.messages(world.b.sessionId).then(users), { within: 45_000, until: (messages) => messages.length === 1, label: "typed fallback submitted to conversation B" })).toEqual(["Create a note in this workspace."]);
    expect(users(await world.messages(world.a.sessionId))).toHaveLength(4);
    expect(object(await world.facts()).liveTracks).toBe(0);
    evidence.recordAssertionEvidence("Typed fallback remains in the new conversation after voice ends", JSON.stringify({ originalConversationUsers: users(await world.messages(world.a.sessionId)), newConversationUsers: users(await world.messages(world.b.sessionId)), liveTracks: 0 }), true);
  });
  await step("spoken connected-app work preserves discovered connection namespaces", async () => {
    await user.click({ text: "Audio and privacy" });
    await user.see({ testId: "voice-audio-model" }, { value: "gpt-realtime-2.1" });
    await user.click({ testId: "voice-audio-model" });
    await user.press("End");
    await user.press("Enter");
    await user.see({ testId: "voice-audio-model" }, { value: "gpt-realtime-2.1-mini" });
    await user.click({ text: "Audio and privacy" });
    await user.click("Start voice");
    await capture(1);
    await user.click({ role: "checkbox", label: /Read replies aloud/ });
    await world.fixture("say", ["Find the notes in my connected project notes app.", "connected-notes"]);
    const calls = await probe.eventually(() => world.capabilityCalls(), { within: 60_000, until: calls => calls.length === 2, label: "search and script reach the MCP witness" });
    expect(calls.map(({ name, args }) => ({ name, args }))).toEqual([
      { name: "search_capabilities", args: { query: "project notes" } },
      { name: "execute_capability_script", args: { code: 'return await tools.project_notes_2["list-notes"]({});' } },
    ]);
    await probe.eventually(spoken, { within: 30_000, until: replies => replies.some(reply => reply.includes("The connected app returned Project brief and Release checklist.")), label: "spoken completion follows the connected tool response" });
    expect(users(await world.messages(world.b.sessionId))).toHaveLength(2);
    expect(users(await world.messages(world.a.sessionId))).toHaveLength(4);
    expect(await world.providerFacts()).toEqual(expect.arrayContaining([expect.objectContaining({ model: "voice-task-model" })]));
    evidence.recordAssertionEvidence("Voice preserves discovered connection and tool namespaces through normal task execution with Mini audio", JSON.stringify({ audioSessions: object(await world.facts()).sessions, calls, playback: await spoken(), originalTaskUsers: users(await world.messages(world.a.sessionId)) }), true);
  });
  await step("voice text and transcripts use the same Cloud and Desktop task routing as the composer", async () => {
    await user.type({ label: "Voice request" }, "@cloud Summarize the project notes.", { replace: true });
    await user.click("Send request");
    await probe.eventually(() => world.capabilityCalls(), { within: 45_000, until: calls => calls.length === 4, label: "Cloud task handoff reached Connect" });
    await probe.eventually(spoken, { within: 30_000, until: replies => replies.some(reply => reply.includes("The task request is queued. Its completion has not been confirmed.")), label: "handoff does not announce task completion" });
    await world.fixture("say", ["@desktop Summarize my local project notes.", "desktop-task"]);
    const calls = await probe.eventually(() => world.capabilityCalls(), { within: 45_000, until: calls => calls.length === 6, label: "Desktop task handoff reached Connect" });
    expect(calls.slice(2).map(({ name, args }) => ({ name, args }))).toEqual([
      { name: "search_capabilities", args: { query: "remote-session:create" } },
      { name: "execute_capability", args: { name: "remote-session:create", body: { target: "cloud", prompt: "Summarize the project notes." } } },
      { name: "search_capabilities", args: { query: "remote-session:create" } },
      { name: "execute_capability", args: { name: "remote-session:create", body: { target: "desktop", prompt: "Summarize my local project notes." } } },
    ]);
    const messages = await world.messages(world.b.sessionId);
    expect(users(messages).slice(-2)).toEqual(["@cloud Summarize the project notes.", "@desktop Summarize my local project notes."]);
    if (!Array.isArray(messages)) throw new Error("Expected messages");
    const routing = messages.flatMap(message => object(message).routing);
    expect(routing).toEqual(expect.arrayContaining([expect.stringContaining('target "cloud"'), expect.stringContaining('target "desktop"')]));
    await user.type({ label: "Voice request" }, "Explain person@cloud and the word desktop.", { replace: true });
    await user.click("Send request");
    await probe.eventually(() => world.messages(world.b.sessionId), { within: 45_000, until: messages => JSON.stringify(messages).includes("That address is ordinary text."), label: "ordinary text finishes without a computer handoff" });
    expect(await world.capabilityCalls()).toHaveLength(6);
    expect(users(await world.messages(world.a.sessionId))).toHaveLength(4);
    evidence.recordAssertionEvidence("Cloud/Desktop routing preserves the intended computer and does not reroute ordinary text", JSON.stringify({ calls, messages: await world.messages(world.b.sessionId), originalTaskUsers: users(await world.messages(world.a.sessionId)) }), true);
    await user.screenshot();
  });

  await step("voice follows the focused split task and releases the previous call", async () => {
    const before = object(await world.facts());
    await user.press(place.kind !== "daytona" && process.platform === "darwin" ? "Meta+K" : "Control+K");
    await user.type({ placeholder: "Search actions, settings, and sessions…" }, "new split", { replace: true });
    await user.see({ role: "option", label: /^New split/ });
    await user.press("Enter");
    const layout = object(await probe.eventually(() => world.layout(), { within: 30_000, until: value => object(value).kind === "split" && object(value).focused === "secondary", label: "new task is focused in the split" }));
    const splitId = layout.secondarySessionId;
    if (typeof splitId !== "string") throw new Error("Missing secondary task");
    await capture(0);
    expect(object(await world.facts()).liveTracks).toBe(0);
    await world.fixture("say", ["Old task speech must not follow focus", "old-focus", -0.05, Number(before.peers) - 1]);
    expect(await world.messages(splitId)).toEqual([]);
    await user.see({ testId: "voice-task-title" }, { text: "Attached to New session" });
    await user.click("Start voice");
    await capture(1);
    await world.fixture("say", ["Create a note in this workspace.", "split-task"]);
    await probe.eventually(() => world.messages(splitId).then(users), { within: 45_000, until: turns => turns.length === 1, label: "speech submitted only to focused split task" });
    expect(users(await world.messages(world.b.sessionId))).toHaveLength(5);
    expect(users(await world.messages(world.a.sessionId))).toHaveLength(4);
    await agent.run("workbench.session.focus", { sessionId: world.b.sessionId });
    await capture(0);
    expect(object(await world.facts()).liveTracks).toBe(0);
    evidence.recordAssertionEvidence("Voice uses the focused split task and closes audio when focus changes", JSON.stringify({ splitUsers: users(await world.messages(splitId)), originalTaskUsers: users(await world.messages(world.b.sessionId)), liveTracks: 0 }), true);
  });

  await step("a broker model mismatch releases capture without submitting work", async () => {
    await world.fixture("model", ["gpt-realtime-2"]);
    await user.click("Start voice");
    await user.see({ text: "The voice provider returned a different audio model." });
    await capture(0);
    expect(object(await world.facts()).liveTracks).toBe(0);
    expect(users(await world.messages(world.b.sessionId))).toHaveLength(5);
    expect(users(await world.messages(world.a.sessionId))).toHaveLength(4);
    evidence.recordAssertionEvidence("An unexpected broker model stops capture and creates no task turn", JSON.stringify({ liveTracks: object(await world.facts()).liveTracks, originalTaskUsers: users(await world.messages(world.a.sessionId)), focusedTaskUsers: users(await world.messages(world.b.sessionId)) }), true);
  });
});
