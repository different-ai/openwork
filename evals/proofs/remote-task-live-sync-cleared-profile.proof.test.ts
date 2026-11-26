import { setTimeout as wait } from "node:timers/promises";
import { spec } from "@openwork/testkit";
import { expect } from "vitest";
import { CHAT_PROMPT, CHAT_REPLY, COMPUTER_LABEL, INITIAL_TAIL, LIVE_TAIL, TASK_TITLE } from "../worlds/remote-session-helper-view.ts";
import { remoteTaskLiveSyncWorld } from "../worlds/remote-task-live-sync.ts";

const test = spec.world(remoteTaskLiveSyncWorld, { timeout: 240_000, resources: { surfaces: ["appWeb"], services: ["den", "mock"] }, needs: { commands: ["bun"] } });
const row = { role: "button" as const, label: `${TASK_TITLE}. Open the task on ${COMPUTER_LABEL}` };

test("the owner finds the Studio computer task on a fresh device and watches it update live", async ({ world, user, probe, agent, step, evidence }) => {
  const parent = await probe.url();
  await step("before: the parent chat hasn't handed off a task", async () => {
    await user.see("composer", { editable: true, timeoutMs: 60_000 });
    await user.notSee(row);
    const task = await world.boundTask();
    evidence.recordAssertionEvidence("No task is attached yet", `Attached task: ${task?.commandId ?? "none"}.`, !task);
    expect(task).toBeUndefined();
    await user.screenshot();
  });
  await step("the owner hands the demo videos to Studio computer from the parent chat", async () => {
    const composer = await probe.eventually(world.composer, { within: 30_000, until: state => state.selectedModelLabel?.startsWith("Remote helper agent") === true });
    expect(composer.selectedModelLabel).toContain("Remote helper agent");
    await agent.send(CHAT_PROMPT);
    const task = await probe.eventually(world.boundTask, { within: 30_000, until: value => Boolean(value?.tailUpdatedAt) });
    expect(task?.parentWorkspaceId).toBe(world.workspace.workspaceId);
    const rows = await world.storedTailCount(task!.commandId);
    evidence.recordAssertionEvidence("The running task has a saved transcript in Den", `Saved transcripts for this chat's task in MySQL: ${rows}.`, rows === 1);
    expect(rows).toBe(1);
    await user.see({ text: CHAT_REPLY });
    await user.screenshot();
  });
  await using second = await world.secondViewer();
  const other = user.on(second.surface);
  const observe = probe.on(second.surface);
  await other.resizeViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  const film = await second.film();
  const hold = (ms: number) => second.recording ? wait(ms) : undefined;
  try {
    await step("after: opening the parent chat on a cleared profile shows Studio computer under Agents", async () => {
      await other.navigate(parent);
      await other.see(row, { timeoutMs: 15_000 });
      const tracker = await observe.dom("[data-subagent-tracker] [data-subagent-tracker-remote]");
      expect(tracker.elements.some(item => item.rect.height > 0 && item.text.includes(COMPUTER_LABEL))).toBe(true);
      const witness = await second.witness();
      evidence.recordAssertionEvidence("No local cache preceded the Agents row", `Storage entries before app startup (local / session): ${witness?.initialStorage.join(" / ")}.`, witness?.initialStorage.every(size => size === 0) === true);
      expect(witness?.initialStorage).toEqual([0, 0]);
      await other.screenshot();
      await hold(2100);
    });
    await step("the owner opens the task and sees the transcript without asking Studio computer to reread it", async () => {
      await other.click(row);
      await other.see({ text: INITIAL_TAIL }, { timeoutMs: 10_000 });
      expect((await observe.dom("[data-remote-thread-transcript]")).elements.some(item => item.text.includes(INITIAL_TAIL))).toBe(true);
      await other.notSee({ text: LIVE_TAIL });
      const reads = world.runnerReads().length;
      evidence.recordAssertionEvidence("The saved transcript appeared without a runner read", `Runner reads since task creation: ${reads}.`, reads === 0);
      expect(reads).toBe(0);
      await other.screenshot();
      await hold(2250);
    });
    await step("after: a new transcript line appears in the open task without a refresh", async () => {
      const stream = await observe.eventually(second.witness, { within: 10_000, until: value => value?.snapshot === true });
      expect(stream?.streamStatus).toBe(200);
      expect(stream?.liveUpdate).toBe(false);
      await second.blockTranscriptRequests();
      await world.publishLiveUpdate();
      await other.see({ text: LIVE_TAIL }, { timeoutMs: 10_000 });
      expect((await observe.dom("[data-remote-thread-transcript]")).elements.some(item => item.text.includes(LIVE_TAIL))).toBe(true);
      const updated = await observe.eventually(second.witness, { within: 5_000, until: value => value?.liveUpdate === true });
      const reads = world.runnerReads().length;
      evidence.recordAssertionEvidence("Den streamed the new line to the open task", `Stream HTTP ${updated?.streamStatus}; new line in a live event: ${updated?.liveUpdate}; runner reads: ${reads}.`, updated?.liveUpdate === true && reads === 0);
      expect(updated?.liveUpdate).toBe(true);
      expect(reads).toBe(0);
      await other.screenshot();
      await hold(3000);
    });
  } finally {
    await film?.stop();
  }
});
