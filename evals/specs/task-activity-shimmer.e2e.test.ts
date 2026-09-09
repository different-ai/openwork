import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { taskActivity } from "../worlds/chat.ts";
import { liveChildActivity, type ActivityObservation } from "../worlds/tool-activity.ts";

const test = spec.world(taskActivity);
const liveChildTest = spec.world(liveChildActivity, { timeout: 360_000 });

test("delegated-task activity stays with its original message after a follow-up", async ({ user, probe }) => {
  await user.see({ text: "Build isolated Azure repro" });
  await user.see({ text: "What is the update?" });
  // TODO(primitive): inspect the visual treatment classes on a delegated-task status row.
  const rendered = await probe.eval(() => {
    const row = document.querySelector<HTMLElement>('[data-subagent-activity="shimmer"]');
    const original = document.querySelector<HTMLElement>('[data-message-id$=":eval-subagent-assistant"]');
    const followup = document.querySelector<HTMLElement>('[data-message-id$=":eval-subagent-followup"]');
    return {
      text: row instanceof HTMLElement ? row.innerText.replace(/\s+/g, " ").trim() : "",
      hasSpinner: Boolean(row?.querySelector<HTMLElement>(".animate-spin")),
      hasShimmer: Boolean(row?.querySelector<HTMLElement>(".ow-text-shimmer")),
      liveCards: document.querySelectorAll('[data-subagent-run="eval-subagent-activity"]').length,
      historyEntries: document.querySelectorAll('[data-subagent-history="eval-subagent-activity"]').length,
      carriedSummaries: document.querySelectorAll('[data-testid="active-subagents"]').length,
      staysWithOriginalMessage: Boolean(row && original?.contains(row)),
      precedesFollowup: Boolean(row && followup && (row.compareDocumentPosition(followup) & Node.DOCUMENT_POSITION_FOLLOWING)),
      rawPromptVisible: document.body.innerText.includes("Reproduce the Azure failure in isolation."),
    };
  });
  expect(rendered).toMatchObject({
    text: expect.stringMatching(/Build isolated Azure repro.*Working/),
    hasSpinner: false,
    hasShimmer: true,
    liveCards: 1,
    historyEntries: 0,
    carriedSummaries: 0,
    staysWithOriginalMessage: true,
    precedesFollowup: true,
    rawPromptVisible: false,
  });
});

liveChildTest("CHILD-LIVE keeps a real silent foreground child visibly active and scopes Stop to its parent tree", { timeout: 360_000 }, async ({ world, user, probe, step, evidence }) => {
  user = user.on(world.app);
  probe = probe.on(world.app);
  const send = async (prompt: string) => {
    await user.type("composer", prompt, { verify: true, replace: true });
    await user.press("Enter");
  };
  const open = async (session: { title: string; sessionId: string }) => {
    await user.click({ text: session.title });
    await probe.eventually(() => world.selected(session.sessionId), {
      within: 30_000,
      label: `${session.title} is selected`,
      until: Boolean,
    });
  };
  const tools = (messages: Awaited<ReturnType<typeof world.transcript>>) => messages.flatMap((message) => message.tools);
  const maxGap = (state: ActivityObservation) => Math.max(
    state.primaryMissingMaxMs, state.primaryMissingCurrentMs,
    ...state.primaryMissingIntervals.map((gap) => gap.durationMs),
  );
  const maxSidebarGap = (state: ActivityObservation) => Math.max(
    state.sidebarMissingMaxMs, state.sidebarMissingCurrentMs,
    ...state.sidebarMissingIntervals.map((gap) => gap.durationMs),
  );
  const runtime = world.runtimeFacts();
  if (runtime.surface === "web" && runtime.hostKind === "daytona") expect(runtime.actualSourceSha).toMatch(/^[0-9a-f]{40,64}$/);
  else if (runtime.actualSourceSha !== null) expect(runtime.actualSourceSha).toMatch(/^[0-9a-f]{40,64}$/);

  const unrelatedBefore = await step("an unrelated root owns a separate controlled native command", async () => {
    await open(world.other);
    await send(world.other.prompt);
    await probe.eventually(() => world.otherStarted(), {
      within: 45_000,
      label: "the unrelated root writes its started marker",
      until: Boolean,
    });
    const tool = await probe.eventually(async () => tools(await world.transcript(world.other.sessionId))
      .find((part) => part.status === "running" && part.input.includes(".child-live-other-release")) ?? null, {
      within: 30_000,
      label: "the unrelated root tool is natively running",
      until: (value) => value !== null,
    });
    if (!tool) throw new Error("The unrelated child control did not enter running state");
    expect(await world.active(world.other.sessionId)).toBe(true);
    expect(await world.otherFinished()).toBe(false);
    return { tool, requests: await world.mock.agentRequests({ promptMarker: world.other.prompt }) };
  });

  await open(world.root);
  await send(world.root.prompt);
  const delegation = await probe.eventually(async () => tools(await world.transcript(world.root.sessionId))
    .find((part) => part.name === world.delegation && part.status === "running") ?? null, {
    within: 45_000,
    label: "the parent owns a real running foreground delegation",
    until: (value) => value !== null,
  });
  if (!delegation) throw new Error("The foreground delegation did not enter running state");
  const childCandidates = await probe.eventually(() => world.childCandidates(), {
    within: 30_000,
    label: "one native active session has the requested parent and workspace",
    until: (candidates) => candidates.length === 1,
  });
  expect(childCandidates).toHaveLength(1);
  const childSessionId = childCandidates[0]?.id;
  if (!childSessionId) throw new Error("The native engine did not expose the foreground child relationship");
  const [rootOwner, childOwner] = await Promise.all([world.session(world.root.sessionId), world.session(childSessionId)]);
  expect(rootOwner.parentId).toBe("");
  expect(childOwner.id).toBe(childSessionId);
  expect(childOwner.parentId).toBe(world.root.sessionId);
  expect(childOwner.workspace).toBe(rootOwner.workspace);
  await probe.eventually(() => world.childStarted(), {
    within: 60_000,
    label: "the real child finishes its quick tools and starts its held tool",
    until: Boolean,
  });
  const childHeld = await probe.eventually(async () => tools(await world.transcript(childSessionId))
    .find((part) => part.status === "running" && part.input.includes(".child-live-release")) ?? null, {
    within: 30_000,
    label: "the child held tool is natively running",
    until: (value) => value !== null,
  });
  if (!childHeld) throw new Error("The controlled child tool did not enter running state");
  const childBeforeStop = await world.transcript(childSessionId);
  const childToolsBeforeStop = tools(childBeforeStop);
  const quickTools = childToolsBeforeStop.filter((part) => part.callId !== childHeld.callId);
  const outputLines = quickTools.flatMap((part) => part.output.split("\n").filter((line) => line.startsWith("CHILD_LIVE_")));
  expect(quickTools).toHaveLength(world.child.quickCalls);
  expect(outputLines).toHaveLength(world.child.outputLines);
  expect(new Set(childToolsBeforeStop.map((part) => part.callId)).size).toBe(world.child.quickCalls + 1);
  expect(await world.active(world.root.sessionId)).toBe(true);
  expect(await world.active(childSessionId)).toBe(true);
  const rootRequestsBeforeStop = await world.mock.agentRequests({ promptMarker: world.root.prompt });
  const childRequestsBeforeStop = await world.mock.agentRequests({ promptMarker: world.child.prompt });
  expect(rootRequestsBeforeStop.filter((request) => request.kind === "tool")).toHaveLength(1);
  expect(childRequestsBeforeStop.filter((request) => request.kind === "tool")).toHaveLength(world.child.quickCalls + 1);
  console.info(`[CHILD-LIVE] engine=${world.engine} surface=${world.surface} child=${childSessionId} parent=${world.root.sessionId} childCalls=${childToolsBeforeStop.length} outputLines=${outputLines.length}`);
  let nativeElapsedBeforeReload: number | null = null;
  let nativeElapsedAfterReload: number | null = null;
  let reloadedChildToolStartedAt: number | null = null;

  await using activity = await world.observeChild(childSessionId, childHeld.callId, delegation.callId);
  const observations: { beforeSwitch?: ActivityObservation; afterReturn?: ActivityObservation; afterSilence?: ActivityObservation; afterReload?: ActivityObservation; afterStop?: ActivityObservation } = {};
  await step("the original child card remains owner-scoped across switch-away and return", async () => {
    observations.beforeSwitch = await probe.eventually(() => activity.read(), {
      within: 10_000,
      label: "the observer receives two fresh native confirmations for the active child",
      until: (state) => state.nativePolls >= 2 && state.current.nativeFresh && state.current.nativeActive,
    });
    await open(world.other);
    expect(await world.active(world.root.sessionId)).toBe(true);
    expect(await world.active(childSessionId)).toBe(true);
    expect(await world.active(world.other.sessionId)).toBe(true);
    await open(world.root);
    observations.afterReturn = await probe.eventually(() => activity.read(), {
      within: 5_000,
      label: "the original child card returns with the same native relationship",
      until: (state) => state.current.selected && state.returnSelectedMs !== null,
    });
  });

  await step("the child stays natively and visibly active through more than 60 seconds without tool progress", async () => {
    observations.afterSilence = await probe.eventually(() => activity.read(), {
      within: 75_000,
      label: "more than 60 seconds of silent foreground-child work are observed",
      until: (state) => state.nativeActiveForMs > 61_000,
    });
    expect(await world.active(world.root.sessionId)).toBe(true);
    expect(await world.active(childSessionId)).toBe(true);
    expect(await world.childFinished()).toBe(false);
    expect(await world.active(world.other.sessionId)).toBe(true);
    nativeElapsedBeforeReload = childHeld.startedAt === null ? null : Date.now() - childHeld.startedAt;
    console.info(`[CHILD-LIVE] >60s label=${JSON.stringify(observations.afterSilence.current.label)} activity=${observations.afterSilence.current.activity} animation=${observations.afterSilence.current.animationNames.join(",") || "none"} reducedMotion=${observations.afterSilence.current.reducedMotion}`);
    await user.screenshot();
  });

  await step("reload rehydrates one copy of the same running child card without resetting its native age", async () => {
    await user.reload();
    await probe.eventually(async () => await world.active(world.root.sessionId) && await world.active(childSessionId), {
      within: 30_000,
      label: "the root and child remain natively active after reload",
      until: Boolean,
    });
    observations.afterReload = await probe.eventually(() => activity.read(), {
      within: 15_000,
      label: "the child card reappears or two seconds of its absence are recorded",
      until: (state) => state.current.primaryActive || state.nativeActiveForMs > 2_000,
    });
    const reloadedChildTool = tools(await world.transcript(childSessionId)).find((part) => part.callId === childHeld.callId);
    reloadedChildToolStartedAt = reloadedChildTool?.startedAt ?? null;
    nativeElapsedAfterReload = reloadedChildToolStartedAt === null ? null : Date.now() - reloadedChildToolStartedAt;
    await user.type("composer", "Parent draft preserved across child Stop", { verify: true, replace: true });
  });

  let stopObservationError: unknown;
  await step("Stop from the parent records bounded root and child termination before release", async () => {
    await user.click({ role: "button", label: "Stop" });
    try {
      observations.afterStop = await probe.eventually(() => activity.read(), {
        within: 5_000,
        label: "Stopping feedback, native parent-child termination, and the later static UI are observed",
        until: (state) => state.stopFeedbackMs !== null && state.rootInactiveMs !== null
          && state.ownerToolTerminalMs !== null && state.parentToolTerminalMs !== null
          && state.uiSettledAfterNativeMs !== null,
      });
    } catch (error) {
      stopObservationError = error;
      observations.afterStop = await activity.read();
    }
    expect((await probe.composer()).draftText).toBe("Parent draft preserved across child Stop");
    await world.releaseChild();
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(await world.childFinished()).toBe(false);
  });

  const childTerminal = await probe.eventually(() => world.transcript(childSessionId), {
    within: 15_000,
    label: "the held child tool retains a terminal native state",
    until: (messages) => tools(messages).some((part) => part.callId === childHeld.callId
      && !["pending", "running", "streaming"].includes(part.status)),
  });
  const parentTerminal = await probe.eventually(() => world.transcript(world.root.sessionId), {
    within: 15_000,
    label: "the parent delegation remains terminal after Stop",
    until: (messages) => tools(messages).some((part) => part.callId === delegation.callId
      && !["pending", "running", "streaming"].includes(part.status)),
  });
  const terminalDelegation = tools(parentTerminal).find((part) => part.callId === delegation.callId);
  const terminalChildTool = tools(childTerminal).find((part) => part.callId === childHeld.callId);
  if (!terminalDelegation || !terminalChildTool) throw new Error("Terminal parent/child tool identity was not retained");
  const [rootSessionAfterStop, childSessionAfterStop] = await Promise.all([
    world.session(world.root.sessionId), world.session(childSessionId),
  ]);
  if (world.engine === "v1") {
    expect(terminalChildTool.cancelled).toBe(true);
    expect(terminalDelegation.cancelled).toBe(true);
  } else {
    expect(rootSessionAfterStop.outcome).toBe("interrupted");
    expect(childSessionAfterStop.outcome).toBe("interrupted");
  }
  expect(await world.active(world.root.sessionId)).toBe(false);
  expect(await world.active(childSessionId)).toBe(false);
  expect(await world.active(world.other.sessionId)).toBe(true);
  expect(await world.otherFinished()).toBe(false);
  expect(await world.mock.agentRequests({ promptMarker: world.root.prompt })).toEqual(rootRequestsBeforeStop);
  expect(await world.mock.agentRequests({ promptMarker: world.child.prompt })).toEqual(childRequestsBeforeStop);
  for (const quickTool of quickTools) {
    expect(tools(childTerminal).find((part) => part.callId === quickTool.callId)).toEqual(quickTool);
  }

  let followupError: unknown;
  let followupFacts: { rootActive: boolean; requests: string[]; screen: string } | undefined;
  await using followupAdmission = await world.observePromptPosts(world.root.sessionId);
  await step("fresh parent work is attempted once while the unrelated root remains releasable", async () => {
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
      console.info(`[CHILD-LIVE] followup blocked after native child stop: ${JSON.stringify(followupFacts)}`);
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
      label: "the unrelated root completes after only its own release",
      until: Boolean,
    });
    expect(tools(await world.transcript(world.other.sessionId))).toContainEqual(expect.objectContaining({
      callId: unrelatedBefore.tool.callId,
      status: "completed",
      cancelled: false,
    }));
    expect((await world.mock.agentRequests({ promptMarker: world.other.prompt })).filter((request) => request.kind === "final")).toHaveLength(1);
    expect(await world.childFinished()).toBe(false);
    await user.screenshot();
  });

  await step("the timeline proves meaningful quiet activity, stable identity, and terminal static state", async () => {
    const beforeSwitch = observations.beforeSwitch;
    const afterReturn = observations.afterReturn;
    const afterSilence = observations.afterSilence;
    const afterReload = observations.afterReload;
    const afterStop = observations.afterStop;
    if (!beforeSwitch || !afterReturn || !afterSilence || !afterReload || !afterStop) throw new Error("Child activity observation phase is missing");
    const followupRequests = await world.mock.agentRequests({ promptMarker: world.followup.prompt });
    const followupFinalRequests = followupRequests.filter((request) => request.kind === "final");
    const followupUtilityRequests = followupRequests.filter((request) => request.kind === "utility");
    const followupUnexpectedRequests = followupRequests.filter((request) => request.kind === "error" || request.kind === "tool");
    const followupPromptPosts = await followupAdmission.read();
    evidence.recordJsonArtifact("CHILD-LIVE native and UI timeline", {
      engine: world.engine,
      surface: world.surface,
      childSessionId,
      parentSessionId: world.root.sessionId,
      delegationCallId: delegation.callId,
      childHeldCallId: childHeld.callId,
      childCalls: childToolsBeforeStop.length,
      outputLines: world.child.outputLines,
      rootSessionBeforeStop: rootOwner.raw,
      childSessionBeforeStop: childOwner.raw,
      nativeToolStartedAt: childHeld.startedAt,
      reloadedChildToolStartedAt,
      nativeElapsedBeforeReload,
      nativeElapsedAfterReload,
      beforeSwitch,
      afterReturn,
      afterSilence,
      afterReload,
      afterStop,
      stopPollResolutionMs: afterStop.nativePollIntervalMs,
      rootSessionAfterStop,
      childSessionAfterStop,
      terminalDelegation,
      terminalChildTool,
      followupFacts,
      followupAdmission: followupPromptPosts,
      followupProviderRequests: {
        final: followupFinalRequests,
        utility: followupUtilityRequests,
        unexpected: followupUnexpectedRequests,
      },
    });
    for (const state of [beforeSwitch, afterReturn, afterSilence, afterReload]) {
      expect.soft(state.current.nativeActive).toBe(true);
      expect.soft(state.current.primaryVisible).toBe(true);
      expect.soft(state.current.primaryActive).toBe(true);
      expect.soft(state.current.primaryCount).toBe(1);
      expect.soft(state.current.sidebarVisible).toBe(true);
      expect.soft(state.current.stopEnabled).toBe(true);
      expect.soft(maxGap(state)).toBeLessThanOrEqual(200);
      expect.soft(maxSidebarGap(state)).toBeLessThanOrEqual(200);
      expect.soft(state.nativeErrors).toBe(0);
      expect.soft(state.nativePolls).toBeGreaterThan(1);
      expect.soft(state.current.nativeFresh).toBe(true);
      expect.soft(state.nativeConfirmationAgeMs).not.toBeNull();
      expect.soft(state.maxNativeConfirmationGapMs).toBeLessThanOrEqual(1_000);
      expect.soft(state.current.childSessionId).toBe(childSessionId);
      expect.soft(state.current.childSessionMatches).toBe(true);
    }
    expect.soft(beforeSwitch.current.reducedMotion || beforeSwitch.current.activeAnimation).toBe(true);
    expect.soft(afterReturn.returnActionCaptured).toBe(true);
    expect.soft(afterReturn.returnSelectedMs).toBeLessThanOrEqual(500);
    expect.soft(afterReturn.returnActivityMs).toBeLessThanOrEqual(500);
    expect.soft(afterSilence.nativeActiveForMs).toBeGreaterThan(60_000);
    expect.soft(afterSilence.nativePolls).toBeGreaterThan(250);
    expect.soft(childHeld.startedAt).not.toBeNull();
    expect.soft(nativeElapsedBeforeReload).not.toBeNull();
    if (nativeElapsedBeforeReload !== null) expect.soft(nativeElapsedBeforeReload).toBeGreaterThan(60_000);
    for (const quiet of [afterSilence, afterReload]) {
      expect.soft(quiet.current.activity).toBe("no-new-activity");
      expect.soft(quiet.current.label).toContain(world.child.title);
      expect.soft(quiet.current.label).toContain("Still working — waiting for updates");
      expect.soft(quiet.current.label).not.toMatch(/(?:completed|failed|stopped|interrupted)/i);
      expect.soft(quiet.current.label).not.toContain("Waiting for task update");
      expect.soft(quiet.current.label).not.toContain("Working 0s");
    }
    expect.soft(reloadedChildToolStartedAt).toBe(childHeld.startedAt);
    expect.soft(nativeElapsedAfterReload).not.toBeNull();
    if (nativeElapsedAfterReload !== null) expect.soft(nativeElapsedAfterReload).toBeGreaterThan(60_000);
    expect.soft(stopObservationError).toBeUndefined();
    expect.soft(afterStop.stopActionCaptured).toBe(true);
    expect.soft(afterStop.stoppingSeen).toBe(true);
    expect.soft(afterStop.stopFeedbackMs).toBeLessThan(100);
    expect.soft(afterStop.rootInactiveMs).toBeLessThanOrEqual(500);
    expect.soft(afterStop.ownerToolTerminalMs).toBeLessThanOrEqual(500);
    expect.soft(afterStop.parentToolTerminalMs).not.toBeNull();
    expect.soft(afterStop.parentToolTerminalMs).toBeLessThanOrEqual(500);
    expect.soft(afterStop.nativeSettledMs).toBeLessThanOrEqual(500);
    expect.soft(afterStop.uiSettledAfterNativeMs).toBeLessThanOrEqual(200);
    expect.soft(afterStop.nativePollIntervalMs).toBe(25);
    expect.soft(afterStop.nativeErrors).toBe(0);
    expect.soft(afterStop.current.nativeActive).toBe(false);
    expect.soft(afterStop.current.primaryActive).toBe(false);
    expect.soft(afterStop.current.activeAnimation).toBe(false);
    expect.soft(afterStop.current.stopEnabled).toBe(false);
    expect.soft(afterStop.current.stoppingVisible).toBe(false);
    expect.soft(followupError).toBeUndefined();
    expect.soft(followupPromptPosts).toMatchObject({ sessionId: world.root.sessionId, posts: 1 });
    expect.soft(followupFinalRequests).toHaveLength(1);
    expect.soft(followupFinalRequests[0]).toMatchObject({ promptMarker: world.followup.prompt, kind: "final" });
    expect.soft(followupUnexpectedRequests).toEqual([]);
    console.info(`[CHILD-LIVE] stop feedback=${afterStop.stopFeedbackMs}ms rootInactive=${afterStop.rootInactiveMs}ms childToolTerminal=${afterStop.ownerToolTerminalMs}ms parentTerminal=${afterStop.parentToolTerminalMs}ms stopPollResolution=${afterStop.nativePollIntervalMs}ms nativePolls=${afterSilence.nativePolls} maxNativeGap=${afterSilence.maxNativeConfirmationGapMs}ms maxPrimaryGap=${Math.max(...[beforeSwitch, afterReturn, afterSilence, afterReload].map(maxGap))}ms maxSidebarGap=${Math.max(...[beforeSwitch, afterReturn, afterSilence, afterReload].map(maxSidebarGap))}ms`);
  });
});
