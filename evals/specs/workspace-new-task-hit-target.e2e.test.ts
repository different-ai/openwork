import { browserScript } from "@openwork/testkit";
import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { workspaceNewTask } from "../worlds/session-shell.ts";

const sampleCount = 12;
const newTaskLimitMs = 500;
const sendLimitMs = 100;
const boundaryHoldMs = 1_500;
const test = spec.world(workspaceNewTask, { timeout: 900_000 });

type TimingSample = {
  index: number;
  elapsedMs: number | null;
  trusted: boolean;
  frames: number;
  mutations: number;
  consecutiveFrames: number;
  beforeEngine: boolean;
  firstHoldMs: number;
  secondHoldMs: number;
  firstHeldCount: number;
  secondHeldCount: number;
  exact: boolean;
  typedWithoutClick: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function occurrences(text: string, marker: string): number {
  return marker ? text.split(marker).length - 1 : 0;
}

function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null;
}

function timingReport(samples: readonly TimingSample[]) {
  const completed = samples.flatMap((sample) => sample.elapsedMs === null ? [] : [sample.elapsedMs]);
  const value = (number: number | null) => number === null ? null : round(number);
  return {
    count: samples.length,
    failures: samples.filter((sample) => sample.elapsedMs === null).map((sample) => sample.index),
    p50Ms: value(percentile(completed, 0.5)),
    p95Ms: value(percentile(completed, 0.95)),
    maxMs: value(completed.length === 0 ? null : Math.max(...completed)),
    samples: samples.map((sample) => ({
      i: sample.index,
      ms: value(sample.elapsedMs),
      beforeEngine: sample.beforeEngine,
      holds: [{ count: sample.firstHeldCount, ms: round(sample.firstHoldMs) }, { count: sample.secondHeldCount, ms: round(sample.secondHoldMs) }],
      trusted: sample.trusted,
      frames: sample.frames,
      consecutiveFrames: sample.consecutiveFrames,
      mutations: sample.mutations,
      exact: sample.exact,
      typedWithoutClick: sample.typedWithoutClick,
    })),
  };
}

test("workspace New task is instantly typable and every v1 send paints before engine work", async ({ world, user, agent, probe, step, evidence }) => {
  await using faults = world.boundary;
  const newTaskSamples: TimingSample[] = [];
  const lazySendSamples: TimingSample[] = [];
  const existingSendSamples: TimingSample[] = [];
  const typingDiagnostics: { index: number; beforeText: string; afterText: string }[] = [];
  let lastFaultCounts = { creation: 0, prompt: 0 };
  let expectedSessionId: string | null = world.existing.sessionId;
  const negatives = {
    rapidDuplicateEnter: false,
    successDraftB: false,
    creationFailureComposerReady: false,
    creationFailureARecoverable: false,
    creationFailureDraftBSurvives: false,
    creationFailureNoFallbackSession: false,
    promptFailureComposerReady: false,
    promptFailureARecoverable: false,
    promptFailureDraftBSurvives: false,
    promptFailureNoFallbackSession: false,
    navigationIsolation: false,
    responseSseReconciliation: false,
    exactAfterReload: false,
  };

  const activeSessionId = () => probe.eval(browserScript((workspaceId) => {
    if ((localStorage.getItem("openwork.react.activeWorkspace") ?? "") !== workspaceId) return "";
    const persistedPrefix = `#/workspace/${workspaceId}/session/`;
    if (!location.hash.startsWith(persistedPrefix)) return "";
    const sessionId = location.hash.slice(persistedPrefix.length);
    if (!sessionId.startsWith("ses_") || /[/?#]/.test(sessionId)) return "";
    const visible = (node: HTMLElement) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return node.getClientRects().length > 0 && rect.width > 0 && rect.height > 0
        && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight
        && style.display !== "none" && style.visibility !== "hidden";
    };
    const pane = [...document.querySelectorAll<HTMLElement>('[data-workbench-pane="primary"]')].find(visible);
    const ownsRoute = [...(pane?.querySelectorAll<HTMLElement>("[data-session-surface-id]") ?? [])]
      .some((surface) => surface.dataset.sessionSurfaceId === sessionId && visible(surface));
    return ownsRoute ? sessionId : "";
  }, [world.workspace.workspaceId]));
  const openSession = async (session: { sessionId: string }) => {
    expectedSessionId = session.sessionId;
    // Untimed setup navigation uses the client boundary; pointer navigation is a separate journey.
    if (await activeSessionId() !== session.sessionId) await agent.run("session.open", { sessionId: session.sessionId });
    await probe.eventually(activeSessionId, {
      within: 30_000,
      label: `session ${session.sessionId} owns the primary pane`,
      until: (sessionId) => sessionId === session.sessionId,
    });
  };
  const expanded = () => probe.eval(browserScript((workspaceId) => document
    .querySelector<HTMLElement>(`[data-sidebar-workspace-id="${workspaceId}"] [data-workspace-new-task]`)
    ?.closest("[data-workspace-actions]")?.parentElement
    ?.querySelector<HTMLElement>("[aria-expanded]")?.getAttribute("aria-expanded") ?? null, [world.workspace.workspaceId]));
  const visibleFacts = (marker: string) => probe.eval(browserScript((marker, workspaceId) => {
    const visible = (node: HTMLElement) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return node.getClientRects().length > 0 && rect.width > 0 && rect.height > 0
        && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight
        && style.display !== "none" && style.visibility !== "hidden";
    };
    let root: HTMLElement | null = null;
    if ((localStorage.getItem("openwork.react.activeWorkspace") ?? "") === workspaceId) {
      const sessionlessRoute = `#/workspace/${workspaceId}/session`;
      if (location.hash === sessionlessRoute) {
        const heading = [...document.querySelectorAll<HTMLElement>("h2")]
          .find((candidate) => candidate.textContent?.trim() === "What do you need done?" && visible(candidate));
        const headingMain = heading?.closest<HTMLElement>("main") ?? null;
        const main = headingMain && visible(headingMain) ? headingMain
          : [...document.querySelectorAll<HTMLElement>("main")].filter(visible)
              .find((candidate) => [...candidate.querySelectorAll<HTMLElement>('[contenteditable="true"][data-lexical-editor="true"], [data-message-role]')]
                .some(visible)) ?? null;
        const persistedSurfaceVisible = [...document.querySelectorAll<HTMLElement>("[data-session-surface-id]")].some(visible);
        if (main && !persistedSurfaceVisible) root = main;
      } else {
        const persistedPrefix = `#/workspace/${workspaceId}/session/`;
        const sessionId = location.hash.startsWith(persistedPrefix) ? location.hash.slice(persistedPrefix.length) : "";
        if (sessionId.startsWith("ses_") && !/[/?#]/.test(sessionId)) {
          const pane = [...document.querySelectorAll<HTMLElement>('[data-workbench-pane="primary"]')].find(visible) ?? null;
          const surface = [...(pane?.querySelectorAll<HTMLElement>("[data-session-surface-id]") ?? [])]
            .find((candidate) => candidate.dataset.sessionSurfaceId === sessionId && visible(candidate));
          if (pane && surface) root = pane;
        }
      }
    }
    const editor = root?.querySelector<HTMLElement>('[contenteditable="true"][data-lexical-editor="true"]');
    const rows = [...(root?.querySelectorAll<HTMLElement>('[data-message-role="user"]') ?? [])]
      .filter((row) => visible(row) && row.innerText.includes(marker)
        && !(editor && (editor.contains(row) || row.contains(editor))));
    const rawComposerText = editor?.innerText ?? "";
    return {
      rowCount: rows.length,
      markerOccurrences: marker ? rows.reduce((total, row) => total + row.innerText.split(marker).length - 1, 0) : 0,
      starting: [...(root?.querySelectorAll<HTMLElement>('[data-loading-message="starting"]') ?? [])]
        .filter(visible).map((node) => ({ role: node.getAttribute("role"), text: node.innerText.trim() })),
      workingCount: [...(root?.querySelectorAll<HTMLElement>('[data-loading-message="working"]') ?? [])].filter(visible).length,
      composerText: /^\s*$/.test(rawComposerText) ? "" : rawComposerText,
      composerEditable: Boolean(editor?.isContentEditable),
      focusedEditor: Boolean(editor && (document.activeElement === editor || editor.contains(document.activeElement))),
      sessionId: root?.querySelector<HTMLElement>("[data-session-surface-id]")?.dataset.sessionSurfaceId ?? "",
      route: location.hash,
    };
  }, [marker, world.workspace.workspaceId]));
  const surfaceContains = (text: string) => probe.eval(browserScript((text, workspaceId) => {
    const visible = (node: HTMLElement) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return node.getClientRects().length > 0 && rect.width > 0 && rect.height > 0
        && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight
        && style.display !== "none" && style.visibility !== "hidden";
    };
    if ((localStorage.getItem("openwork.react.activeWorkspace") ?? "") !== workspaceId) return false;
    let root: HTMLElement | null = null;
    const sessionlessRoute = `#/workspace/${workspaceId}/session`;
    if (location.hash === sessionlessRoute) {
      const heading = [...document.querySelectorAll<HTMLElement>("h2")]
        .find((candidate) => candidate.textContent?.trim() === "What do you need done?" && visible(candidate));
      const headingMain = heading?.closest<HTMLElement>("main") ?? null;
      const main = headingMain && visible(headingMain) ? headingMain
        : [...document.querySelectorAll<HTMLElement>("main")].filter(visible)
            .find((candidate) => [...candidate.querySelectorAll<HTMLElement>('[contenteditable="true"][data-lexical-editor="true"], [data-message-role]')]
              .some(visible)) ?? null;
      const persistedSurfaceVisible = [...document.querySelectorAll<HTMLElement>("[data-session-surface-id]")].some(visible);
      if (main && !persistedSurfaceVisible) root = main;
    } else {
      const persistedPrefix = `#/workspace/${workspaceId}/session/`;
      const sessionId = location.hash.startsWith(persistedPrefix) ? location.hash.slice(persistedPrefix.length) : "";
      if (sessionId.startsWith("ses_") && !/[/?#]/.test(sessionId)) {
        const pane = [...document.querySelectorAll<HTMLElement>('[data-workbench-pane="primary"]')].find(visible) ?? null;
        const surface = [...(pane?.querySelectorAll<HTMLElement>("[data-session-surface-id]") ?? [])]
          .find((candidate) => candidate.dataset.sessionSurfaceId === sessionId && visible(candidate));
        if (pane && surface) root = pane;
      }
    }
    return root?.innerText.includes(text) ?? false;
  }, [text, world.workspace.workspaceId]));
  const accessibleRunTask = (expectedText: string, label: string) => probe.eventually(() => world.accessibleRunTaskReady(expectedText), {
    within: 15_000,
    label,
    until: (state) => state.ready,
  });
  const waitReply = (reply: string) => probe.eventually(async () => ({
    visible: await surfaceContains(reply),
    starting: (await visibleFacts(reply)).starting,
  }), {
    within: 60_000,
    label: `the deterministic v1 reply ${reply.slice(0, 32)} is visible without Starting`,
    until: (facts) => facts.visible && facts.starting.length === 0,
  });
  const waitBackendMarker = (sessionId: string, marker: string) => probe.eventually(() => world.messageFacts(sessionId, marker), {
    within: 30_000,
    label: `the real v1 transcript contains one ${marker.slice(0, 32)} turn`,
    until: (facts) => facts.markerOccurrences > 0,
  });
  const readFaults = () => {
    lastFaultCounts = faults.read();
    return lastFaultCounts;
  };
  type Gate = ReturnType<typeof faults.holdNext>;
  const waitHeld = (gate: Gate) => probe.eventually(() => gate.read(), {
    within: 20_000,
    label: `${gate.read().kind} ${gate.read().stage} is held for ${boundaryHoldMs} ms`,
    until: (state) => state.held > 0 && state.elapsedMs >= boundaryHoldMs,
  });
  type RendererObserver = Awaited<ReturnType<typeof world.observeRenderer>>;
  const waitRenderer = (observer: RendererObserver) => probe.eventually(() => observer.read(), {
    within: 12_000,
    label: "two consecutive renderer frames observe the target",
    until: (state) => state.elapsedMs !== null || state.expired,
  });
  const sample = (
    index: number,
    state: Awaited<ReturnType<RendererObserver["read"]>>,
    options: Partial<Pick<TimingSample, "beforeEngine" | "firstHoldMs" | "secondHoldMs" | "firstHeldCount" | "secondHeldCount" | "exact" | "typedWithoutClick">> = {},
  ): TimingSample => ({
    index,
    elapsedMs: state.elapsedMs,
    trusted: state.trusted,
    frames: state.frames,
    mutations: state.mutations,
    consecutiveFrames: state.consecutiveFrames,
    beforeEngine: options.beforeEngine ?? true,
    firstHoldMs: options.firstHoldMs ?? 0,
    secondHoldMs: options.secondHoldMs ?? 0,
    firstHeldCount: options.firstHeldCount ?? 0,
    secondHeldCount: options.secondHeldCount ?? 0,
    exact: options.exact ?? true,
    typedWithoutClick: options.typedWithoutClick ?? true,
  });
  const updateRendererSample = (entry: TimingSample, state: Awaited<ReturnType<RendererObserver["read"]>>) => {
    entry.elapsedMs = state.elapsedMs;
    entry.trusted = state.trusted;
    entry.frames = state.frames;
    entry.mutations = state.mutations;
    entry.consecutiveFrames = state.consecutiveFrames;
  };
  const pendingMeasurement: { current: { observer: RendererObserver; sample: TimingSample } | null } = { current: null };
  let journeyCompleted = false;
  let diagnosticError: string | null = null;

  try {
    const initialNewTaskPoint = await world.prepareWorkspaceNewTask();
    await step("the plus remains the topmost hit target over the long workspace name", async () => {
      const hit = await probe.eval(browserScript((workspaceId, x, y) => {
        const plus = document.querySelector<HTMLElement>(`[data-sidebar-workspace-id="${workspaceId}"] [data-workspace-new-task]`);
        if (!(plus instanceof HTMLElement)) return { hitPlus: false, hitTitle: false, tag: "" };
        const node = document.elementFromPoint(x, y);
        const title = plus.closest("[data-workspace-actions]")?.parentElement?.querySelector<HTMLElement>(".ow-fade-truncate");
        return {
          hitPlus: plus.contains(node),
          hitTitle: Boolean(title && node instanceof Node && title.contains(node)),
          tag: node instanceof Element ? node.tagName.toLowerCase() : "",
        };
      }, [world.workspace.workspaceId, initialNewTaskPoint.x, initialNewTaskPoint.y]));
      if (!isRecord(hit)) throw new Error(`New task plus returned malformed hit facts: ${JSON.stringify(hit)}`);
      expect(hit.hitPlus).toBe(true);
      expect(hit.hitTitle).toBe(false);
      evidence.recordAssertionEvidence(
        "The workspace New task plus remains clickable over a long workspace name",
        "The painted element at the plus center belongs to the plus, not the truncated title.", true,
      );
    });

    const expandedBefore = await expanded();
    await user.see({ text: world.existingHistory });

    await step("twelve populated-session New task clicks and twelve lazy first sends retain every renderer sample", async () => {
      for (let index = 0; index < sampleCount; index += 1) {
        const scenario = world.lazySamples[index];
        if (!scenario) throw new Error(`Missing lazy sample ${index + 1}`);
        await openSession(world.existing);
        await user.see({ text: world.existingHistory });
        const targetNativeBeforeOpen = await world.sessionIds();
        const globalUiBeforeOpen = (await agent.list()).map((session) => session.sessionId).sort();
        const requestsBeforeOpen = readFaults();
        const newTaskPoint = await world.prepareWorkspaceNewTask();
        const readyObserver = await world.observeRenderer("new-task");
        expectedSessionId = null;
        await world.clickWorkspaceNewTask(newTaskPoint);
        const readySample = sample(index + 1, await readyObserver.read(), { exact: false, typedWithoutClick: false });
        newTaskSamples.push(readySample);
        pendingMeasurement.current = { observer: readyObserver, sample: readySample };
        const ready = await waitRenderer(readyObserver);
        updateRendererSample(readySample, ready);
        await readyObserver[Symbol.asyncDispose]();
        pendingMeasurement.current = null;
        const targetNativeAfterOpen = await world.sessionIds();
        const globalUiAfterOpen = (await agent.list()).map((session) => session.sessionId).sort();
        const requestsAfterOpen = readFaults();
        const routeAfterOpen = await probe.hash();
        const openingSubfacts = {
          globalUiRetained: globalUiBeforeOpen.every((sessionId) => globalUiAfterOpen.includes(sessionId)),
          targetNativeStable: JSON.stringify(targetNativeAfterOpen) === JSON.stringify(targetNativeBeforeOpen),
          zeroTargetCreationPosts: requestsAfterOpen.creation === requestsBeforeOpen.creation,
          zeroTargetPromptPosts: requestsAfterOpen.prompt === requestsBeforeOpen.prompt,
          sessionlessRoute: !routeAfterOpen.includes("/session/ses_"),
        };
        const openingStayedLazy = Object.values(openingSubfacts).every(Boolean);
        evidence.recordJsonArtifact(`Lazy New task sample ${index + 1} opening invariants`, {
          checks: openingSubfacts,
          globalUi: { before: globalUiBeforeOpen, after: globalUiAfterOpen, retained: openingSubfacts.globalUiRetained },
          targetNative: { before: targetNativeBeforeOpen, after: targetNativeAfterOpen, stable: openingSubfacts.targetNativeStable },
          requestDelta: {
            creation: requestsAfterOpen.creation - requestsBeforeOpen.creation,
            prompt: requestsAfterOpen.prompt - requestsBeforeOpen.prompt,
          },
          routeAfterOpen,
        });
        if (index === 0) await user.see({ text: "What do you need done?" });
        const typed = await world.insertFocusedText(scenario.marker);
        typingDiagnostics.push({ index: index + 1, beforeText: typed.beforeText, afterText: typed.afterText });
        const normalizedBeforeText = /^\s*$/.test(typed.beforeText) ? "" : typed.beforeText;
        const typedWithoutClick = normalizedBeforeText === "" && typed.afterText === scenario.marker;
        readySample.exact = openingStayedLazy;
        readySample.typedWithoutClick = typedWithoutClick;

        await accessibleRunTask(scenario.marker, `lazy sample ${index + 1} exposes an enabled Run task control for its typed payload`);
        const requestBeforeSend = readFaults();
        const createGate = faults.holdNext("creation", "request");
        const promptGate = faults.holdNext("prompt", "request");
        const rowObserver = await world.observeRenderer("user-row", scenario.marker, true);
        await user.press("Enter");
        if (index === 0) await user.press("Enter");
        const lazySample = sample(index + 1, await rowObserver.read(), {
          beforeEngine: false,
          exact: false,
          typedWithoutClick,
        });
        lazySendSamples.push(lazySample);
        pendingMeasurement.current = { observer: rowObserver, sample: lazySample };
        const creationHeld = await waitHeld(createGate);
        expect(await visibleFacts(scenario.marker)).toMatchObject({
          starting: [{ role: "status", text: "Starting…" }], workingCount: 0,
        });
        const beforeEngineState = await rowObserver.read();
        updateRendererSample(lazySample, beforeEngineState);
        lazySample.beforeEngine = beforeEngineState.elapsedMs !== null && beforeEngineState.elapsedMs < sendLimitMs;
        lazySample.firstHoldMs = creationHeld.elapsedMs;
        lazySample.firstHeldCount = creationHeld.held;
        const heldInventory = await world.sessionIds();
        let successDraftTyped = true;
        if (index === 0) {
          const draft = await world.insertFocusedText(world.failure.pendingB);
          successDraftTyped = draft.afterText.endsWith(world.failure.pendingB);
        }
        await createGate.release();
        const createdIds = await probe.eventually(async () => (await world.sessionIds())
          .filter((sessionId) => !targetNativeBeforeOpen.includes(sessionId)), {
          within: 30_000,
          label: `lazy sample ${index + 1} creates a real v1 session after release`,
          until: (sessionIds) => sessionIds.length > 0,
        });
        const createdSessionId = createdIds[0];
        if (!createdSessionId) throw new Error(`Lazy sample ${index + 1} did not expose its created session id.`);
        expectedSessionId = createdSessionId;
        const promptHeld = await waitHeld(promptGate);
        expect(await visibleFacts(scenario.marker)).toMatchObject({
          starting: [{ role: "status", text: "Starting…" }], workingCount: 0,
        });
        lazySample.secondHoldMs = promptHeld.elapsedMs;
        lazySample.secondHeldCount = promptHeld.held;
        const backendBeforePromptRelease = await Promise.all(createdIds.map((sessionId) => world.messageFacts(sessionId, scenario.marker)));
        await promptGate.release();
        await waitReply(scenario.reply);
        const rendered = await waitRenderer(rowObserver);
        updateRendererSample(lazySample, rendered);
        await rowObserver[Symbol.asyncDispose]();
        pendingMeasurement.current = null;
        const active = await activeSessionId();
        const visible = await visibleFacts(scenario.marker);
        const backend = await probe.eventually(() => Promise.all(createdIds.map((sessionId) => world.messageFacts(sessionId, scenario.marker))), {
          within: 30_000,
          label: `lazy sample ${index + 1} reaches one real v1 transcript`,
          until: (facts) => facts.reduce((total, entry) => total + entry.markerOccurrences, 0) > 0,
        });
        const requestAfterSend = readFaults();
        const serverAfterSend = await world.sessionIds();
        const exact = createdIds.length === 1
          && heldInventory.length === targetNativeBeforeOpen.length
          && backendBeforePromptRelease.every((facts) => facts.markerCount === 0 && facts.markerOccurrences === 0)
          && backend.reduce((total, facts) => total + facts.markerCount, 0) === 1
          && backend.reduce((total, facts) => total + facts.markerOccurrences, 0) === 1
          && requestAfterSend.creation - requestBeforeSend.creation === 1
          && requestAfterSend.prompt - requestBeforeSend.prompt === 1
          && serverAfterSend.length === targetNativeBeforeOpen.length + 1
          && active === createdSessionId
          && visible.rowCount === 1 && visible.markerOccurrences === 1;
        lazySample.exact = exact;

        if (index === 0) {
          const draftAfterSuccess = await visibleFacts(world.failure.pendingB);
          negatives.successDraftB = successDraftTyped && draftAfterSuccess.composerText === world.failure.pendingB;
          negatives.rapidDuplicateEnter = exact && createGate.read().held === 1 && promptGate.read().held === 1;
          await user.see({ text: scenario.marker }, { timeoutMs: 30_000 });
          await user.see({ text: scenario.reply }, { timeoutMs: 30_000 });
          const beforeReloadObservedPair = await probe.eventually(async () => {
            const [visibleUser, visibleReply] = await Promise.all([
              world.visibleMessageFacts(createdSessionId, "user", scenario.marker),
              world.visibleMessageFacts(createdSessionId, "assistant", scenario.reply),
            ]);
            return { visibleUser, visibleReply };
          }, {
            within: 30_000,
            label: `normal user observation exposes the first lazy user and reply before reloading ${createdSessionId}`,
            until: ({ visibleUser, visibleReply }) => visibleUser.rowCount > 0 && visibleUser.markerOccurrences > 0
              && visibleReply.rowCount > 0 && visibleReply.markerOccurrences > 0,
          });
          const beforeReloadNativePair = await probe.eventually(async () => {
            const [nativeUser, nativeReply] = await Promise.all([
              world.messageFacts(createdSessionId, scenario.marker),
              world.messageFacts(createdSessionId, scenario.reply),
            ]);
            return { nativeUser, nativeReply };
          }, {
            within: 30_000,
            label: `the first lazy user and reply are persisted before reloading ${createdSessionId}`,
            until: ({ nativeUser, nativeReply }) => nativeUser.markerOccurrences > 0
              && nativeReply.markerOccurrences > 0,
          });
          const beforeReload = {
            providerRequestCount: await world.providerRequestCount(scenario.marker),
            sessionIds: await world.sessionIds(),
            nativeUser: beforeReloadNativePair.nativeUser,
            nativeReply: beforeReloadNativePair.nativeReply,
            visibleUser: beforeReloadObservedPair.visibleUser,
            visibleReply: beforeReloadObservedPair.visibleReply,
          };
          await faults.suspend();
          await user.reload();
          await probe.eventually(activeSessionId, {
            within: 30_000,
            label: "the first lazy session remains selected after reload",
            until: (sessionId) => sessionId === createdSessionId,
          });
          await probe.eventually(async () => {
            const [renderedUser, renderedReply, renderer] = await Promise.all([
              world.visibleMessageFacts(createdSessionId, "user", scenario.marker),
              world.visibleMessageFacts(createdSessionId, "assistant", scenario.reply),
              world.rendererDiagnostic(createdSessionId),
            ]);
            return { renderedUser, renderedReply, renderer };
          }, {
            within: 30_000,
            label: `the correct-owner reloaded v1 transcript ${createdSessionId} renders its user and reply rows`,
            until: ({ renderedUser, renderedReply, renderer }) => renderer.ownerWorkspaceId === world.workspace.workspaceId
              && renderer.ownerSessionId === createdSessionId
              && renderedUser.totalRowCount > 0 && renderedReply.totalRowCount > 0,
          });
          await user.see({ text: scenario.marker }, { timeoutMs: 30_000 });
          await user.see({ text: scenario.reply }, { timeoutMs: 30_000 });
          const postReloadObservedPair = await probe.eventually(async () => {
            const [reloaded, visibleUser, visibleReply] = await Promise.all([
              visibleFacts(scenario.marker),
              world.visibleMessageFacts(createdSessionId, "user", scenario.marker),
              world.visibleMessageFacts(createdSessionId, "assistant", scenario.reply),
            ]);
            return { reloaded, visibleUser, visibleReply };
          }, {
            within: 30_000,
            label: `normal user observation exposes the reloaded v1 user and reply in ${createdSessionId}`,
            until: ({ reloaded, visibleUser, visibleReply }) => reloaded.rowCount > 0
              && reloaded.markerOccurrences > 0
              && visibleUser.rowCount > 0 && visibleUser.markerOccurrences > 0
              && visibleReply.rowCount > 0 && visibleReply.markerOccurrences > 0,
          });
          const { reloaded } = postReloadObservedPair;
          const reloadedBackend = await probe.eventually(() => world.messageFacts(createdSessionId, scenario.marker), {
            within: 30_000,
            label: `reloaded v1 transcript ${createdSessionId} is readable with exactly one marker`,
            until: (facts) => facts.markerCount === 1 && facts.markerOccurrences === 1,
          });
          const afterReloadRequests = readFaults();
          const afterReload = {
            providerRequestCount: await world.providerRequestCount(scenario.marker),
            sessionIds: await world.sessionIds(),
            nativeReply: await world.messageFacts(createdSessionId, scenario.reply),
            visibleUser: postReloadObservedPair.visibleUser,
            visibleReply: postReloadObservedPair.visibleReply,
          };
          negatives.exactAfterReload = reloaded.rowCount === 1
            && reloaded.markerOccurrences === 1
            && afterReloadRequests.creation - requestBeforeSend.creation === 1
            && afterReloadRequests.prompt - requestBeforeSend.prompt === 1
            && beforeReload.providerRequestCount === 1
            && afterReload.providerRequestCount === beforeReload.providerRequestCount
            && JSON.stringify(afterReload.sessionIds) === JSON.stringify(beforeReload.sessionIds)
            && beforeReload.nativeUser.markerCount === 1 && beforeReload.nativeUser.markerOccurrences === 1
            && beforeReload.nativeReply.markerCount === 1 && beforeReload.nativeReply.markerOccurrences === 1
            && beforeReload.visibleUser.rowCount === 1 && beforeReload.visibleUser.markerOccurrences === 1
            && beforeReload.visibleUser.totalRowCount === 1
            && beforeReload.visibleReply.rowCount === 1 && beforeReload.visibleReply.markerOccurrences === 1
            && beforeReload.visibleReply.totalRowCount === 1
            && reloadedBackend.markerCount === 1 && reloadedBackend.markerOccurrences === 1
            && afterReload.nativeReply.markerCount === 1 && afterReload.nativeReply.markerOccurrences === 1
            && afterReload.visibleUser.rowCount === 1 && afterReload.visibleUser.markerOccurrences === 1
            && afterReload.visibleUser.totalRowCount === 1
            && afterReload.visibleReply.rowCount === 1 && afterReload.visibleReply.markerOccurrences === 1
            && afterReload.visibleReply.totalRowCount === 1;
          evidence.recordJsonArtifact("First reload proof", {
            checks: {
              afterReloadUserExact: reloaded.rowCount === 1 && reloaded.markerOccurrences === 1,
              creationRequestExact: afterReloadRequests.creation - requestBeforeSend.creation === 1,
              promptRequestExact: afterReloadRequests.prompt - requestBeforeSend.prompt === 1,
              providerBeforeExact: beforeReload.providerRequestCount === 1,
              providerCountStable: afterReload.providerRequestCount === beforeReload.providerRequestCount,
              inventoryStableAcrossReload: JSON.stringify(afterReload.sessionIds) === JSON.stringify(beforeReload.sessionIds),
              beforeNativeUserExact: beforeReload.nativeUser.markerCount === 1 && beforeReload.nativeUser.markerOccurrences === 1,
              beforeNativeReplyExact: beforeReload.nativeReply.markerCount === 1 && beforeReload.nativeReply.markerOccurrences === 1,
              beforeVisibleUserExact: beforeReload.visibleUser.rowCount === 1 && beforeReload.visibleUser.markerOccurrences === 1 && beforeReload.visibleUser.totalRowCount === 1,
              beforeVisibleReplyExact: beforeReload.visibleReply.rowCount === 1 && beforeReload.visibleReply.markerOccurrences === 1 && beforeReload.visibleReply.totalRowCount === 1,
              afterNativeUserExact: reloadedBackend.markerCount === 1 && reloadedBackend.markerOccurrences === 1,
              afterNativeReplyExact: afterReload.nativeReply.markerCount === 1 && afterReload.nativeReply.markerOccurrences === 1,
              afterVisibleUserExact: afterReload.visibleUser.rowCount === 1 && afterReload.visibleUser.markerOccurrences === 1 && afterReload.visibleUser.totalRowCount === 1,
              afterVisibleReplyExact: afterReload.visibleReply.rowCount === 1 && afterReload.visibleReply.markerOccurrences === 1 && afterReload.visibleReply.totalRowCount === 1,
            },
            claim: "The exact user message and reply can be viewed after reload without duplicates.",
            visibleUserCount: afterReload.visibleUser.rowCount,
            visibleReplyCount: afterReload.visibleReply.rowCount,
            providerCountBefore: beforeReload.providerRequestCount,
            providerCountAfter: afterReload.providerRequestCount,
            providerCountEqual: afterReload.providerRequestCount === beforeReload.providerRequestCount,
            inventoryEqual: JSON.stringify(afterReload.sessionIds) === JSON.stringify(beforeReload.sessionIds),
            nativeBefore: {
              user: { count: beforeReload.nativeUser.markerCount, occurrences: beforeReload.nativeUser.markerOccurrences },
              reply: { count: beforeReload.nativeReply.markerCount, occurrences: beforeReload.nativeReply.markerOccurrences },
            },
            visibleBefore: {
              user: { rows: beforeReload.visibleUser.rowCount, occurrences: beforeReload.visibleUser.markerOccurrences, totalRows: beforeReload.visibleUser.totalRowCount },
              reply: { rows: beforeReload.visibleReply.rowCount, occurrences: beforeReload.visibleReply.markerOccurrences, totalRows: beforeReload.visibleReply.totalRowCount },
            },
            nativeAfter: {
              user: { count: reloadedBackend.markerCount, occurrences: reloadedBackend.markerOccurrences },
              reply: { count: afterReload.nativeReply.markerCount, occurrences: afterReload.nativeReply.markerOccurrences },
            },
            visibleAfter: {
              user: { rows: afterReload.visibleUser.rowCount, occurrences: afterReload.visibleUser.markerOccurrences, totalRows: afterReload.visibleUser.totalRowCount },
              reply: { rows: afterReload.visibleReply.rowCount, occurrences: afterReload.visibleReply.markerOccurrences, totalRows: afterReload.visibleReply.totalRowCount },
            },
            requestDelta: {
              creation: afterReloadRequests.creation - requestBeforeSend.creation,
              prompt: afterReloadRequests.prompt - requestBeforeSend.prompt,
            },
          });
          await faults.resume();
        }
      }
    });

    const newTaskTiming = timingReport(newTaskSamples);
    const newTaskFailureIndices = newTaskSamples.filter((entry) => entry.elapsedMs === null
      || entry.elapsedMs >= newTaskLimitMs || !entry.trusted || entry.consecutiveFrames < 2
      || !entry.exact || !entry.typedWithoutClick).map((entry) => entry.index);
    evidence.recordAssertionEvidence(
      "Twelve New task clicks expose a focused, unobstructed composer within 500 ms",
      JSON.stringify({ metric: "trusted click to second consecutive qualifying animation frame", limitMs: newTaskLimitMs, count: newTaskTiming.count, expectedCount: sampleCount, p50Ms: newTaskTiming.p50Ms, p95Ms: newTaskTiming.p95Ms, maxMs: newTaskTiming.maxMs, failureIndices: newTaskFailureIndices }),
      newTaskTiming.count === sampleCount && newTaskFailureIndices.length === 0,
    );
    const lazyTiming = timingReport(lazySendSamples);
    const lazyFailureIndices = lazySendSamples.filter((entry) => entry.elapsedMs === null
      || entry.elapsedMs >= sendLimitMs || !entry.trusted || entry.consecutiveFrames < 2 || !entry.beforeEngine
      || entry.firstHoldMs < boundaryHoldMs || entry.secondHoldMs < boundaryHoldMs
      || entry.firstHeldCount !== 1 || entry.secondHeldCount !== 1 || !entry.exact || !entry.typedWithoutClick)
      .map((entry) => entry.index);
    evidence.recordAssertionEvidence(
      "Twelve lazy first sends paint their user row and Starting before engine work within 100 ms",
      JSON.stringify({ metric: "trusted Enter to second consecutive user-row and Starting frame before held engine requests", limitMs: sendLimitMs, count: lazyTiming.count, expectedCount: sampleCount, p50Ms: lazyTiming.p50Ms, p95Ms: lazyTiming.p95Ms, maxMs: lazyTiming.maxMs, failureIndices: lazyFailureIndices }),
      lazyTiming.count === sampleCount && lazyFailureIndices.length === 0,
    );

    await step("twelve existing-session sends paint before each real prompt request", async () => {
      await openSession(world.existing);
      for (let index = 0; index < sampleCount; index += 1) {
        const scenario = world.existingSamples[index];
        if (!scenario) throw new Error(`Missing existing-session sample ${index + 1}`);
        await user.type({ placeholder: "Describe your task..." }, scenario.marker, { replace: true, verify: true });
        await accessibleRunTask(scenario.marker, `existing sample ${index + 1} exposes an enabled Run task control for its typed payload`);
        const requestBefore = readFaults();
        const inventoryBefore = await world.sessionIds();
        const promptGate = faults.holdNext("prompt", "request");
        const rowObserver = await world.observeRenderer("user-row", scenario.marker, true);
        await user.press("Enter");
        const existingSample = sample(index + 1, await rowObserver.read(), { beforeEngine: false, exact: false });
        existingSendSamples.push(existingSample);
        pendingMeasurement.current = { observer: rowObserver, sample: existingSample };
        const held = await waitHeld(promptGate);
        expect(await visibleFacts(scenario.marker)).toMatchObject({
          starting: [{ role: "status", text: "Starting…" }], workingCount: 0,
        });
        const beforeEngineState = await rowObserver.read();
        updateRendererSample(existingSample, beforeEngineState);
        existingSample.beforeEngine = beforeEngineState.elapsedMs !== null && beforeEngineState.elapsedMs < sendLimitMs;
        existingSample.firstHoldMs = held.elapsedMs;
        existingSample.firstHeldCount = held.held;
        const backendBefore = await world.messageFacts(world.existing.sessionId, scenario.marker);
        await promptGate.release();
        await waitReply(scenario.reply);
        const rendered = await waitRenderer(rowObserver);
        updateRendererSample(existingSample, rendered);
        await rowObserver[Symbol.asyncDispose]();
        pendingMeasurement.current = null;
        const backendAfter = await waitBackendMarker(world.existing.sessionId, scenario.marker);
        const visible = await visibleFacts(scenario.marker);
        const requestAfter = readFaults();
        const inventoryAfter = await world.sessionIds();
        existingSample.exact = backendBefore.markerCount === 0 && backendBefore.markerOccurrences === 0
          && backendAfter.markerCount === 1 && backendAfter.markerOccurrences === 1
          && visible.rowCount === 1 && visible.markerOccurrences === 1
          && requestAfter.prompt - requestBefore.prompt === 1
          && requestAfter.creation === requestBefore.creation
          && JSON.stringify(inventoryAfter) === JSON.stringify(inventoryBefore);
      }
    });

    const existingTiming = timingReport(existingSendSamples);
    const existingFailureIndices = existingSendSamples.filter((entry) => entry.elapsedMs === null
      || entry.elapsedMs >= sendLimitMs || !entry.trusted || entry.consecutiveFrames < 2 || !entry.beforeEngine
      || entry.firstHoldMs < boundaryHoldMs || entry.firstHeldCount !== 1 || !entry.exact)
      .map((entry) => entry.index);
    evidence.recordAssertionEvidence(
      "Twelve existing-session sends paint their user row and Starting before engine work within 100 ms",
      JSON.stringify({ metric: "trusted Enter to second consecutive user-row and Starting frame before held engine request", limitMs: sendLimitMs, count: existingTiming.count, expectedCount: sampleCount, p50Ms: existingTiming.p50Ms, p95Ms: existingTiming.p95Ms, maxMs: existingTiming.maxMs, failureIndices: existingFailureIndices }),
      existingTiming.count === sampleCount && existingFailureIndices.length === 0,
    );

    const creationRestoreLabel = "Clear the current draft to restore the unsent message";
    const existingRestoreLabel = "Restore unsent message";
    const originalFailureMessage = "The request was rejected before admission.";
    const recoveryUiFacts = (restoreLabel: string, expectedFailureText: string) => probe.eval(browserScript((workspaceId, restoreLabel, expectedFailureText) => {
      const visible = (node: HTMLElement) => {
        const rect = node.getBoundingClientRect();
        let ancestor: HTMLElement | null = node;
        while (ancestor) {
          const style = getComputedStyle(ancestor);
          if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
          ancestor = ancestor.parentElement;
        }
        return node.getClientRects().length > 0 && rect.width > 0 && rect.height > 0
          && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight;
      };
      let root: HTMLElement | null = null;
      const sessionlessRoute = `#/workspace/${workspaceId}/session`;
      if ((localStorage.getItem("openwork.react.activeWorkspace") ?? "") === workspaceId) {
        if (location.hash === sessionlessRoute) {
          const heading = [...document.querySelectorAll<HTMLElement>("h2")]
            .find((candidate) => candidate.textContent?.trim() === "What do you need done?" && visible(candidate));
          const main = heading?.closest<HTMLElement>("main") ?? null;
          const persistedSurfaceVisible = [...document.querySelectorAll<HTMLElement>("[data-session-surface-id]")].some(visible);
          if (main && visible(main) && !persistedSurfaceVisible) root = main;
        } else {
          const persistedPrefix = `#/workspace/${workspaceId}/session/`;
          const sessionId = location.hash.startsWith(persistedPrefix) ? location.hash.slice(persistedPrefix.length) : "";
          const pane = [...document.querySelectorAll<HTMLElement>('[data-workbench-pane="primary"]')].find(visible) ?? null;
          const surface = [...(pane?.querySelectorAll<HTMLElement>("[data-session-surface-id]") ?? [])]
            .find((candidate) => candidate.dataset.sessionSurfaceId === sessionId && visible(candidate));
          if (sessionId.startsWith("ses_") && !/[/?#]/.test(sessionId) && pane && surface) root = pane;
        }
      }
      const alerts = [...(root?.querySelectorAll<HTMLElement>('[role="alert"]') ?? [])]
        .filter(visible).map((alert) => alert.innerText.trim()).filter(Boolean);
      const inlineFailures = [...(root?.querySelectorAll<Element>("*") ?? [])]
        .filter((candidate): candidate is HTMLElement => candidate instanceof HTMLElement
          && candidate.innerText.trim() === expectedFailureText && visible(candidate)
          && !candidate.closest('[contenteditable="true"][data-lexical-editor="true"], [data-message-role="user"]')
          && ![...candidate.querySelectorAll<Element>("*")]
            .some((descendant) => descendant instanceof HTMLElement
              && descendant.innerText.trim() === expectedFailureText && visible(descendant)))
        .map((candidate) => candidate.innerText.trim());
      const restore = [...(root?.querySelectorAll<HTMLButtonElement>("button") ?? [])]
        .find((button) => button.innerText.trim() === restoreLabel && visible(button)) ?? null;
      return {
        failureMessage: [...new Set([...alerts, ...inlineFailures])].join(" | "),
        restoreVisible: Boolean(restore),
        restoreDisabled: restore?.disabled ?? null,
      };
    }, [world.workspace.workspaceId, restoreLabel, expectedFailureText]));

    await step("creation and prompt failures preserve submitted work and the next draft through explicit recovery", async () => {
      await openSession(world.existing);
      const beforeCreationFailure = await world.sessionIds();
      const creationRequestsBefore = readFaults();
      const newTaskPoint = await world.prepareWorkspaceNewTask();
      expectedSessionId = null;
      await world.clickWorkspaceNewTask(newTaskPoint);
      await probe.eventually(() => visibleFacts(""), {
        within: 10_000,
        label: "failed-creation composer is focused",
        until: (facts) => facts.focusedEditor,
      });
      await world.insertFocusedText(world.failure.creationA);
      await accessibleRunTask(world.failure.creationA, "the failed-creation payload has an enabled Run task control before Enter");
      const creationGate = faults.holdNext("creation", "request");
      const creationRow = await world.observeRenderer("user-row", world.failure.creationA);
      await user.press("Enter");
      await waitHeld(creationGate);
      expect(await visibleFacts(world.failure.creationA)).toMatchObject({
        starting: [{ role: "status", text: "Starting…" }], workingCount: 0,
      });
      await world.insertFocusedText(world.failure.creationB);
      await creationGate.fail();
      await user.see({ text: originalFailureMessage }, { timeoutMs: 15_000 });
      const creationFailure = await probe.eventually(async () => ({
        composer: await visibleFacts(world.failure.creationA),
        recovery: await recoveryUiFacts(creationRestoreLabel, originalFailureMessage),
      }), {
        within: 15_000,
        label: "creation failure preserves editable draft B, the original failure, and a guarded restore action",
        until: (state) => state.composer.composerEditable
          && state.composer.composerText === world.failure.creationB
          && state.composer.starting.length === 0 && state.composer.workingCount === 0
          && state.recovery.failureMessage.includes(originalFailureMessage)
          && state.recovery.restoreVisible && state.recovery.restoreDisabled === true,
      });
      const creationRequestsAtFailure = readFaults();
      await user.click({ placeholder: "Describe your task..." });
      await user.press(world.app.handle.hostKind !== "daytona" && process.platform === "darwin" ? "Meta+A" : "Control+A");
      await user.press("Backspace");
      await probe.eventually(async () => ({
        composer: await visibleFacts(world.failure.creationA),
        recovery: await recoveryUiFacts(creationRestoreLabel, originalFailureMessage),
      }), {
        within: 10_000,
        label: "clearing new-task draft B by keyboard enables its restore action",
        until: (state) => state.composer.composerText === ""
          && state.recovery.restoreVisible && state.recovery.restoreDisabled === false,
      });
      await user.click({ role: "button", label: creationRestoreLabel });
      const creationRestored = await probe.eventually(async () => ({
        composer: await visibleFacts(world.failure.creationA),
        recovery: await recoveryUiFacts(creationRestoreLabel, originalFailureMessage),
      }), {
        within: 10_000,
        label: "the real new-task restore action restores exactly failed payload A",
        until: (state) => state.composer.composerEditable
          && state.composer.composerText === world.failure.creationA
          && state.composer.starting.length === 0 && state.composer.workingCount === 0
          && state.composer.rowCount === 0 && state.composer.markerOccurrences === 0
          && !state.recovery.restoreVisible,
      });
      const afterCreationFailure = await world.sessionIds();
      const creationRequestsAfter = readFaults();
      negatives.creationFailureComposerReady = creationFailure.composer.composerEditable
        && creationFailure.recovery.failureMessage.includes(originalFailureMessage)
        && creationFailure.recovery.restoreVisible && creationFailure.recovery.restoreDisabled === true;
      negatives.creationFailureARecoverable = creationRestored.composer.composerText === world.failure.creationA
        && creationRestored.composer.rowCount === 0 && creationRestored.composer.markerOccurrences === 0
        && !creationRestored.recovery.restoreVisible
        && creationRequestsAfter.creation === creationRequestsAtFailure.creation
        && creationRequestsAfter.prompt === creationRequestsAtFailure.prompt;
      negatives.creationFailureDraftBSurvives = creationFailure.composer.composerText === world.failure.creationB;
      negatives.creationFailureNoFallbackSession = !creationRestored.composer.route.includes("/session/ses_")
        && JSON.stringify(afterCreationFailure) === JSON.stringify(beforeCreationFailure)
        && creationRequestsAfter.creation - creationRequestsBefore.creation === 1
        && creationRequestsAfter.prompt === creationRequestsBefore.prompt;
      evidence.recordAssertionEvidence(
        "Failed new-task creation preserves draft B and restores exact payload A only after explicit recovery",
        JSON.stringify({ failureMessage: creationFailure.recovery.failureMessage, restoreDisabledWithDraftB: creationFailure.recovery.restoreDisabled, requestsBefore: creationRequestsBefore, requestsAtFailure: creationRequestsAtFailure, requestsAfterRestore: creationRequestsAfter }),
        negatives.creationFailureComposerReady && negatives.creationFailureARecoverable
          && negatives.creationFailureDraftBSurvives && negatives.creationFailureNoFallbackSession,
      );
      await creationRow[Symbol.asyncDispose]();

      await openSession(world.existing);
      await user.type({ placeholder: "Describe your task..." }, world.failure.promptA, { replace: true, verify: true });
      await accessibleRunTask(world.failure.promptA, "the failed-prompt payload has an enabled Run task control before Enter");
      const beforePromptFailure = await world.sessionIds();
      const promptRequestsBefore = readFaults();
      const promptGate = faults.holdNext("prompt", "request");
      const promptRow = await world.observeRenderer("user-row", world.failure.promptA);
      await user.press("Enter");
      await waitHeld(promptGate);
      expect(await visibleFacts(world.failure.promptA)).toMatchObject({
        starting: [{ role: "status", text: "Starting…" }], workingCount: 0,
      });
      await world.insertFocusedText(world.failure.promptB);
      await promptGate.fail();
      await user.see({ text: originalFailureMessage }, { timeoutMs: 15_000 });
      const promptFailure = await probe.eventually(async () => ({
        composer: await visibleFacts(world.failure.promptA),
        recovery: await recoveryUiFacts(existingRestoreLabel, originalFailureMessage),
      }), {
        within: 15_000,
        label: "prompt failure preserves editable draft B, the original failure, and a guarded restore action",
        until: (state) => state.composer.composerEditable
          && state.composer.composerText === world.failure.promptB
          && state.composer.starting.length === 0 && state.composer.workingCount === 0
          && state.recovery.failureMessage.includes(originalFailureMessage)
          && state.recovery.restoreVisible && state.recovery.restoreDisabled === true,
      });
      const promptRequestsAtFailure = readFaults();
      await user.click({ placeholder: "Describe your task..." });
      await user.press(world.app.handle.hostKind !== "daytona" && process.platform === "darwin" ? "Meta+A" : "Control+A");
      await user.press("Backspace");
      await probe.eventually(async () => ({
        composer: await visibleFacts(world.failure.promptA),
        recovery: await recoveryUiFacts(existingRestoreLabel, originalFailureMessage),
      }), {
        within: 10_000,
        label: "clearing existing-session draft B by keyboard enables its restore action",
        until: (state) => state.composer.composerText === ""
          && state.recovery.restoreVisible && state.recovery.restoreDisabled === false,
      });
      await user.click({ role: "button", label: existingRestoreLabel });
      const promptRestored = await probe.eventually(async () => ({
        composer: await visibleFacts(world.failure.promptA),
        recovery: await recoveryUiFacts(existingRestoreLabel, originalFailureMessage),
      }), {
        within: 10_000,
        label: "the real existing-session restore action restores exactly failed payload A",
        until: (state) => state.composer.composerEditable
          && state.composer.composerText === world.failure.promptA
          && state.composer.starting.length === 0 && state.composer.workingCount === 0
          && state.composer.rowCount === 0 && state.composer.markerOccurrences === 0
          && !state.recovery.restoreVisible,
      });
      const recoveredRunTask = await accessibleRunTask(
        world.failure.promptA,
        "the existing-session composer returns to enabled Run task after explicit recovery",
      );
      const promptBackend = await world.messageFacts(world.existing.sessionId, world.failure.promptA);
      const afterPromptFailure = await world.sessionIds();
      const promptRequestsAfter = readFaults();
      negatives.promptFailureComposerReady = promptFailure.composer.composerEditable
        && promptFailure.recovery.failureMessage.includes(originalFailureMessage)
        && promptFailure.recovery.restoreVisible && promptFailure.recovery.restoreDisabled === true
        && recoveredRunTask.ready;
      negatives.promptFailureARecoverable = promptRestored.composer.composerText === world.failure.promptA
        && promptRestored.composer.rowCount === 0 && promptRestored.composer.markerOccurrences === 0
        && !promptRestored.recovery.restoreVisible
        && promptRequestsAfter.creation === promptRequestsAtFailure.creation
        && promptRequestsAfter.prompt === promptRequestsAtFailure.prompt;
      negatives.promptFailureDraftBSurvives = promptFailure.composer.composerText === world.failure.promptB;
      negatives.promptFailureNoFallbackSession = promptRestored.composer.sessionId === world.existing.sessionId
        && promptBackend.markerCount === 0 && promptBackend.markerOccurrences === 0
        && JSON.stringify(afterPromptFailure) === JSON.stringify(beforePromptFailure)
        && promptRequestsAfter.prompt - promptRequestsBefore.prompt === 1
        && promptRequestsAfter.creation === promptRequestsBefore.creation;
      evidence.recordAssertionEvidence(
        "Failed existing-session prompt preserves draft B and restores exact payload A without retry",
        JSON.stringify({ failureMessage: promptFailure.recovery.failureMessage, restoreDisabledWithDraftB: promptFailure.recovery.restoreDisabled, requestsBefore: promptRequestsBefore, requestsAtFailure: promptRequestsAtFailure, requestsAfterRestore: promptRequestsAfter }),
        negatives.promptFailureComposerReady && negatives.promptFailureARecoverable
          && negatives.promptFailureDraftBSurvives && negatives.promptFailureNoFallbackSession,
      );
      await promptRow[Symbol.asyncDispose]();
    });

    await step("navigation while a send is held cannot leak, clear the next draft, navigate late, or steal focus", async () => {
      await openSession(world.existing);
      await user.type({ placeholder: "Describe your task..." }, world.navigation.marker, { replace: true, verify: true });
      await accessibleRunTask(world.navigation.marker, "the navigation payload has an enabled Run task control before Enter");
      const requestsBefore = readFaults();
      const promptGate = faults.holdNext("prompt", "request");
      const rowObserver = await world.observeRenderer("user-row", world.navigation.marker);
      await user.press("Enter");
      await waitHeld(promptGate);
      await world.insertFocusedText(world.failure.navigationB);
      await openSession(world.unrelated);
      await user.see({ text: world.unrelatedHistory });
      await user.click({ placeholder: "Describe your task..." });
      const unrelatedBefore = await visibleFacts(world.navigation.marker);
      await promptGate.release();
      await waitBackendMarker(world.existing.sessionId, world.navigation.marker);
      await probe.eventually(() => world.messageFacts(world.existing.sessionId, world.navigation.reply), {
        within: 60_000,
        label: "held navigation send completes in its originating v1 session",
        until: (facts) => facts.markerOccurrences > 0,
      });
      const unrelatedAfter = await visibleFacts(world.navigation.marker);
      const stayedUnrelated = unrelatedAfter.sessionId === world.unrelated.sessionId && unrelatedAfter.focusedEditor;
      await openSession(world.existing);
      await probe.eventually(async () => {
        const [renderedUser, renderedReply] = await Promise.all([
          world.visibleMessageFacts(world.existing.sessionId, "user", world.navigation.marker),
          world.visibleMessageFacts(world.existing.sessionId, "assistant", world.navigation.reply),
        ]);
        return { renderedUser, renderedReply };
      }, {
        within: 30_000,
        label: "the navigation origin renders its user and reply rows after return",
        until: ({ renderedUser, renderedReply }) => renderedUser.totalRowCount > 0 && renderedReply.totalRowCount > 0,
      });
      await user.see({ text: world.navigation.marker }, { timeoutMs: 30_000 });
      await user.see({ text: world.navigation.reply }, { timeoutMs: 30_000 });
      const originAfter = await visibleFacts(world.navigation.marker);
      const navigationBackend = await world.messageFacts(world.existing.sessionId, world.navigation.marker);
      const navigationReplyBackend = await world.messageFacts(world.existing.sessionId, world.navigation.reply);
      const requestsAfter = readFaults();
      negatives.navigationIsolation = unrelatedBefore.rowCount === 0 && unrelatedBefore.markerOccurrences === 0
        && !unrelatedBefore.composerText.includes(world.failure.navigationB)
        && unrelatedAfter.rowCount === 0 && unrelatedAfter.markerOccurrences === 0
        && !unrelatedAfter.composerText.includes(world.failure.navigationB)
        && stayedUnrelated
        && originAfter.rowCount === 1 && originAfter.markerOccurrences === 1
        && occurrences(originAfter.composerText, world.failure.navigationB) === 1
        && navigationBackend.markerCount === 1 && navigationBackend.markerOccurrences === 1
        && navigationReplyBackend.markerCount === 1 && navigationReplyBackend.markerOccurrences === 1
        && requestsAfter.prompt - requestsBefore.prompt === 1;
      evidence.recordJsonArtifact("Navigation isolation conjuncts", {
        checks: {
          unrelatedBeforeRowsAbsent: unrelatedBefore.rowCount === 0 && unrelatedBefore.markerOccurrences === 0,
          unrelatedBeforeDraftIsolated: !unrelatedBefore.composerText.includes(world.failure.navigationB),
          unrelatedAfterRowsAbsent: unrelatedAfter.rowCount === 0 && unrelatedAfter.markerOccurrences === 0,
          unrelatedAfterDraftIsolated: !unrelatedAfter.composerText.includes(world.failure.navigationB),
          stayedUnrelated,
          originRowExact: originAfter.rowCount === 1 && originAfter.markerOccurrences === 1,
          originDraftBExact: occurrences(originAfter.composerText, world.failure.navigationB) === 1,
          nativeUserExact: navigationBackend.markerCount === 1 && navigationBackend.markerOccurrences === 1,
          nativeReplyExact: navigationReplyBackend.markerCount === 1 && navigationReplyBackend.markerOccurrences === 1,
          promptRequestExact: requestsAfter.prompt - requestsBefore.prompt === 1,
        },
        unrelatedBefore: { rows: unrelatedBefore.rowCount, occurrences: unrelatedBefore.markerOccurrences, sessionId: unrelatedBefore.sessionId, focused: unrelatedBefore.focusedEditor },
        unrelatedAfter: { rows: unrelatedAfter.rowCount, occurrences: unrelatedAfter.markerOccurrences, sessionId: unrelatedAfter.sessionId, focused: unrelatedAfter.focusedEditor },
        originAfter: { rows: originAfter.rowCount, occurrences: originAfter.markerOccurrences, draftBOccurrences: occurrences(originAfter.composerText, world.failure.navigationB), sessionId: originAfter.sessionId, focused: originAfter.focusedEditor },
        nativeUser: { count: navigationBackend.markerCount, occurrences: navigationBackend.markerOccurrences },
        nativeReply: { count: navigationReplyBackend.markerCount, occurrences: navigationReplyBackend.markerOccurrences },
        requestDelta: { creation: requestsAfter.creation - requestsBefore.creation, prompt: requestsAfter.prompt - requestsBefore.prompt },
      });
      await rowObserver[Symbol.asyncDispose]();
    });

    await step("a separately held real response reconciles from SSE without duplicate rows", async () => {
      await openSession(world.existing);
      await user.type({ placeholder: "Describe your task..." }, world.responseHold.marker, { replace: true, verify: true });
      await accessibleRunTask(world.responseHold.marker, "the response-held payload has an enabled Run task control before Enter");
      const inventoryBefore = await world.sessionIds();
      const requestsBefore = readFaults();
      const responseGate = faults.holdNext("prompt", "response");
      const rowObserver = await world.observeRenderer("user-row", world.responseHold.marker);
      await user.press("Enter");
      const responseHeld = await waitHeld(responseGate);
      await probe.eventually(async () => {
        const userBackend = await world.messageFacts(world.existing.sessionId, world.responseHold.marker);
        const replyBackend = await world.messageFacts(world.existing.sessionId, world.responseHold.reply);
        return {
          ready: userBackend.markerOccurrences > 0 && replyBackend.markerOccurrences > 0,
          responseStillHeld: !responseGate.read().released,
        };
      }, {
        within: 20_000,
        label: "SSE delivers the real operation while its HTTP response remains held",
        until: (facts) => facts.ready && facts.responseStillHeld,
      });
      await user.see({ text: world.responseHold.reply });
      const sseVisiblePair = await probe.eventually(async () => {
        const [visibleUser, visibleReply] = await Promise.all([
          world.visibleMessageFacts(world.existing.sessionId, "user", world.responseHold.marker),
          world.visibleMessageFacts(world.existing.sessionId, "assistant", world.responseHold.reply),
        ]);
        return { visibleUser, visibleReply, responseStillHeld: !responseGate.read().released };
      }, {
        within: 20_000,
        label: "normal user observation exposes the SSE user and reply while the response remains held",
        until: (facts) => facts.visibleUser.rowCount > 0 && facts.visibleUser.markerOccurrences > 0
          && facts.visibleReply.rowCount > 0 && facts.visibleReply.markerOccurrences > 0
          && facts.responseStillHeld,
      });
      const sseBeforeResponse = sseVisiblePair.responseStillHeld;
      await responseGate.release();
      await waitReply(world.responseHold.reply);
      await waitRenderer(rowObserver);
      await rowObserver[Symbol.asyncDispose]();
      const beforeReload = sseVisiblePair.visibleUser;
      const beforeReloadProof = {
        providerRequestCount: await world.providerRequestCount(world.responseHold.marker),
        sessionIds: await world.sessionIds(),
        nativeUser: await world.messageFacts(world.existing.sessionId, world.responseHold.marker),
        nativeReply: await world.messageFacts(world.existing.sessionId, world.responseHold.reply),
        visibleUser: sseVisiblePair.visibleUser,
        visibleReply: sseVisiblePair.visibleReply,
      };
      await faults.suspend();
      await user.reload();
      await probe.eventually(activeSessionId, {
        within: 30_000,
        label: "response-stage session remains selected after reload",
        until: (sessionId) => sessionId === world.existing.sessionId,
      });
      let finalReloadDiagnostic: unknown = null;
      let finalReloadPolls = 0;
      const finalReloadStartedAt = Date.now();
      const afterReloadRenderedState = await (async () => {
        try {
          return await probe.eventually(async () => {
            finalReloadPolls += 1;
            const [renderedUser, renderedReply, native, exactNonUtilityModelInvocations, renderer] = await Promise.all([
              world.visibleMessageFacts(world.existing.sessionId, "user", world.responseHold.marker),
              world.visibleMessageFacts(world.existing.sessionId, "assistant", world.responseHold.reply),
              world.messageFacts(world.existing.sessionId, world.responseHold.marker, world.responseHold.reply),
              world.providerRequestCount(world.responseHold.marker),
              world.rendererDiagnostic(world.existing.sessionId),
            ]);
            const interceptorState = faults.read();
            const responseGateState = responseGate.read();
            finalReloadDiagnostic = {
              elapsedMs: Date.now() - finalReloadStartedAt,
              polls: finalReloadPolls,
              native: native.diagnostic,
              renderedUser: {
                total: renderedUser.totalRowCount,
                viewport: renderedUser.rowCount,
                offscreen: renderedUser.offscreenRowCount,
                surfaces: renderedUser.surfaceCount,
                visibleSurfaces: renderedUser.visibleSurfaceCount,
              },
              renderedReply: {
                total: renderedReply.totalRowCount,
                viewport: renderedReply.rowCount,
                offscreen: renderedReply.offscreenRowCount,
                surfaces: renderedReply.surfaceCount,
                visibleSurfaces: renderedReply.visibleSurfaceCount,
              },
              labels: { loaders: renderedUser.loaderLabels, errors: renderedUser.errorLabels },
              browserNetwork: renderedUser.network,
              renderer,
              exactNonUtilityModelInvocations,
              interceptor: {
                enabled: interceptorState.enabled,
                creationRequests: interceptorState.creation,
                promptRequests: interceptorState.prompt,
                activeGateCount: interceptorState.activeGateCount,
                activeHeldRequestCount: interceptorState.activeHeldRequestCount,
                gateHeldCount: responseGateState.held,
                activeHeldCount: responseGateState.released ? 0 : responseGateState.held,
                gateReleased: responseGateState.released,
              },
            };
            return { renderedUser, renderedReply, renderer };
          }, {
            within: 30_000,
            label: "the correct-owner reloaded SSE transcript renders its user and reply rows",
            until: (state) => state.renderer.ownerWorkspaceId === world.workspace.workspaceId
              && state.renderer.ownerSessionId === world.existing.sessionId
              && state.renderedUser.totalRowCount > 0 && state.renderedReply.totalRowCount > 0,
          });
        } catch (error) {
          evidence.recordJsonArtifact("Final reload diagnostic", finalReloadDiagnostic ?? { capture: "unavailable" });
          throw error;
        }
      })();
      await user.see({ text: world.responseHold.marker }, { timeoutMs: 30_000 });
      await user.see({ text: world.responseHold.reply }, { timeoutMs: 30_000 });
      const afterReloadVisible = await probe.eventually(async () => {
        const [visibleUser, visibleReply] = await Promise.all([
          world.visibleMessageFacts(world.existing.sessionId, "user", world.responseHold.marker),
          world.visibleMessageFacts(world.existing.sessionId, "assistant", world.responseHold.reply),
        ]);
        return { visibleUser, visibleReply };
      }, {
        within: 30_000,
        label: "the reloaded SSE user and reply can be viewed exactly once",
        until: ({ visibleUser, visibleReply }) => visibleUser.rowCount === 1 && visibleUser.markerOccurrences === 1
          && visibleUser.totalRowCount === 1
          && visibleReply.rowCount === 1 && visibleReply.markerOccurrences === 1
          && visibleReply.totalRowCount === 1,
      });
      const afterReload = afterReloadVisible.visibleUser;
      const backend = await world.messageFacts(world.existing.sessionId, world.responseHold.marker);
      const replyBackend = await world.messageFacts(world.existing.sessionId, world.responseHold.reply);
      const afterReloadProof = {
        providerRequestCount: await world.providerRequestCount(world.responseHold.marker),
        sessionIds: await world.sessionIds(),
        visibleUser: afterReloadVisible.visibleUser,
        visibleReply: afterReloadVisible.visibleReply,
      };
      const requestsAfter = readFaults();
      const inventoryEqual = JSON.stringify(await world.sessionIds()) === JSON.stringify(inventoryBefore);
      negatives.responseSseReconciliation = sseBeforeResponse
        && responseHeld.elapsedMs >= boundaryHoldMs
        && beforeReload.rowCount === 1 && beforeReload.markerOccurrences === 1
        && afterReload.rowCount === 1 && afterReload.markerOccurrences === 1
        && beforeReloadProof.providerRequestCount === 1
        && afterReloadProof.providerRequestCount === beforeReloadProof.providerRequestCount
        && JSON.stringify(afterReloadProof.sessionIds) === JSON.stringify(beforeReloadProof.sessionIds)
        && beforeReloadProof.nativeUser.markerCount === 1 && beforeReloadProof.nativeUser.markerOccurrences === 1
        && beforeReloadProof.nativeReply.markerCount === 1 && beforeReloadProof.nativeReply.markerOccurrences === 1
        && beforeReloadProof.visibleUser.rowCount === 1 && beforeReloadProof.visibleUser.markerOccurrences === 1
        && beforeReloadProof.visibleUser.totalRowCount === 1
        && beforeReloadProof.visibleReply.rowCount === 1 && beforeReloadProof.visibleReply.markerOccurrences === 1
        && beforeReloadProof.visibleReply.totalRowCount === 1
        && backend.markerCount === 1 && backend.markerOccurrences === 1
        && replyBackend.markerCount === 1 && replyBackend.markerOccurrences === 1
        && afterReloadProof.visibleUser.rowCount === 1 && afterReloadProof.visibleUser.markerOccurrences === 1
        && afterReloadProof.visibleUser.totalRowCount === 1
        && afterReloadProof.visibleReply.rowCount === 1 && afterReloadProof.visibleReply.markerOccurrences === 1
        && afterReloadProof.visibleReply.totalRowCount === 1
        && requestsAfter.prompt - requestsBefore.prompt === 1
        && requestsAfter.creation === requestsBefore.creation
        && inventoryEqual;
      evidence.recordJsonArtifact("SSE reconciliation conjuncts", {
        checks: {
          sseBeforeResponse,
          responseHeldLongEnough: responseHeld.elapsedMs >= boundaryHoldMs,
          beforeReloadUserExact: beforeReload.rowCount === 1 && beforeReload.markerOccurrences === 1,
          afterReloadUserExact: afterReload.rowCount === 1 && afterReload.markerOccurrences === 1,
          providerBeforeExact: beforeReloadProof.providerRequestCount === 1,
          providerCountStable: afterReloadProof.providerRequestCount === beforeReloadProof.providerRequestCount,
          inventoryStableAcrossReload: JSON.stringify(afterReloadProof.sessionIds) === JSON.stringify(beforeReloadProof.sessionIds),
          beforeNativeUserExact: beforeReloadProof.nativeUser.markerCount === 1 && beforeReloadProof.nativeUser.markerOccurrences === 1,
          beforeNativeReplyExact: beforeReloadProof.nativeReply.markerCount === 1 && beforeReloadProof.nativeReply.markerOccurrences === 1,
          beforeVisibleUserExact: beforeReloadProof.visibleUser.rowCount === 1 && beforeReloadProof.visibleUser.markerOccurrences === 1 && beforeReloadProof.visibleUser.totalRowCount === 1,
          beforeVisibleReplyExact: beforeReloadProof.visibleReply.rowCount === 1 && beforeReloadProof.visibleReply.markerOccurrences === 1 && beforeReloadProof.visibleReply.totalRowCount === 1,
          afterNativeUserExact: backend.markerCount === 1 && backend.markerOccurrences === 1,
          afterNativeReplyExact: replyBackend.markerCount === 1 && replyBackend.markerOccurrences === 1,
          afterVisibleUserExact: afterReloadProof.visibleUser.rowCount === 1 && afterReloadProof.visibleUser.markerOccurrences === 1 && afterReloadProof.visibleUser.totalRowCount === 1,
          afterVisibleReplyExact: afterReloadProof.visibleReply.rowCount === 1 && afterReloadProof.visibleReply.markerOccurrences === 1 && afterReloadProof.visibleReply.totalRowCount === 1,
          promptRequestExact: requestsAfter.prompt - requestsBefore.prompt === 1,
          creationRequestsStable: requestsAfter.creation === requestsBefore.creation,
          inventoryEqual,
        },
        sseBeforeResponse,
        claim: "The exact SSE-reconciled user message and reply can be viewed after reload without duplicates.",
        responseHoldMs: round(responseHeld.elapsedMs),
        renderedBeforeObservation: {
          userRows: afterReloadRenderedState.renderedUser.totalRowCount,
          replyRows: afterReloadRenderedState.renderedReply.totalRowCount,
        },
        beforeReload: { rows: beforeReload.rowCount, occurrences: beforeReload.markerOccurrences },
        afterReload: { rows: afterReload.rowCount, occurrences: afterReload.markerOccurrences },
        provider: { before: beforeReloadProof.providerRequestCount, after: afterReloadProof.providerRequestCount },
        nativeBefore: {
          user: { count: beforeReloadProof.nativeUser.markerCount, occurrences: beforeReloadProof.nativeUser.markerOccurrences },
          reply: { count: beforeReloadProof.nativeReply.markerCount, occurrences: beforeReloadProof.nativeReply.markerOccurrences },
        },
        visibleBefore: {
          user: { rows: beforeReloadProof.visibleUser.rowCount, occurrences: beforeReloadProof.visibleUser.markerOccurrences },
          reply: { rows: beforeReloadProof.visibleReply.rowCount, occurrences: beforeReloadProof.visibleReply.markerOccurrences },
        },
        nativeAfter: {
          user: { count: backend.markerCount, occurrences: backend.markerOccurrences },
          reply: { count: replyBackend.markerCount, occurrences: replyBackend.markerOccurrences },
        },
        visibleAfter: {
          user: { rows: afterReloadProof.visibleUser.rowCount, occurrences: afterReloadProof.visibleUser.markerOccurrences },
          reply: { rows: afterReloadProof.visibleReply.rowCount, occurrences: afterReloadProof.visibleReply.markerOccurrences },
        },
        inventoryEquality: { reload: JSON.stringify(afterReloadProof.sessionIds) === JSON.stringify(beforeReloadProof.sessionIds), final: inventoryEqual },
        requestDelta: { creation: requestsAfter.creation - requestsBefore.creation, prompt: requestsAfter.prompt - requestsBefore.prompt },
      });
      if (negatives.responseSseReconciliation) await faults.resume();
    });

    const expandedAfter = await expanded();
    const newTaskPass = newTaskSamples.length === sampleCount && newTaskSamples.every((entry) => entry.elapsedMs !== null
      && entry.elapsedMs < newTaskLimitMs && entry.trusted && entry.consecutiveFrames >= 2
      && entry.exact && entry.typedWithoutClick);
    const lazySendPass = lazySendSamples.length === sampleCount && lazySendSamples.every((entry) => entry.elapsedMs !== null
      && entry.elapsedMs < sendLimitMs && entry.trusted && entry.consecutiveFrames >= 2 && entry.beforeEngine
      && entry.firstHoldMs >= boundaryHoldMs && entry.secondHoldMs >= boundaryHoldMs
      && entry.firstHeldCount === 1 && entry.secondHeldCount === 1 && entry.exact && entry.typedWithoutClick);
    const existingSendPass = existingSendSamples.length === sampleCount && existingSendSamples.every((entry) => entry.elapsedMs !== null
      && entry.elapsedMs < sendLimitMs && entry.trusted && entry.consecutiveFrames >= 2 && entry.beforeEngine
      && entry.firstHoldMs >= boundaryHoldMs && entry.firstHeldCount === 1 && entry.exact);
    const negativePass = Object.values(negatives).every(Boolean);
    const expansionPass = expandedAfter === expandedBefore;

    evidence.recordAssertionEvidence(
      "Held, failed, navigated, and SSE-reconciled sends remain singular, can be viewed after reload, and preserve drafts",
      JSON.stringify({ negatives, expansionUnchanged: expansionPass }),
      negativePass && expansionPass,
    );
    if (!newTaskPass || !lazySendPass || !existingSendPass || !negativePass || !expansionPass) await user.screenshot();
    expect({
      newTaskSamples: newTaskSamples.length === sampleCount,
      newTaskEverySampleUnder500Ms: newTaskPass,
      lazySamples: lazySendSamples.length === sampleCount,
      lazyEverySampleUnder100MsBeforeEngine: lazySendPass,
      existingSamples: existingSendSamples.length === sampleCount,
      existingEverySampleUnder100MsBeforeEngine: existingSendPass,
      negativeHalves: negativePass,
      workspaceExpansionUnchanged: expansionPass,
    }).toEqual({
      newTaskSamples: true,
      newTaskEverySampleUnder500Ms: true,
      lazySamples: true,
      lazyEverySampleUnder100MsBeforeEngine: true,
      existingSamples: true,
      existingEverySampleUnder100MsBeforeEngine: true,
      negativeHalves: true,
      workspaceExpansionUnchanged: true,
    });
    journeyCompleted = true;
  } catch (error) {
    diagnosticError = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    const renderer = await world.rendererDiagnostic(expectedSessionId).catch(() => ({ capture: "unavailable" }));
    evidence.recordJsonArtifact("Renderer failure diagnostic", renderer);
    await user.screenshot().catch(() => undefined);
    throw error;
  } finally {
    const pending = pendingMeasurement.current;
    if (pending) {
      try { updateRendererSample(pending.sample, await pending.observer.read()); } catch {}
      try { await pending.observer[Symbol.asyncDispose](); } catch {}
      pendingMeasurement.current = null;
    }
    try { lastFaultCounts = faults.read(); } catch {}
    evidence.recordAssertionEvidence(
      "Instant-send run diagnostics retain the terminal state without combining timing payloads",
      JSON.stringify({
        completed: journeyCompleted,
        error: diagnosticError,
        faultCounts: lastFaultCounts,
        typing: typingDiagnostics,
        negatives,
      }),
      journeyCompleted,
    );
    evidence.recordAssertionEvidence(
      "Raw New task timing samples are retained, including any pending partial sample",
      JSON.stringify(timingReport(newTaskSamples)),
      newTaskSamples.length === sampleCount && newTaskSamples.every((entry) => entry.elapsedMs !== null
        && entry.elapsedMs < newTaskLimitMs && entry.trusted && entry.consecutiveFrames >= 2
        && entry.exact && entry.typedWithoutClick),
    );
    evidence.recordAssertionEvidence(
      "Raw lazy-send timing samples are retained, including any pending partial sample",
      JSON.stringify(timingReport(lazySendSamples)),
      lazySendSamples.length === sampleCount && lazySendSamples.every((entry) => entry.elapsedMs !== null
        && entry.elapsedMs < sendLimitMs && entry.trusted && entry.consecutiveFrames >= 2 && entry.beforeEngine
        && entry.firstHoldMs >= boundaryHoldMs && entry.secondHoldMs >= boundaryHoldMs
        && entry.firstHeldCount === 1 && entry.secondHeldCount === 1 && entry.exact && entry.typedWithoutClick),
    );
    evidence.recordAssertionEvidence(
      "Raw existing-send timing samples are retained, including any pending partial sample",
      JSON.stringify(timingReport(existingSendSamples)),
      existingSendSamples.length === sampleCount && existingSendSamples.every((entry) => entry.elapsedMs !== null
        && entry.elapsedMs < sendLimitMs && entry.trusted && entry.consecutiveFrames >= 2 && entry.beforeEngine
        && entry.firstHoldMs >= boundaryHoldMs && entry.firstHeldCount === 1 && entry.exact),
    );
  }
});
