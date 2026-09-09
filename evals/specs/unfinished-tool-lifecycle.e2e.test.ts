import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { arrangeControl, unfinishedTools } from "../worlds/chat.ts";
import { longToolActivity, type ActivityObservation } from "../worlds/tool-activity.ts";

const longTest = spec.world(longToolActivity, { timeout: 360_000 });
const test = spec.world(unfinishedTools);

test("unfinished current-turn tools expose active, waiting, and unknown outcomes", async ({ world, user, seed, step }) => {
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

longTest("TOOL-LONG preserves a real silent tool's activity across switching and reload, then Stop terminates only that run", { timeout: 360_000 }, async ({ world, user, probe, step, evidence }) => {
  user = user.on(world.app);
  probe = probe.on(world.app);
  const send = async (prompt: string) => {
    await user.type("composer", prompt, { verify: true, replace: true });
    await user.press("Enter");
  };
  const open = async (session: { title: string; sessionId: string }) => {
    await user.click({ text: session.title });
    await probe.eventually(() => world.selected(session.sessionId), { within: 30_000, label: `${session.title} is selected`, until: Boolean });
  };
  const toolFacts = (messages: Awaited<ReturnType<typeof world.transcript>>) => messages.flatMap((message) => message.tools);
  const runningTool = async (sessionId: string, commandMarker: string) => {
    const messages = await world.transcript(sessionId);
    return toolFacts(messages).find((tool) => tool.status === "running" && tool.input.includes(commandMarker)) ?? null;
  };
  const maxGap = (state: ActivityObservation) => Math.max(
    state.primaryMissingMaxMs, state.primaryMissingCurrentMs,
    ...state.primaryMissingIntervals.map((gap) => gap.durationMs),
  );
  const maxSidebarGap = (state: ActivityObservation) => Math.max(
    state.sidebarMissingMaxMs, state.sidebarMissingCurrentMs,
    ...state.sidebarMissingIntervals.map((gap) => gap.durationMs),
  );

  expect(world.root.sessionId).toBe(world.historySession.sessionId);
  const historyBefore = await step("the first turn runs 24 real commands and exposes the capped history in the same conversation", async () => {
    await open(world.root);
    await send(world.history.prompt);
    await user.see({ text: world.history.reply }, { timeoutMs: 120_000 });
    const messages = await probe.eventually(() => world.transcript(world.historySession.sessionId), {
      within: 30_000,
      label: "all history commands and the final answer are native and complete",
      until: (items) => toolFacts(items).filter((tool) => tool.status === "completed").length === world.history.callCount
        && items.some((message) => message.completed && message.text === world.history.reply),
    });
    const tools = toolFacts(messages);
    const requests = await world.mock.agentRequests({ promptMarker: world.history.prompt });
    const outputLines = tools.flatMap((tool) => tool.output.split("\n").filter((line) => line.startsWith("TOOL_HISTORY_")));
    expect(tools).toHaveLength(world.history.callCount);
    expect(new Set(tools.map((tool) => tool.callId)).size).toBe(world.history.callCount);
    expect(outputLines).toHaveLength(world.history.lineCount);
    expect(requests.filter((request) => request.kind === "tool")).toHaveLength(world.history.callCount);
    expect(requests.filter((request) => request.kind === "final")).toHaveLength(1);
    await user.see({ role: "button", label: /^Worked for / });
    await user.click({ role: "button", label: /^Worked for / });
    await user.see({ role: "button", label: "Ran 24 commands" });
    await user.click({ role: "button", label: "Ran 24 commands" });
    await user.see({ text: "Ran History command 1" });
    await user.see({ role: "button", label: "Show 16 more" });
    await user.click({ role: "button", label: "Show 16 more" }, { hitTest: true });
    await user.notSee({ role: "button", label: "Show 16 more" }, { timeoutMs: 2_000 });
    await user.press("End");
    await user.see({ text: "Ran History command 24" });
    console.info(`[TOOL-LONG] engine=${world.engine} surface=${world.surface} rootTurnsBeforeStop=1 rootCalls=${tools.length} outputLines=${outputLines.length} historyExpanded=24`);
    return { tools, requests };
  });

  const unrelatedBefore = await step("an unrelated conversation starts its own controlled native command", async () => {
    await open(world.other);
    await send(world.other.prompt);
    await probe.eventually(() => world.otherStarted(), { within: 45_000, label: "the unrelated command writes its started marker", until: Boolean });
    const tool = await probe.eventually(() => runningTool(world.other.sessionId, ".tool-long-other-release"), {
      within: 30_000,
      label: "the unrelated native tool remains running",
      until: (value) => value !== null,
    });
    expect(await world.active(world.other.sessionId)).toBe(true);
    expect(await world.otherFinished()).toBe(false);
    if (!tool) throw new Error("The unrelated controlled tool did not enter running state");
    return { tool, requests: await world.mock.agentRequests({ promptMarker: world.other.prompt }) };
  });

  await open(world.root);
  await send(world.root.prompt);
  await probe.eventually(() => world.rootStarted(), { within: 45_000, label: "the root command writes its started marker", until: Boolean });
  const rootTool = await probe.eventually(() => runningTool(world.root.sessionId, ".tool-long-root-release"), {
    within: 30_000,
    label: "the root native tool remains running after its completed partial tool",
    until: (value) => value !== null,
  });
  if (!rootTool) throw new Error("The controlled root tool did not enter running state");
  const rootBeforeStop = await world.transcript(world.root.sessionId);
  const rootToolsBeforeStop = toolFacts(rootBeforeStop);
  expect(rootToolsBeforeStop).toHaveLength(world.history.callCount + 2);
  for (const previous of historyBefore.tools) {
    expect(rootToolsBeforeStop.find((tool) => tool.callId === previous.callId)).toEqual(previous);
  }
  expect(rootToolsBeforeStop).toEqual(expect.arrayContaining([
    expect.objectContaining({ status: "completed", output: expect.stringContaining(world.root.partial) }),
    expect.objectContaining({ callId: rootTool.callId, status: "running" }),
  ]));
  const oldRootRequests = await world.mock.agentRequests({ promptMarker: world.root.prompt });
  expect(oldRootRequests.filter((request) => request.kind === "final")).toHaveLength(0);
  const directoryFacts = await world.directoryFacts(world.root.sessionId);

  await using activity = await world.observeRoot(rootTool.callId);
  const observations: { beforeSwitch?: ActivityObservation; afterReturn?: ActivityObservation; afterSilence?: ActivityObservation; afterReload?: ActivityObservation; afterStop?: ActivityObservation } = {};
  await step("continuous native and visible observations span switch-away and return", async () => {
    await probe.eventually(() => activity.read(), {
      within: 10_000,
      label: "the observer samples the active native root",
      until: (state) => state.nativeActiveSamples > 2,
    });
    observations.beforeSwitch = await activity.read();
    await open(world.other);
    expect(await world.active(world.root.sessionId)).toBe(true);
    expect(await world.active(world.other.sessionId)).toBe(true);
    await open(world.root);
    await probe.eventually(() => activity.read(), {
      within: 5_000,
      label: "the observer records the selected root after return",
      until: (state) => state.current.selected && state.returnSelectedMs !== null,
    });
    observations.afterReturn = await activity.read();
  });

  await step("the real native tool remains silent beyond the 60 second activity threshold", async () => {
    observations.afterSilence = await probe.eventually(() => activity.read(), {
      within: 75_000,
      label: "more than 60 seconds of native tool silence are observed",
      until: (state) => state.nativeActiveForMs > 61_000,
    });
    expect(await world.active(world.root.sessionId)).toBe(true);
    expect(await world.rootFinished()).toBe(false);
    expect(await world.active(world.other.sessionId)).toBe(true);
    expect(await world.otherFinished()).toBe(false);
    console.info(`[TOOL-LONG] >60s label=${JSON.stringify(observations.afterSilence.current.label)} activity=${observations.afterSilence.current.activity} animation=${observations.afterSilence.current.animationNames.join(",") || "none"} reducedMotion=${observations.afterSilence.current.reducedMotion}`);
    await user.screenshot();
  });

  await step("one reload rehydrates the same still-running native tool", async () => {
    await user.reload();
    await probe.eventually(() => world.active(world.root.sessionId), {
      within: 30_000,
      label: "the native root remains active through reload",
      until: Boolean,
    });
    observations.afterReload = await probe.eventually(() => activity.read(), {
      within: 15_000,
      label: "the reloaded document reaches visible activity or records two seconds without it",
      until: (state) => state.current.primaryActive || state.nativeActiveForMs > 2_000,
    });
    await user.type("composer", "Draft preserved across Stop", { verify: true, replace: true });
  });

  let stopObservationError: unknown;
  await step("Stop records immediate feedback and bounded native termination before cleanup assertions", async () => {
    await user.click({ role: "button", label: "Stop" });
    try {
      observations.afterStop = await probe.eventually(() => activity.read(), {
        within: 5_000,
        label: "root inactivity and the held tool's terminal state are both observed",
        until: (state) => state.rootInactiveMs !== null && state.ownerToolTerminalMs !== null,
      });
    } catch (error) {
      stopObservationError = error;
      observations.afterStop = await activity.read();
    }
    expect((await probe.composer()).draftText).toBe("Draft preserved across Stop");
    await world.releaseRoot();
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(await world.rootFinished()).toBe(false);
  });

  const terminal = await probe.eventually(() => world.transcript(world.root.sessionId), {
    within: 15_000,
    label: "the stopped root records its held native tool as terminal",
    until: (messages) => toolFacts(messages).some((tool) => tool.callId === rootTool.callId
      && !["pending", "running", "streaming"].includes(tool.status)),
  });
  expect(toolFacts(terminal)).toEqual(expect.arrayContaining([
    expect.objectContaining({ status: "completed", output: expect.stringContaining(world.root.partial) }),
    expect.objectContaining({ callId: rootTool.callId, status: expect.stringMatching(/^(completed|error|cancelled)$/) }),
  ]));
  const cancelledRoot = toolFacts(terminal).find((tool) => tool.callId === rootTool.callId);
  if (!cancelledRoot) throw new Error("The stopped root tool disappeared from native history");
  const rootSessionAfterStop = await world.session(world.root.sessionId);
  if (world.engine === "v1") {
    expect(cancelledRoot.cancelled).toBe(true);
    expect(cancelledRoot.output).toContain("User aborted the command");
  } else {
    expect(cancelledRoot.status).toBe("error");
    expect(rootSessionAfterStop.outcome).toBe("interrupted");
  }
  expect(terminal.map((message) => message.text).join("\n")).not.toContain(world.root.final);
  expect(await world.mock.agentRequests({ promptMarker: world.root.prompt })).toEqual(oldRootRequests);
  for (const previous of historyBefore.tools) {
    expect(toolFacts(terminal).find((tool) => tool.callId === previous.callId)).toEqual(previous);
  }
  expect(await world.mock.agentRequests({ promptMarker: world.history.prompt })).toEqual(historyBefore.requests);
  expect(await world.active(world.other.sessionId)).toBe(true);
  expect(await world.otherFinished()).toBe(false);
  expect(await world.mock.agentRequests({ promptMarker: world.other.prompt })).toEqual(unrelatedBefore.requests);

  let followupError: unknown;
  let followupFacts: { rootActive: boolean; requests: string[]; screen: string } | undefined;
  await step("fresh work is attempted once and the unrelated command completes only after its own release", async () => {
    await send(world.followup.prompt);
    try {
      await user.see({ text: world.followup.reply }, { timeoutMs: 15_000 });
    } catch (error) {
      followupError = error;
      followupFacts = {
        rootActive: await world.active(world.root.sessionId),
        requests: (await world.mock.agentRequests({ promptMarker: world.followup.prompt })).map((request) => request.kind),
        screen: (await probe.text()).slice(-4_000),
      };
      console.info(`[TOOL-LONG] followup blocked after confirmed native stop: ${JSON.stringify(followupFacts)}`);
      await user.screenshot();
      const cleanupStop = await probe.eval(() => Boolean(document.querySelector<HTMLButtonElement>('[data-workbench-pane="primary"] button[aria-label="Stop"]')));
      if (cleanupStop) await user.click({ role: "button", label: "Stop" });
    }
    await open(world.other);
    expect(await world.otherFinished()).toBe(false);
    await world.releaseOther();
    await user.see({ text: world.other.final }, { timeoutMs: 45_000 });
    await probe.eventually(() => world.otherFinished(), {
      within: 10_000,
      label: "the unrelated command writes its own completion marker",
      until: Boolean,
    });
    const otherTerminal = await world.transcript(world.other.sessionId);
    expect(toolFacts(otherTerminal)).toContainEqual(expect.objectContaining({ callId: unrelatedBefore.tool.callId, status: "completed" }));
    expect((await world.mock.agentRequests({ promptMarker: world.other.prompt })).filter((request) => request.kind === "final")).toHaveLength(1);
    expect(await world.rootFinished()).toBe(false);
    await user.screenshot();
  });

  await step("the retained timeline proves the visible primary and matching sidebar did not lose active state", async () => {
    const beforeSwitch = observations.beforeSwitch;
    const afterReturn = observations.afterReturn;
    const afterSilence = observations.afterSilence;
    const afterReload = observations.afterReload;
    const afterStop = observations.afterStop;
    if (!beforeSwitch || !afterReturn || !afterSilence || !afterReload || !afterStop) throw new Error("Activity observation phase is missing");
    for (const state of [beforeSwitch, afterReturn, afterSilence, afterReload]) {
      expect.soft(state.current.nativeActive).toBe(true);
      expect.soft(state.current.primaryVisible).toBe(true);
      expect.soft(state.current.primaryActive).toBe(true);
      expect.soft(state.current.primaryCount).toBe(1);
      expect.soft(state.current.sidebarVisible).toBe(true);
      expect.soft(state.current.stopEnabled).toBe(true);
      expect.soft(state.current.reducedMotion || state.current.activeAnimation).toBe(true);
      expect.soft(maxGap(state)).toBeLessThanOrEqual(200);
      expect.soft(maxSidebarGap(state)).toBeLessThanOrEqual(200);
      expect.soft(state.nativeErrors).toBe(0);
      expect.soft(state.nativePolls).toBeGreaterThan(1);
      expect.soft(state.current.nativeFresh).toBe(true);
      expect.soft(state.nativeConfirmationAgeMs).not.toBeNull();
      expect.soft(state.maxNativeConfirmationGapMs).toBeLessThanOrEqual(1_000);
    }
    expect.soft(stopObservationError).toBeUndefined();
    expect.soft(afterReturn.returnActionCaptured).toBe(true);
    expect.soft(afterReturn.returnSelectedMs).toBeLessThanOrEqual(500);
    expect.soft(afterReturn.returnActivityMs).toBeLessThanOrEqual(500);
    expect.soft(afterSilence.nativeActiveForMs).toBeGreaterThan(60_000);
    expect.soft(afterSilence.nativePolls).toBeGreaterThan(250);
    expect.soft(afterSilence.current.activity).toBe("running");
    expect.soft(afterSilence.current.label).toContain(".tool-long-root-release");
    expect.soft(afterStop.stopActionCaptured).toBe(true);
    expect.soft(afterStop.stopFeedbackMs).toBeLessThan(100);
    expect.soft(afterStop.rootInactiveMs).toBeLessThanOrEqual(500);
    expect.soft(afterStop.ownerToolTerminalMs).toBeLessThanOrEqual(500);
    expect.soft(afterStop.nativePollIntervalMs).toBe(25);
    expect.soft(afterStop.nativeErrors).toBe(0);
    expect.soft(afterStop.current.nativeActive).toBe(false);
    expect.soft(afterStop.current.primaryActive).toBe(false);
    expect.soft(afterStop.current.activeAnimation).toBe(false);
    expect.soft(afterStop.current.stopEnabled).toBe(false);
    expect.soft(followupError).toBeUndefined();
    expect.soft((await world.mock.agentRequests({ promptMarker: world.followup.prompt })).map((request) => request.kind)).toEqual(["final"]);
    evidence.recordJsonArtifact("TOOL-LONG native and UI timeline", {
      engine: world.engine,
      surface: world.surface,
      rootTurnsBeforeStop: 2,
      rootCallsBeforeStop: rootToolsBeforeStop.length,
      historyCalls: world.history.callCount,
      historyOutputLines: world.history.lineCount,
      rootToolCallId: rootTool.callId,
      directoryFacts,
      beforeSwitch,
      afterReturn,
      afterSilence,
      afterReload,
      afterStop,
      stoppedTranscript: terminal,
      rootSessionAfterStop,
      followupFacts,
    });
    console.info(`[TOOL-LONG] rootTurnsBeforeStop=2 rootCallsBeforeStop=${rootToolsBeforeStop.length} stop feedback=${afterStop.stopFeedbackMs}ms rootInactive=${afterStop.rootInactiveMs}ms toolTerminal=${afterStop.ownerToolTerminalMs}ms nativePolls=${afterSilence.nativePolls} maxNativeGap=${afterSilence.maxNativeConfirmationGapMs}ms maxPrimaryGap=${Math.max(...[beforeSwitch, afterReturn, afterSilence, afterReload].map(maxGap))}ms maxSidebarGap=${Math.max(...[beforeSwitch, afterReturn, afterSilence, afterReload].map(maxSidebarGap))}ms`);
  });
});
