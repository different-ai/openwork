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
  const waitReply = (reply: string) => probe.eventually(() => surfaceContains(reply), {
    within: 60_000,
    label: `the deterministic v1 reply ${reply.slice(0, 32)} is visible`,
    until: (visible) => visible,
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
        const serverBeforeOpen = await world.sessionIds();
        const agentBeforeOpen = (await agent.list()).map((session) => session.sessionId).sort();
        const requestsBeforeOpen = readFaults();
        const newTaskPoint = await world.prepareWorkspaceNewTask();
        const readyObserver = await world.observeRenderer("new-task");
        await world.clickWorkspaceNewTask(newTaskPoint);
        const readySample = sample(index + 1, await readyObserver.read(), { exact: false, typedWithoutClick: false });
        newTaskSamples.push(readySample);
        pendingMeasurement.current = { observer: readyObserver, sample: readySample };
        const ready = await waitRenderer(readyObserver);
        updateRendererSample(readySample, ready);
        await readyObserver[Symbol.asyncDispose]();
        pendingMeasurement.current = null;
        const serverAfterOpen = await world.sessionIds();
        const agentAfterOpen = (await agent.list()).map((session) => session.sessionId).sort();
        const requestsAfterOpen = readFaults();
        const routeAfterOpen = await probe.hash();
        const openingSubfacts = {
          backendInventoryUnchanged: JSON.stringify(serverAfterOpen) === JSON.stringify(serverBeforeOpen),
          cachedIdsRetained: agentBeforeOpen.every((sessionId) => agentAfterOpen.includes(sessionId)),
          cachedIdsAuthoritative: [...agentBeforeOpen, ...agentAfterOpen]
            .every((sessionId) => serverBeforeOpen.includes(sessionId)),
          zeroCreationPosts: requestsAfterOpen.creation === requestsBeforeOpen.creation,
          zeroPromptPosts: requestsAfterOpen.prompt === requestsBeforeOpen.prompt,
          sessionlessRoute: !routeAfterOpen.includes("/session/ses_"),
        };
        const openingStayedLazy = Object.values(openingSubfacts).every(Boolean);
        if (!openingStayedLazy) {
          evidence.recordAssertionEvidence(
            `Lazy New task sample ${index + 1} opening invariants`,
            JSON.stringify({ index: index + 1, ...openingSubfacts, serverBeforeOpen, serverAfterOpen, agentBeforeOpen, agentAfterOpen, requestsBeforeOpen, requestsAfterOpen, routeAfterOpen }),
            false,
          );
        }
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
        const rowObserver = await world.observeRenderer("user-row", scenario.marker);
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
          .filter((sessionId) => !serverBeforeOpen.includes(sessionId)), {
          within: 30_000,
          label: `lazy sample ${index + 1} creates a real v1 session after release`,
          until: (sessionIds) => sessionIds.length > 0,
        });
        const createdSessionId = createdIds[0];
        if (!createdSessionId) throw new Error(`Lazy sample ${index + 1} did not expose its created session id.`);
        const promptHeld = await waitHeld(promptGate);
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
          && heldInventory.length === serverBeforeOpen.length
          && backendBeforePromptRelease.every((facts) => facts.markerCount === 0 && facts.markerOccurrences === 0)
          && backend.reduce((total, facts) => total + facts.markerCount, 0) === 1
          && backend.reduce((total, facts) => total + facts.markerOccurrences, 0) === 1
          && requestAfterSend.creation - requestBeforeSend.creation === 1
          && requestAfterSend.prompt - requestBeforeSend.prompt === 1
          && serverAfterSend.length === serverBeforeOpen.length + 1
          && active === createdSessionId
          && visible.rowCount === 1 && visible.markerOccurrences === 1;
        lazySample.exact = exact;

        if (index === 0) {
          const draftAfterSuccess = await visibleFacts(world.failure.pendingB);
          negatives.successDraftB = successDraftTyped && draftAfterSuccess.composerText === world.failure.pendingB;
          negatives.rapidDuplicateEnter = exact && createGate.read().held === 1 && promptGate.read().held === 1;
          const beforeReload = {
            providerRequestCount: await world.providerRequestCount(scenario.marker),
            sessionIds: await world.sessionIds(),
            nativeUser: await world.messageFacts(createdSessionId, scenario.marker),
            nativeReply: await world.messageFacts(createdSessionId, scenario.reply),
            visibleUser: await world.visibleMessageFacts(createdSessionId, "user", scenario.marker),
            visibleReply: await world.visibleMessageFacts(createdSessionId, "assistant", scenario.reply),
          };
          await faults.suspend();
          await user.reload();
          await probe.eventually(activeSessionId, {
            within: 30_000,
            label: "the first lazy session remains selected after reload",
            until: (sessionId) => sessionId === createdSessionId,
          });
          await faults.resume();
          const reloaded = await visibleFacts(scenario.marker);
          const afterReloadRequests = readFaults();
          const reloadedBackend = await probe.eventually(() => world.messageFacts(createdSessionId, scenario.marker), {
            within: 30_000,
            label: `reloaded v1 transcript ${createdSessionId} is readable with exactly one marker`,
            until: (facts) => facts.markerCount === 1 && facts.markerOccurrences === 1,
          });
          const afterReload = {
            providerRequestCount: await world.providerRequestCount(scenario.marker),
            sessionIds: await world.sessionIds(),
            nativeReply: await world.messageFacts(createdSessionId, scenario.reply),
            visibleUser: await world.visibleMessageFacts(createdSessionId, "user", scenario.marker),
            visibleReply: await world.visibleMessageFacts(createdSessionId, "assistant", scenario.reply),
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
            && beforeReload.visibleReply.rowCount === 1 && beforeReload.visibleReply.markerOccurrences === 1
            && reloadedBackend.markerCount === 1 && reloadedBackend.markerOccurrences === 1
            && afterReload.nativeReply.markerCount === 1 && afterReload.nativeReply.markerOccurrences === 1
            && afterReload.visibleUser.rowCount === 1 && afterReload.visibleUser.markerOccurrences === 1
            && afterReload.visibleReply.rowCount === 1 && afterReload.visibleReply.markerOccurrences === 1;
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
      "Twelve lazy first sends paint before engine work within 100 ms",
      JSON.stringify({ metric: "trusted Enter to second consecutive visible-row frame before held engine requests", limitMs: sendLimitMs, count: lazyTiming.count, expectedCount: sampleCount, p50Ms: lazyTiming.p50Ms, p95Ms: lazyTiming.p95Ms, maxMs: lazyTiming.maxMs, failureIndices: lazyFailureIndices }),
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
        const rowObserver = await world.observeRenderer("user-row", scenario.marker);
        await user.press("Enter");
        const existingSample = sample(index + 1, await rowObserver.read(), { beforeEngine: false, exact: false });
        existingSendSamples.push(existingSample);
        pendingMeasurement.current = { observer: rowObserver, sample: existingSample };
        const held = await waitHeld(promptGate);
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
      "Twelve existing-session sends paint before engine work within 100 ms",
      JSON.stringify({ metric: "trusted Enter to second consecutive visible-row frame before held engine request", limitMs: sendLimitMs, count: existingTiming.count, expectedCount: sampleCount, p50Ms: existingTiming.p50Ms, p95Ms: existingTiming.p95Ms, maxMs: existingTiming.maxMs, failureIndices: existingFailureIndices }),
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
      await world.insertFocusedText(world.failure.creationB);
      await creationGate.fail();
      const creationFailure = await probe.eventually(async () => ({
        composer: await visibleFacts(world.failure.creationA),
        recovery: await recoveryUiFacts(creationRestoreLabel, originalFailureMessage),
      }), {
        within: 15_000,
        label: "creation failure preserves editable draft B, the original failure, and a guarded restore action",
        until: (state) => state.composer.composerEditable
          && state.composer.composerText === world.failure.creationB
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
      await world.insertFocusedText(world.failure.promptB);
      await promptGate.fail();
      const promptFailure = await probe.eventually(async () => ({
        composer: await visibleFacts(world.failure.promptA),
        recovery: await recoveryUiFacts(existingRestoreLabel, originalFailureMessage),
      }), {
        within: 15_000,
        label: "prompt failure preserves editable draft B, the original failure, and a guarded restore action",
        until: (state) => state.composer.composerEditable
          && state.composer.composerText === world.failure.promptB
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
      await rowObserver[Symbol.asyncDispose]();
    });

    await step("a separately held real response reconciles from SSE without duplicate rows", async () => {
      await openSession(world.existing);
      await user.type({ placeholder: "Describe your task..." }, world.responseHold.marker, { replace: true, verify: true });
      const inventoryBefore = await world.sessionIds();
      const requestsBefore = readFaults();
      const responseGate = faults.holdNext("prompt", "response");
      const rowObserver = await world.observeRenderer("user-row", world.responseHold.marker);
      await user.press("Enter");
      const responseHeld = await waitHeld(responseGate);
      const sseBeforeResponse = await probe.eventually(async () => {
        const visible = await visibleFacts(world.responseHold.marker);
        const userBackend = await world.messageFacts(world.existing.sessionId, world.responseHold.marker);
        const replyBackend = await world.messageFacts(world.existing.sessionId, world.responseHold.reply);
        return {
          ready: visible.rowCount > 0 && visible.markerOccurrences > 0 && await surfaceContains(world.responseHold.reply)
            && userBackend.markerOccurrences > 0 && replyBackend.markerOccurrences > 0,
          responseStillHeld: !responseGate.read().released,
        };
      }, {
        within: 20_000,
        label: "SSE renders the real operation while its HTTP response remains held",
        until: (facts) => facts.ready && facts.responseStillHeld,
      }).then((facts) => facts.ready && facts.responseStillHeld, () => false);
      await responseGate.release();
      await waitReply(world.responseHold.reply);
      await waitRenderer(rowObserver);
      await rowObserver[Symbol.asyncDispose]();
      const beforeReload = await visibleFacts(world.responseHold.marker);
      const beforeReloadProof = {
        providerRequestCount: await world.providerRequestCount(world.responseHold.marker),
        sessionIds: await world.sessionIds(),
        nativeUser: await world.messageFacts(world.existing.sessionId, world.responseHold.marker),
        nativeReply: await world.messageFacts(world.existing.sessionId, world.responseHold.reply),
        visibleUser: await world.visibleMessageFacts(world.existing.sessionId, "user", world.responseHold.marker),
        visibleReply: await world.visibleMessageFacts(world.existing.sessionId, "assistant", world.responseHold.reply),
      };
      await faults.suspend();
      await user.reload();
      await probe.eventually(activeSessionId, {
        within: 30_000,
        label: "response-stage session remains selected after reload",
        until: (sessionId) => sessionId === world.existing.sessionId,
      });
      await faults.resume();
      const afterReload = await probe.eventually(() => visibleFacts(world.responseHold.marker), {
        within: 30_000,
        label: "reloaded SSE-reconciled row remains exactly once",
        until: (facts) => facts.rowCount > 0 && facts.markerOccurrences > 0,
      });
      const backend = await world.messageFacts(world.existing.sessionId, world.responseHold.marker);
      const replyBackend = await world.messageFacts(world.existing.sessionId, world.responseHold.reply);
      const afterReloadProof = {
        providerRequestCount: await world.providerRequestCount(world.responseHold.marker),
        sessionIds: await world.sessionIds(),
        visibleUser: await world.visibleMessageFacts(world.existing.sessionId, "user", world.responseHold.marker),
        visibleReply: await world.visibleMessageFacts(world.existing.sessionId, "assistant", world.responseHold.reply),
      };
      const requestsAfter = readFaults();
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
        && beforeReloadProof.visibleReply.rowCount === 1 && beforeReloadProof.visibleReply.markerOccurrences === 1
        && backend.markerCount === 1 && backend.markerOccurrences === 1
        && replyBackend.markerCount === 1 && replyBackend.markerOccurrences === 1
        && afterReloadProof.visibleUser.rowCount === 1 && afterReloadProof.visibleUser.markerOccurrences === 1
        && afterReloadProof.visibleReply.rowCount === 1 && afterReloadProof.visibleReply.markerOccurrences === 1
        && requestsAfter.prompt - requestsBefore.prompt === 1
        && requestsAfter.creation === requestsBefore.creation
        && JSON.stringify(await world.sessionIds()) === JSON.stringify(inventoryBefore);
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
      "Held, failed, navigated, SSE-reconciled, and reloaded sends remain singular and preserve drafts",
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
