import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { sessionHome, movedSessionQuestion, movedSessionVideo } from "../worlds/session-home.ts";

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

const questionTest = spec.world(movedSessionQuestion, {
  timeout: 240_000, resources: { surfaces: ["appWeb"], services: ["mock"] },
});

questionTest("HOME-02 a moved task shows its question live and after reload, then resumes with the answer", async ({ world, user, agent, probe, step, evidence }) => {
  await agent.run("session.open", { sessionId: world.session.sessionId });
  await user.see("composer", { editable: true });
  const route = await probe.hash();
  await step("the question offers answer controls in the original conversation after moving", async () => {
    await user.type("composer", world.prompt, { replace: true, verify: true });
    await user.click("Run task");
    await user.see({ role: "button", label: new RegExp(world.answer) }, { timeoutMs: 60_000 });
    expect(record(sessionInfo(await world.sessionState()).location).directory).toBe(world.destination);
    expect(await probe.hash()).toBe(route);
    await user.screenshot();
  });
  await step("reopening restores the pending question and its answer reaches the moved task", async () => {
    await user.reload();
    await user.see({ role: "button", label: new RegExp(world.answer) }, { timeoutMs: 30_000 });
    const pending = record((await world.questions()).body).data;
    expect(Array.isArray(pending) && pending.some(item => record(item).sessionID === world.session.sessionId)).toBe(true);
    await user.screenshot();
    await user.click({ role: "button", label: new RegExp(world.answer) });
    await user.see({ text: world.completed }, { timeoutMs: 45_000 });
    await user.see("Run task", { timeoutMs: 30_000 });
    expect(record((await world.questions()).body).data).toEqual([]);
    expect(await probe.hash()).toBe(route);
    await user.screenshot();
  });
  evidence.recordAssertionEvidence("Questions follow their conversation after a native move",
    "A real v2 session_move is followed by a native question tool. Its answer controls appear in the original chat, survive a reload, and resume the waiting task. Only model decisions are synthetic.", true);
});

questionTest("HOME-03 an unavailable global question list cannot prevent answering the current question", async ({ world, user, agent, probe, step, evidence }) => {
  await agent.run("session.open", { sessionId: world.session.sessionId });
  await user.see("composer", { editable: true });
  await user.type("composer", world.prompt, { replace: true, verify: true });
  await user.click("Run task");
  await user.see({ role: "button", label: new RegExp(world.answer) }, { timeoutMs: 60_000 });
  await step("the workspace question list fails while the current question remains visible", async () => {
    const unavailable = await world.failGlobalQuestionList();
    expect(unavailable.status).toBe(500);
    await user.screenshot();
  });
  await step("answering the visible question completes the task despite the failed list", async () => {
    await user.see({ role: "button", label: new RegExp(world.answer) }, { timeoutMs: 30_000 });
    await user.click({ role: "button", label: new RegExp(world.answer) });
    await user.see({ text: world.completed }, { timeoutMs: 45_000 });
    await user.see("Run task", { timeoutMs: 30_000 });
    await user.screenshot();
  });
  evidence.recordAssertionEvidence("A failed workspace lookup cannot block a question reply",
    "A real v2 question stays answerable when the global pending-list HTTP endpoint returns the observed 500 session_unavailable error. Only that failing boundary and model decisions are synthetic; form reads and the answer run against the real engine.", true);
});

const videoTest = spec.world(movedSessionVideo, {
  timeout: 240_000, resources: { surfaces: ["appWeb"], services: ["mock"] },
});

videoTest("HOME-04 a member plays a video the agent saved after moving into a worktree", async ({ world, user, agent, probe, step, evidence }) => {
  await agent.run("session.open", { sessionId: world.session.sessionId });
  await user.see("composer", { editable: true });
  await step("the agent moves into its worktree, saves the video there and names it in its reply", async () => {
    await user.type("composer", world.video.prompt, { replace: true, verify: true });
    await user.click("Run task");
    await user.see({ text: /The new cut is ready/ }, { timeoutMs: 60_000 });
    await user.see("Run task", { timeoutMs: 30_000 });
    expect(record(sessionInfo(await world.sessionState()).location).directory).toBe(world.destination);
    const onDisk = await world.videoOnDisk();
    evidence.recordAssertionEvidence("the video exists only in the conversation's worktree",
      `worktree: ${onDisk.worktree}; workspace folder: ${onDisk.workspace}`, onDisk.worktree && !onDisk.workspace);
    expect(onDisk).toEqual({ worktree: true, workspace: false });
  });
  await step("before: looking only in the workspace folder, the video is not found", async () => {
    const status = await world.videoDownloadStatus();
    evidence.recordAssertionEvidence("workspace-only lookup", `GET files/raw ${world.video.path} → ${status}`, status === 404);
    expect(status).toBe(404);
  });
  await step("after: the referenced video plays inline in the chat", async () => {
    const ready = await probe.eventually(() => world.videoState(world.video.path), {
      within: 30_000, label: "worktree video loaded", until: state => state?.ready === true,
    });
    expect(ready).toMatchObject({ ready: true, error: null });
    await world.videoState(world.video.path, true);
    const playing = await probe.eventually(() => world.videoState(world.video.path), {
      within: 5_000, label: "worktree video playing", until: state => (state?.time ?? 0) > 0,
    });
    evidence.recordAssertionEvidence("video plays from the worktree",
      `${world.video.path}: loaded, played to ${playing?.time.toFixed(2)} s, error ${playing?.error ?? "none"}`, (playing?.time ?? 0) > 0);
    await user.notSee({ text: /Video preview unavailable/ });
    await user.screenshot();
  });
  await step("after: a video name that exists nowhere reads as an inline file name, not an empty player", async () => {
    await user.see({ text: world.video.missing });
    const gone = await probe.eventually(() => world.videoState(world.video.missing), {
      within: 15_000, label: "unplayable reference falls back to text", until: state => state === null,
    });
    evidence.recordAssertionEvidence("unplayable reference", `${world.video.missing}: no player left in the sentence`, gone === null);
    expect(gone).toBeNull();
    await user.screenshot();
  });
  await step("a conversation that is not part of this workspace cannot read the worktree", async () => {
    const status = await world.videoDownloadStatus("ses_not_in_this_workspace");
    evidence.recordAssertionEvidence("unknown conversation", `GET files/raw with an unrelated session → ${status}`, status === 404);
    expect(status).toBe(404);
  });
  await step("the video still plays after a reload", async () => {
    await user.reload();
    await user.see({ text: /The new cut is ready/ }, { timeoutMs: 30_000 });
    const ready = await probe.eventually(() => world.videoState(world.video.path), {
      within: 30_000, label: "worktree video loaded after reload", until: state => state?.ready === true,
    });
    expect(ready).toMatchObject({ ready: true, error: null });
    await user.screenshot();
  });
});
