import { engineSessionProbe } from "@openwork/behaviors";
import { spec } from "@openwork/testkit";
import { expect } from "vitest";
import { arrangeControl, steeringRecovery } from "../worlds/chat.ts";

const test = spec.world(steeringRecovery, { timeout: 600_000 });

function includesExactlyOnce(values: string[], marker: string): boolean {
  return values.reduce((count, value) => count + value.split(marker).length - 1, 0) === 1;
}

test("local signed-out failed-task recovery, queued follow-ups, and truthful unfinished-tool lifecycle", async ({ world, user, seed, probe, agent, step, evidence }) => {
  evidence.recordAssertionEvidence(
    "Local configured-provider steering runs without cloud identity",
    `A read-only identity check found no desktop auth token and no server Den session before the ${world.engine} workflow.`,
    world.signedOutWithoutServerDenSession,
  );
  expect(world.signedOutWithoutServerDenSession).toBe(true);
  const workspaceId = world.workspace.workspaceId;
  const native = engineSessionProbe({ engine: world.engine, surface: world.app, workspaceId });
  const otherLane = engineSessionProbe({ engine: world.engine === "v2" ? "v1" : "v2", surface: world.app, workspaceId });
  type NativeSnapshot = Awaited<ReturnType<typeof native.snapshot>>;
  const compactSnapshot = ({ ok, status, data }: NativeSnapshot) => ({ ok, status, data });
  const snapshotText = (snapshot: Pick<NativeSnapshot, "data">) => snapshot.data.messages
    .flatMap((message) => message.parts)
    .flatMap((part) => [part.text, part.output])
    .filter(Boolean)
    .join("\n");
  const relevantRequests = async (markers: string[]) => (await world.mock.agentRequests({ sinceIso: world.startedAt }))
    .filter((request) => request.kind !== "utility" && request.promptMarker !== null && markers.includes(request.promptMarker));
  const sendNowShortcut = await world.sendNowShortcut();
  const milestone = async (name: string, claim: string, run: () => Promise<void>) => {
    try {
      await step(name, run);
    } catch (error) {
      await user.screenshot().catch(() => undefined);
      evidence.recordAssertionEvidence(claim, "The bounded milestone failed; the captured screenshot and step trace preserve the last UI state.", false);
      throw error;
    }
  };

  await milestone("the real engine records completed shell work and the provider's terminal HTTP 400", "Local configured-provider work reaches the intended provider failure", async () => {
    const laneStatus = await agent.desktopApi("/experimental/engine-v2-preview/status", { method: "GET" });
    expect([200, 404]).toContain(laneStatus.status);
    const selectedV2 = laneStatus.status === 200 && typeof laneStatus.body === "object" && laneStatus.body !== null
      && "enabled" in laneStatus.body && laneStatus.body.enabled === true
      && "chatRouting" in laneStatus.body && laneStatus.body.chatRouting === true;
    expect(selectedV2 ? "v2" : "v1").toBe(world.engine);

    const untouchedBefore = await native.snapshot(world.bypass.sessionId);
    expect(untouchedBefore.ok).toBe(true);
    await agent.send(world.recoveryFailurePrompt);
    const failed = await probe.eventually(async () => {
      const [rawSnapshot, requests] = await Promise.all([
        native.snapshot(world.recovery.sessionId),
        relevantRequests([world.recoveryFailureMarker]),
      ]);
      const snapshot = compactSnapshot(rawSnapshot);
      const shell = snapshot.data.messages.flatMap((message) => message.parts)
        .filter((part) => part.tool === world.shellTool && part.input.command === world.recoveryCommand);
      return { snapshot, requests, shell };
    }, {
      within: 90_000,
      intervalMs: 250,
      label: "completed shell step followed by the sentinel provider failure",
      until: ({ snapshot, requests, shell }) => snapshot.ok
        && shell.length === 1 && shell[0]?.status === "completed" && shell[0]?.output.includes(world.recoveryShellMarker) === true
        && requests.some((request) => request.kind === "error" && request.toolName === world.failureSentinelTool),
    });
    expect(failed.snapshot.data.session?.id).toBe(world.recovery.sessionId);
    expect(failed.requests.map((request) => [request.kind, request.completedTools, request.toolName])).toEqual([
      ["tool", 0, world.shellTool],
      ["error", 1, world.failureSentinelTool],
    ]);
    expect(failed.requests.every((request) => request.matchedMarkers.length === 1
      && request.matchedMarkers[0] === world.recoveryFailureMarker)).toBe(true);
    expect(snapshotText(failed.snapshot)).toContain(world.recoveryShellMarker);
    expect(snapshotText(failed.snapshot)).not.toContain(world.recoveryReply);
    expect((await otherLane.get(world.recovery.sessionId)).ok).toBe(false);

    const beforeSteer = await world.dom(world.recovery.sessionId);
    expect(beforeSteer.sessionId).toBe(world.recovery.sessionId);
    expect(includesExactlyOnce(beforeSteer.users, world.recoveryFailureMarker)).toBe(true);
    expect(beforeSteer.users.some((text) => text.includes(world.recoveryPromptMarker))).toBe(false);
    const untouchedAfterFailure = await native.snapshot(world.bypass.sessionId);
    expect(untouchedAfterFailure.data.messages).toEqual(untouchedBefore.data.messages);
    expect(snapshotText(untouchedAfterFailure)).not.toContain(world.recoveryFailureMarker);
    await user.screenshot();
    evidence.recordAssertionEvidence(
      "Local configured-provider work reaches the intended provider failure",
      `Engine ${world.engine} kept session ${world.recovery.sessionId}; provider sequence was tool,error; the other session stayed empty.`,
      true,
    );
  });

  await milestone("Cmd/Ctrl+Enter sends recovery now in the same engine session and does not repeat completed work", "Local UI steering resumes without repeating completed work", async () => {
    await user.type("composer", world.recoveryPrompt, { verify: true });
    await user.press(sendNowShortcut);
    const recovered = await probe.eventually(async () => {
      const [rawSnapshot, visible, requests] = await Promise.all([
        native.snapshot(world.recovery.sessionId),
        world.dom(world.recovery.sessionId),
        relevantRequests([world.recoveryFailureMarker, world.recoveryPromptMarker]),
      ]);
      const snapshot = compactSnapshot(rawSnapshot);
      return { snapshot, visible, requests };
    }, {
      within: 90_000,
      intervalMs: 250,
      label: "steered recovery reply with a settled composer",
      until: ({ snapshot, visible, requests }) => snapshot.ok
        && includesExactlyOnce(visible.users, world.recoveryPromptMarker)
        && includesExactlyOnce(visible.assistants, world.recoveryReply)
        && visible.runTask === 1 && visible.stop === 0 && visible.composerEditable
        && requests.some((request) => request.promptMarker === world.recoveryPromptMarker && request.kind === "final"),
    });
    expect(recovered.snapshot.data.session?.id).toBe(world.recovery.sessionId);
    expect(recovered.visible.sessionId).toBe(world.recovery.sessionId);
    expect(includesExactlyOnce(recovered.visible.users, world.recoveryFailureMarker)).toBe(true);
    expect(includesExactlyOnce(recovered.visible.users, world.recoveryPromptMarker)).toBe(true);
    expect(includesExactlyOnce(recovered.visible.assistants, world.recoveryReply)).toBe(true);
    expect(recovered.visible.runTask).toBe(1);
    expect(recovered.visible.stop).toBe(0);
    expect(recovered.visible.composerEditable).toBe(true);
    expect(recovered.visible.assistants.some((text) => text.includes("Unexpected recovery failure completion"))).toBe(false);
    const recoveryParts = recovered.snapshot.data.messages.flatMap((message) => message.parts);
    expect(recoveryParts.filter((part) => part.tool === world.shellTool && part.input.command === world.recoveryCommand)).toHaveLength(1);
    expect(snapshotText(recovered.snapshot)).toContain(world.recoveryReply);
    expect(recovered.requests.map((request) => [request.promptMarker, request.kind, request.completedTools])).toEqual([
      [world.recoveryFailureMarker, "tool", 0],
      [world.recoveryFailureMarker, "error", 1],
      [world.recoveryPromptMarker, "final", 0],
    ]);
    expect(recovered.requests.at(-1)?.matchedMarkers).toEqual([world.recoveryPromptMarker]);
    const bypassStillEmpty = await native.snapshot(world.bypass.sessionId);
    expect(bypassStillEmpty.data.messages).toEqual([]);
    expect(snapshotText(bypassStillEmpty)).not.toContain(world.recoveryPromptMarker);
    const usabilityDraft = `Next usable draft ${world.recoveryPromptMarker}`;
    await user.type("composer", usabilityDraft, { verify: true });
    const usable = await world.dom(world.recovery.sessionId);
    expect(usable.composerEditable).toBe(true);
    expect(usable.composerText).toContain(usabilityDraft);
    await user.screenshot();
    evidence.recordAssertionEvidence(
      "Local UI steering resumes without repeating completed work",
      `One recovery prompt and reply reached session ${world.recovery.sessionId}; one shell call remained; idle Run task and an editable composer accepted a subsequent draft.`,
      true,
    );
  });

  const recoveryBeforeBypass = await native.snapshot(world.recovery.sessionId);
  await milestone("a direct busy send bypasses B/C without consuming or reordering their queue", "Local immediate UI direction preserves the pending FIFO queue", async () => {
    await agent.run("session.open", { sessionId: world.bypass.sessionId });
    await probe.eventually(() => world.dom(world.bypass.sessionId), {
      within: 30_000,
      label: "busy bypass session is visible",
      until: (visible) => visible.sessionId === world.bypass.sessionId,
    });
    await agent.send(world.bypassInitialPrompt);
    await probe.eventually(async () => {
      const [rawSnapshot, visible] = await Promise.all([native.snapshot(world.bypass.sessionId), world.dom(world.bypass.sessionId)]);
      const snapshot = compactSnapshot(rawSnapshot);
      return { snapshot, visible };
    }, {
      within: 60_000,
      intervalMs: 250,
      label: "controlled shell wait is running and the UI is busy",
      until: ({ snapshot, visible }) => snapshot.ok && visible.stop === 1 && visible.runTask === 0
        && snapshot.data.messages.flatMap((message) => message.parts)
        .some((part) => part.tool === world.shellTool && part.status === "running" && part.input.command === world.bypassCommand),
    });

    await user.type("composer", world.bypassQueuedBPrompt, { verify: true });
    await user.press("Enter");
    await user.see({ text: "1 queued" });
    await user.type("composer", world.bypassQueuedCPrompt, { verify: true });
    await user.press("Enter");
    const queuedBeforeDirect = await probe.eventually(() => world.dom(world.bypass.sessionId), {
      within: 15_000,
      intervalMs: 100,
      label: "B and C remain queued in FIFO order",
      until: (visible) => visible.queued.length === 2
        && visible.queued[0]?.includes(world.bypassQueuedBMarker) === true
        && visible.queued[1]?.includes(world.bypassQueuedCMarker) === true,
    });
    expect(queuedBeforeDirect.queued[0]).not.toContain(world.bypassQueuedCMarker);
    expect(queuedBeforeDirect.queued[1]).not.toContain(world.bypassQueuedBMarker);
    expect(queuedBeforeDirect.users.some((text) => text.includes(world.bypassQueuedBMarker))).toBe(false);
    expect(queuedBeforeDirect.users.some((text) => text.includes(world.bypassQueuedCMarker))).toBe(false);

    await user.type("composer", world.bypassDirectPrompt, { verify: true });
    await user.press(sendNowShortcut);
    const handoff = await probe.eventually(async () => {
      const [visible, rawSnapshot] = await Promise.all([world.dom(world.bypass.sessionId), native.snapshot(world.bypass.sessionId)]);
      const snapshot = compactSnapshot(rawSnapshot);
      return { visible, snapshot };
    }, {
      within: 15_000,
      intervalMs: 100,
      label: "direct X is admitted while the original tool runs and B/C stay pending",
      until: ({ visible, snapshot }) => includesExactlyOnce(visible.users, world.bypassDirectMarker)
        && visible.queued.length === 2
        && visible.queued[0]?.includes(world.bypassQueuedBMarker) === true
        && visible.queued[1]?.includes(world.bypassQueuedCMarker) === true
        && snapshot.data.messages.flatMap((message) => message.parts)
          .some((part) => part.tool === world.shellTool && part.status === "running" && part.input.command === world.bypassCommand),
    });
    expect(handoff.snapshot.data.session?.id).toBe(world.bypass.sessionId);
    expect(handoff.visible.queued.every((text) => !text.includes(world.bypassDirectMarker))).toBe(true);
    expect(handoff.visible.users.some((text) => text.includes(world.bypassQueuedBMarker))).toBe(false);
    expect(handoff.visible.users.some((text) => text.includes(world.bypassQueuedCMarker))).toBe(false);
    expect((await relevantRequests([world.bypassQueuedBMarker, world.bypassQueuedCMarker]))).toEqual([]);
    const recoveryDuringBypass = await native.snapshot(world.recovery.sessionId);
    expect(recoveryDuringBypass.data.messages).toEqual(recoveryBeforeBypass.data.messages);
    expect(snapshotText(recoveryDuringBypass)).not.toContain(world.bypassDirectMarker);
    await user.screenshot();
    evidence.recordAssertionEvidence(
      "Local immediate UI direction preserves the pending FIFO queue",
      `X entered session ${world.bypass.sessionId} during its running shell; B then C remained queued, had no provider receipt, and the recovery session did not change.`,
      true,
    );
  });

  await milestone("idle drains B then C exactly once after X and leaves neither session falsely busy", "The local preserved queue drains exactly once and the session settles", async () => {
    const markers = [world.bypassInitialMarker, world.bypassDirectMarker, world.bypassQueuedBMarker, world.bypassQueuedCMarker];
    const complete = await probe.eventually(async () => {
      const [visible, rawSnapshot, requests] = await Promise.all([
        world.dom(world.bypass.sessionId),
        native.snapshot(world.bypass.sessionId),
        relevantRequests(markers),
      ]);
      const snapshot = compactSnapshot(rawSnapshot);
      return { visible, snapshot, requests };
    }, {
      within: 120_000,
      intervalMs: 250,
      label: "the immediate reply and both queued replies complete in order",
      until: ({ visible }) => includesExactlyOnce(visible.assistants, world.bypassDirectReply)
        && includesExactlyOnce(visible.assistants, world.bypassQueuedBReply)
        && includesExactlyOnce(visible.assistants, world.bypassQueuedCReply)
        && visible.queued.length === 0 && visible.runTask === 1 && visible.stop === 0 && visible.composerEditable,
    });
    expect(complete.snapshot.data.session?.id).toBe(world.bypass.sessionId);
    const bypassParts = complete.snapshot.data.messages.flatMap((message) => message.parts);
    const bypassShell = bypassParts.filter((part) => part.tool === world.shellTool && part.input.command === world.bypassCommand);
    expect(bypassShell).toHaveLength(1);
    expect(bypassShell[0]?.status).toBe("completed");
    expect(bypassShell[0]?.output).toContain(world.bypassShellMarker);
    for (const marker of markers) expect(includesExactlyOnce(complete.visible.users, marker)).toBe(true);
    for (const reply of [world.bypassDirectReply, world.bypassQueuedBReply, world.bypassQueuedCReply]) {
      expect(includesExactlyOnce(complete.visible.assistants, reply)).toBe(true);
    }
    const directIndex = complete.visible.assistants.findIndex((text) => text.includes(world.bypassDirectReply));
    const queuedBIndex = complete.visible.assistants.findIndex((text) => text.includes(world.bypassQueuedBReply));
    const queuedCIndex = complete.visible.assistants.findIndex((text) => text.includes(world.bypassQueuedCReply));
    expect(directIndex).toBeLessThan(queuedBIndex);
    expect(queuedBIndex).toBeLessThan(queuedCIndex);
    expect(complete.visible.assistants.some((text) => text.includes("Unexpected original busy reply"))).toBe(false);
    expect(complete.requests.map((request) => [request.promptMarker, request.kind])).toEqual([
      [world.bypassInitialMarker, "tool"],
      [world.bypassDirectMarker, "final"],
      [world.bypassQueuedBMarker, "final"],
      [world.bypassQueuedCMarker, "final"],
    ]);
    expect(complete.requests.every((request) => request.matchedMarkers.length === 1
      && request.matchedMarkers[0] === request.promptMarker)).toBe(true);
    const recoveryAfterBypass = await native.snapshot(world.recovery.sessionId);
    expect(recoveryAfterBypass.data.messages).toEqual(recoveryBeforeBypass.data.messages);
    expect(markers.every((marker) => !snapshotText(recoveryAfterBypass).includes(marker))).toBe(true);
    expect((await otherLane.get(world.bypass.sessionId)).ok).toBe(false);
    await user.screenshot();
    evidence.recordAssertionEvidence(
      "The local preserved queue drains exactly once and the session settles",
      `Provider order was long-tool,X,B,C; each user and reply marker appeared once; queue count and Stop cleared while idle Run task and the editable composer remained.`,
      true,
    );
  });

  await arrangeControl(seed, world.app, "eval.session_lifecycle.seed_unfinished_tools", { lifecycle: "active" });
  await step("active unfinished tools remain visibly in progress", async () => {
    await user.see("Running command, reading 1 file");
  });

  await arrangeControl(seed, world.app, "eval.session_lifecycle.seed_unfinished_tools", { lifecycle: "waiting" });
  await step("a blocked unfinished step says what it needs", async () => {
    await user.see({ text: /Waiting for your action/ });
    await user.see({ text: "Choose an option or approve the request to continue." });
    await user.notSee("Running command, reading 1 file");
  });

  await arrangeControl(seed, world.app, "eval.session_lifecycle.seed_unfinished_tools", { lifecycle: "idle" });
  await step("idle unfinished tools expose an unknown terminal state", async () => {
    await user.see({ text: /Status unknown/ });
    await user.see({ text: "No terminal result was observed. This step may still be running; check the session before retrying." });
    await user.notSee({ text: /Waiting for your action/ });
    await user.notSee("Running command, reading 1 file");
  });
});
