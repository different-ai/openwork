import { expect } from "vitest";
import { eventually, observeTranscript, readTranscriptMessages, spec } from "@openwork/testkit";
import { streamedMarkdown, streamedMarkdownMarker, streamedMarkdownReasoning, streamedToolHistory } from "../worlds/chat.ts";
import {
  chatStreamContinuityWeb,
  streamedContinuityBullets,
  streamedContinuityChunks,
  streamedContinuityMarker,
  streamedContinuityPartialFifth,
  streamedContinuityPartialSeventh,
  streamedContinuityPartialThird,
  streamedContinuityPrompt,
} from "../worlds/chat-stream-continuity.ts";

const test = spec.world(streamedMarkdown, { timeout: 420_000 });
const prompt = `Write the streamed markdown answer. ${streamedMarkdownMarker}`;

const headingText = "Streamed answer heading";
const closingText = "Closing paragraph epsilon.";
// One sentinel per block of the answer; each must be on screen exactly once.
const blockSentinels = [
  headingText,
  "Opening paragraph with",
  "alpha list item",
  "beta list item",
  "gamma row",
  'const streamed = "delta";',
  closingText,
];
// Markdown syntax that must be rendered, never shown as text.
const rawSyntax = ["## Streamed", "**bold emphasis**", "`inline-code.ts`", "- alpha", "| gamma row", "```"];

const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

function expectSettledDocument(visibleText: string) {
  for (const sentinel of blockSentinels) expect(occurrences(visibleText, sentinel)).toBe(1);
  for (const syntax of rawSyntax) expect(visibleText).not.toContain(syntax);
}

test("sending clears the composer and shows one pending turn in existing and new conversations", async ({ world, user, probe, step }) => {
  for (const scenario of ["existing", "new"]) {
    if (scenario === "new") await user.click({ role: "button", label: "New task" });
    const text = `Keep this ${scenario} conversation message while submission is delayed.`;
    await user.type("composer", text);
    await world.holdNextSubmission();
    await step(`${scenario}: Send clears the input before server acceptance`, async () => {
      await user.click("Run task");
      await user.see("composer", { text: "", timeoutMs: 500 });
      await user.see({ text }, { timeoutMs: 500 });
      expect(await probe.eventually(() => world.submissionAttempts(), {
        within: 20_000, label: "held submission", until: (count) => count === 1,
      })).toBe(1);
      expect((await probe.composer()).draftText).toBe("");
      expect(occurrences(await probe.text(), text)).toBe(1);
    });
    await step(`${scenario}: failure retains the message without replacing newer typing`, async () => {
      await user.type("composer", "A newer draft");
      await world.rejectSubmission();
      await user.see({ text: /Your unsent message is saved/ });
      expect((await probe.composer()).draftText).toBe("A newer draft");
      expect(await world.submissionAttempts()).toBe(1);
      await user.type("composer", "", { replace: true });
      await user.click("Restore unsent message");
      await user.see("composer", { text });
      expect(await world.submissionAttempts()).toBe(1);
    });
  }
});

test("a streaming answer renders as markdown block by block and settles to the same document", async ({ world, user, probe, step }) => {
  const entries = [
    { role: "user", text: prompt } satisfies { role: "user"; text: string },
    ...blockSentinels.map((text): { role: "assistant"; text: string } => ({ role: "assistant", text })),
  ];
  await using transcript = await observeTranscript(probe, entries);
  await user.type("composer", prompt);
  await user.click("Run task");
  await user.see({ text: prompt }, { timeoutMs: 2_000 });

  await step("finished blocks render as markdown while later blocks are still arriving", async () => {
    await user.see({ text: headingText }, { timeoutMs: 90_000 });
    await user.notSee({ text: closingText });
    await user.notSee({ text: "## Streamed" });
    await user.notSee({ text: streamedMarkdownReasoning });
  });

  await step("live reasoning can be inspected before any reload while the answer is still streaming", async () => {
    const reasoningControl = { role: "button", label: /^(Thinking…|Thought)$/ } as const;
    await user.see(reasoningControl);
    await user.click(reasoningControl);
    await user.see({ text: streamedMarkdownReasoning });
    expect(occurrences(await probe.text(), streamedMarkdownReasoning)).toBe(1);
    await user.notSee({ text: closingText });
    await user.click(reasoningControl);
    await user.notSee({ text: streamedMarkdownReasoning });
  });

  await step("sent text and finished blocks stay visible before reloading the active stream", async () => {
    // The observer belongs to this document and must be verified before navigation.
    const continuity = await transcript.finish();
    expect(continuity).toMatchObject({ violations: [], stopped: false, frames: expect.any(Number) });
    expect(continuity.seen.slice(0, 2)).toEqual([true, true]);
    await user.notSee({ text: closingText });
    await user.reload();
  });
  await using reloadedTranscript = await observeTranscript(probe, entries);

  await step("the settled answer shows every block exactly once and no markdown syntax", async () => {
    await user.see({ text: closingText }, { timeoutMs: 120_000 });
    await user.see("Run task", { timeoutMs: 60_000 });
    expectSettledDocument(await probe.text());
    await user.see({ text: "alpha list item" });
    await user.see({ text: 'const streamed = "delta";' });
    await user.notSee({ text: /Something went wrong/ });
    await user.notSee({ text: streamedMarkdownReasoning });
  });

  await step("the settled reasoning is collapsed and can be inspected separately", async () => {
    await user.click({ role: "button", label: "Thought" });
    await user.see({ text: streamedMarkdownReasoning });
    expect(occurrences(await probe.text(), streamedMarkdownReasoning)).toBe(1);
    expectSettledDocument(await probe.text());
  });

  await step("sent text and streamed blocks never disappear or duplicate after reload", async () => {
    expect(await reloadedTranscript.finish()).toMatchObject({
      seen: [true, ...blockSentinels.map(() => true)],
      violations: [],
      stopped: false,
      frames: expect.any(Number),
    });
  });

  await step("a referenced workspace video has controls and plays only when requested", async () => {
    const ready = await eventually(() => world.videoState(), {
      within: 30_000, until: (state) => state?.ready === true,
    });
    expect(ready).toMatchObject({ controls: true, autoplay: false, paused: true, error: null });
    await world.videoState(true);
    const playing = await eventually(() => world.videoState(), {
      within: 5_000, until: (state) => (state?.time ?? 0) > 0,
    });
    if (!playing) throw new Error("Video disappeared during playback");
    expect(playing.time).toBeGreaterThan(0);
    expect(playing.error).toBeNull();
  });

  await step("history renders the same document after a reload", async () => {
    await user.reload();
    await user.see({ text: closingText }, { timeoutMs: 120_000 });
    expectSettledDocument(await probe.text());
    await user.see({ text: prompt });
    await user.see({ text: headingText });
    const video = await eventually(() => world.videoState(), {
      within: 30_000, until: (state) => state?.ready === true,
    });
    expect(video).toMatchObject({ controls: true, paused: true, autoplay: false, error: null });
    await user.notSee({ text: streamedMarkdownReasoning });
  });

  await step("reloaded reasoning stays collapsed until inspected separately", async () => {
    await user.click({ role: "button", label: "Thought" });
    await user.see({ text: streamedMarkdownReasoning });
    expect(occurrences(await probe.text(), streamedMarkdownReasoning)).toBe(1);
    expectSettledDocument(await probe.text());
  });
});

const historyTest = spec.world(streamedToolHistory, { timeout: 420_000 });

historyTest("v1 keeps long tool-rich history ordered and its detected links available as the answer advances", { timeout: 15 * 60_000 }, async ({ world, user, agent, probe, step, place }) => {
  const orderedHistory = async () => (await readTranscriptMessages(probe, "user"))
    .flatMap(text => text.match(/Settled history \d{3}\./g) ?? []);
  const expectTargets = async (names: string[], present = true) => {
    await user.press(place.kind === "local" && process.platform === "darwin" ? "Meta+K" : "Control+K");
    const rootSearch = { placeholder: "Search actions, settings, and sessions…" };
    await user.type(rootSearch, "Accessible items", { replace: true });
    await user.click({ role: "option", label: /^Accessible items/ });
    const search = { placeholder: "Search servers and artifacts..." };
    for (const name of names) {
      await user.type(search, name, { replace: true });
      if (present) await user.see({ role: "option", label: new RegExp(`^${name}\\b`) });
      else await user.notSee({ role: "option", label: new RegExp(`^${name}\\b`) });
    }
    await user.press("Escape");
    await user.notSee(search);
    await user.press("Escape");
    await user.notSee(rootSearch);
  };
  const oldTargets = [world.toolNames[0]!, world.toolNames.at(-1)!];
  const surface = `[data-session-surface-id="${world.session.sessionId}"]`;
  const viewportSelector = `${surface} > div > .overflow-y-auto`;
  const userRowsSelector = `${viewportSelector} [data-message-role="user"]`;
  const transcriptGeometry = async () => {
    const [viewport, composer, rows, texts] = await Promise.all([
      probe.dom(viewportSelector),
      probe.dom(`${surface} > div:has([data-lexical-editor="true"])`),
      probe.dom(userRowsSelector),
      probe.dom(`${userRowsSelector} span.whitespace-pre-wrap`),
    ]);
    expect(viewport.elements).toHaveLength(1);
    expect(composer.elements).toHaveLength(1);
    expect(rows.elements.length).toBeGreaterThan(0);
    expect(texts.elements).toHaveLength(rows.elements.length);
    return {
      viewport: viewport.elements[0]!.rect,
      composer: composer.elements[0]!.rect,
      rows: rows.elements.map((row, index) => ({ rect: row.rect, text: texts.elements[index]!.text })),
    };
  };
  const browseHistory = async () => {
    await user.click({ text: world.history[74]! });
    const initialTop = (await probe.dom(userRowsSelector)).elements[74]!.rect.top;
    await user.press("PageUp");
    let previousTop = Number.NaN;
    return probe.eventually(async () => {
      const geometry = await transcriptGeometry();
      const top = geometry.rows[74]!.rect.top;
      const stable = Math.abs(top - previousTop) <= 1;
      previousTop = top;
      expect(top).toBeGreaterThan(initialTop + 16);
      expect(geometry.rows.at(-1)!.rect.top).toBeGreaterThanOrEqual(geometry.viewport.bottom);
      expect(geometry.rows.some(({ rect }) => rect.top >= geometry.viewport.top && rect.bottom <= geometry.viewport.bottom)).toBe(true);
      return { ...geometry, stable };
    }, { within: 5_000, label: "keyboard browsing settles above the latest turn", until: (value) => value.stable });
  };
  const scrollStorageKey = "openwork:session-scroll:v1";
  const savedScroll = (sessionId: string): Promise<unknown> => probe.storage(scrollStorageKey, (value): unknown =>
    value && typeof value === "object" ? Reflect.get(value, sessionId) ?? null : null);
  const readingGeometry = async (messageId: string) => {
    const { elements } = await probe.dom(`${viewportSelector}, ${surface} [data-message-id="${messageId}"]`);
    const [viewport, message] = elements;
    if (elements.length !== 2 || !viewport || !message) return null;
    return { text: message.text, offset: message.rect.top - viewport.rect.top,
      visible: message.rect.bottom > viewport.rect.top && message.rect.top < viewport.rect.bottom };
  };

  await step("the live cache retains history older than the native 140-message snapshot", async () => {
    expect(await orderedHistory()).toEqual(world.history);
    const bounded = await probe.desktopApi(`${world.historyPath}?limit=140`);
    expect(bounded.status).toBe(200);
    expect(bounded.body).toHaveLength(140);
    expect(JSON.stringify(bounded.body)).not.toContain(world.history[0]);
    expect(JSON.stringify(bounded.body)).toContain(world.history.at(-1));
    await expectTargets(oldTargets);
    await expectTargets([world.latestTool], false);
  });

  await using transcript = await observeTranscript(probe, [
    ...[world.history[0]!, world.history[74]!, world.history[149]!].map((text): { role: "user"; text: string } => ({ role: "user", text })),
    { role: "user", text: world.prompt },
    { role: "assistant", text: world.opening },
  ]);
  await user.type("composer", world.prompt);
  await step("sending from older history reveals the exact latest user row above the composer without Jump to latest", async () => {
    await browseHistory();
    await user.click("Run task");
    // user.see() scrolls its target into view and would mask this regression.
    await probe.eventually(async () => {
      const { viewport, composer, rows } = await transcriptGeometry();
      const latest = rows.at(-1)!;
      expect(latest.text).toBe(world.prompt);
      expect(rows.filter(({ text }) => text === world.prompt)).toHaveLength(1);
      expect(latest.rect.width).toBeGreaterThan(0);
      expect(latest.rect.height).toBeGreaterThan(0);
      expect(latest.rect.left).toBeGreaterThanOrEqual(viewport.left);
      expect(latest.rect.right).toBeLessThanOrEqual(viewport.right);
      expect(latest.rect.top).toBeGreaterThanOrEqual(viewport.top);
      expect(latest.rect.bottom).toBeLessThanOrEqual(Math.min(viewport.bottom, composer.top));
      return true;
    }, { within: 5_000, label: "submitted user row inside the transcript viewport" });
  });

  await step("new tool output becomes accessible without losing old targets while text grows", async () => {
    await user.see({ text: world.opening }, { timeoutMs: 90_000 });
    await user.notSee({ text: world.closing });
    expect(await orderedHistory()).toEqual(world.history);
    // These options come from detected tool output, not markdown links in the answer.
    await expectTargets([...oldTargets, world.latestTool]);
    await user.see({ text: world.middle }, { timeoutMs: 90_000 });
    await user.notSee({ text: world.closing });
    expect(await orderedHistory()).toEqual(world.history);
  });

  await step("passive streamed output does not jump away from the history being read", async () => {
    const before = await browseHistory();
    const anchor = before.rows.find(({ rect }) => rect.top >= before.viewport.top && rect.bottom <= before.viewport.bottom)!;
    expect(await probe.has(world.closing)).toBe(false);
    let maxMovement = 0;
    const after = await probe.eventually(async () => {
      const complete = await probe.has(world.closing);
      const geometry = await transcriptGeometry();
      const retained = geometry.rows.find(({ text }) => text === anchor.text)!;
      maxMovement = Math.max(maxMovement, Math.abs(retained.rect.top - anchor.rect.top));
      return { ...geometry, complete };
    }, {
      within: 120_000, label: "new output arrives while browsing history", until: (value) => value.complete,
    });
    const retained = after.rows.find(({ text }) => text === anchor.text)!;
    expect(maxMovement).toBeLessThanOrEqual(2);
    expect(retained.rect.top).toBeGreaterThanOrEqual(after.viewport.top);
    expect(retained.rect.bottom).toBeLessThanOrEqual(after.viewport.bottom);
    expect(after.rows.at(-1)!.rect.top).toBeGreaterThanOrEqual(after.viewport.bottom);
  });

  await step("settled history and the advancing answer never disappear or duplicate", async () => {
    await user.see({ text: world.closing }, { timeoutMs: 120_000 });
    await user.see("Run task", { timeoutMs: 60_000 });
    expect(await orderedHistory()).toEqual(world.history);
    const answers = await readTranscriptMessages(probe, "assistant");
    const answer = answers.filter(text => text.includes(world.opening));
    expect(answer).toHaveLength(1);
    for (const sentinel of [world.opening, world.middle, world.closing]) {
      expect(occurrences(answers.join("\n"), sentinel)).toBe(1);
    }
    expect(answer[0]!.indexOf(world.opening)).toBeLessThan(answer[0]!.indexOf(world.middle));
    expect(answer[0]!.indexOf(world.middle)).toBeLessThan(answer[0]!.indexOf(world.closing));
    expect(await transcript.finish()).toMatchObject({ seen: [true, true, true, true, true], violations: [], stopped: false });
  });

  const readingPosition = await step("choose a reading message inside the retained history tail", async () => {
    await user.press(place.kind === "local" && process.platform === "darwin" ? "Meta+f" : "Control+f");
    await user.type({ placeholder: "Find in conversation" }, world.history[129]!, { replace: true });
    await user.see({ text: world.history[129]! });
    await user.click({ role: "button", label: "Close find" });
    return probe.eventually(async () => {
      const saved: unknown = await savedScroll(world.session.sessionId);
      if (!saved || typeof saved !== "object" || !("mode" in saved) || saved.mode !== "manual"
        || !("anchor" in saved) || !saved.anchor || typeof saved.anchor !== "object"
        || !("messageId" in saved.anchor) || typeof saved.anchor.messageId !== "string"
        || !("offset" in saved.anchor) || typeof saved.anchor.offset !== "number") return null;
      const geometry = await readingGeometry(saved.anchor.messageId);
      if (!geometry?.visible || !world.history.slice(100).some(text => geometry.text.includes(text))
        || Math.abs(geometry.offset - saved.anchor.offset) > 2) return null;
      return { messageId: saved.anchor.messageId, text: geometry.text, offset: geometry.offset };
    }, { within: 10_000, label: "persisted visible reading anchor", until: value => value !== null });
  });
  if (!readingPosition) throw new Error("No retained reading position was captured");
  const neighborScroll = await savedScroll(world.neighbor.sessionId);
  const expectReadingPosition = async () => {
    const geometry = await probe.eventually(() => readingGeometry(readingPosition.messageId), {
      within: 60_000, label: "same reading message and viewport offset",
      until: value => Boolean(value?.visible && Math.abs(value.offset - readingPosition.offset) <= 2),
    });
    expect(geometry?.text).toBe(readingPosition.text);
    expect(geometry?.visible).toBe(true);
    expect(Math.abs(geometry!.offset - readingPosition.offset)).toBeLessThanOrEqual(2);
    expect(await savedScroll(world.neighbor.sessionId)).toEqual(neighborScroll);
  };

  await step("switching conversations preserves the reading position, full cached history and scoped targets", async () => {
    await agent.run("session.open", { sessionId: world.neighbor.sessionId });
    await user.see("composer", { editable: true });
    await user.notSee({ text: world.opening });
    // Return before the inactive transcript's 15-second GC window. The slower
    // palette isolation checks below deliberately belong to the cold path.
    await agent.run("session.open", { sessionId: world.session.sessionId });
    await expectReadingPosition();
    expect(await orderedHistory()).toEqual(world.history);
    await expectTargets([...oldTargets, world.latestTool]);
    await agent.run("session.open", { sessionId: world.neighbor.sessionId });
    await user.see("composer", { editable: true });
    await expectTargets([...oldTargets, world.latestTool], false);
    expect(await savedScroll(world.neighbor.sessionId)).toEqual(neighborScroll);
  });

  await step("cold reload restores the whole ordered transcript, the reading position and old and new tool links", async () => {
    // A cold open fetches the transcript without a `limit` (#4695): OpenCode
    // pages `limit` as the NEWEST n messages, so the engine's bounded page still
    // lacks the oldest turn while the reopened surface must show every message.
    const bounded = await probe.desktopApi(`${world.historyPath}?limit=140`);
    expect(bounded.status).toBe(200);
    expect(bounded.body).toHaveLength(140);
    expect(JSON.stringify(bounded.body)).not.toContain(world.history[0]);
    await agent.run("session.open", { sessionId: world.session.sessionId });
    await user.reload();
    await expectReadingPosition();
    expect(await orderedHistory()).toEqual(world.history);
    expect(occurrences((await readTranscriptMessages(probe, "user")).join("\n"), world.prompt)).toBe(1);
    expect(occurrences((await readTranscriptMessages(probe, "assistant")).join("\n"), world.closing)).toBe(1);
    await expectTargets([...oldTargets, world.latestTool]);
    await user.notSee({ text: /Something went wrong/ });
  });
});

const continuityTest = spec.world(chatStreamContinuityWeb, {
  timeout: 420_000,
  resources: { surfaces: ["appWeb"], services: ["mock"] },
});
const normalizedLines = (text: string) => text.split("\n").map((line) => line.trim()).filter(Boolean).join("\n");
const partialThirdPrefix = [streamedContinuityBullets[0], streamedContinuityBullets[1], streamedContinuityPartialThird].join("\n");
const partialFifthPrefix = [...streamedContinuityBullets.slice(0, 4), streamedContinuityPartialFifth].join("\n");
const partialSeventhPrefix = [...streamedContinuityBullets.slice(0, 6), streamedContinuityPartialSeventh].join("\n");
const completeContinuityAnswer = streamedContinuityBullets.join("\n");

continuityTest("CONT-01 restores the exact cumulative prefix while one answer streams across conversation switches", async ({ world, user, probe, step, evidence }) => {
  const assistantText = async () => {
    const messages = await readTranscriptMessages(probe, "assistant");
    return { messages, text: normalizedLines(messages.join("\n")) };
  };
  const expectOneUserAdmission = async () => {
    const messages = await readTranscriptMessages(probe, "user");
    expect(messages).toHaveLength(1);
    expect(occurrences(messages[0] ?? "", streamedContinuityPrompt)).toBe(1);
  };
  const select = async (target: { sessionId: string; title: string }) => {
    await user.click({ text: target.title });
    return probe.eventually(() => world.continuity.surfaceState("primary"), {
      within: 15_000,
      intervalMs: 100,
      label: `visible conversation ${target.title}`,
      until: (state) => state.sessionId === target.sessionId,
    });
  };
  const waitForEngineHttpPrefix = (prefix: string, forbidden: string) => probe.eventually(
    () => world.engineHttpEvents(),
    {
      within: 15_000,
      intervalMs: 25,
      label: "real app engine HTTP stream received the exact released prefix",
      until: (state) => state.streams > 0 && state.text.includes(prefix) && !state.text.includes(forbidden),
    },
  );
  const promptPosts = async () => (await world.engineHttpEvents()).promptPosts[world.session.sessionId] ?? 0;
  const observeWarmReturn = async (
    exact: string,
    forbidden: string,
    options: { allowInitialCatchup?: boolean; required?: string[] } = {},
  ) => {
    await using observer = await world.continuity.observeSurface({
      sessionId: world.session.sessionId,
      pane: "primary",
      role: "assistant",
      exact,
      allowInitialCatchup: options.allowInitialCatchup,
      required: options.required,
      forbidden: [forbidden],
    });
    await user.click({ text: world.session.title });
    const state = await probe.eventually(() => observer.read(), {
      within: 1_500,
      intervalMs: 25,
      label: "exact cached prefix on warm conversation return",
      until: (value) => value.satisfiedAtMs !== null,
    });
    expect(state.text).toBe(exact);
    if (state.violations.length > 0) {
      evidence.recordAssertionEvidence(
        "Warm return transition diagnostics",
        JSON.stringify({ firstViolation: state.firstViolation, transitionSamples: state.transitionSamples }),
        false,
      );
    }
    expect(state.violations).toEqual([]);
    if (state.satisfiedAtMs === null) throw new Error("Warm return never rendered the authoritative prefix.");
    expect(state.actionCaptured).toBe(true);
    if (state.satisfiedAfterActionMs === null) throw new Error("Warm return did not retain the sidebar click timestamp.");
    expect(state.satisfiedAfterActionMs).toBeLessThan(500);
    const retained = await probe.eventually(() => observer.read(), {
      within: 500,
      intervalMs: 16,
      label: "exact returned prefix remains stable after catch-up",
      until: (value) => value.frames >= state.frames + 2,
    });
    expect(retained.text).toBe(exact);
    expect(retained.violations).toEqual([]);
    return state.satisfiedAfterActionMs;
  };
  for (const bullet of streamedContinuityBullets) expect(streamedContinuityPrompt).not.toContain(bullet);

  await step("the selected engine runs in the real headless app-web world", async () => {
    const facts = await world.runtimeFacts();
    evidence.recordJsonArtifact("CONT-01 runtime placement", facts);
    expect(facts.surface).toBe("web");
    expect(facts.requestedPlacement).toBe(facts.resolvedPlacement);
    expect(facts.actualHostKind).toBe(facts.resolvedPlacement);
    if (facts.actualHostKind === "daytona") expect(facts.actualSandboxId).toMatch(/^.+$/);
    else expect(facts.actualSandboxId).toBeNull();
    expect(facts.healthStatus).toBe(200);
    expect(facts.engineStatus).toBe(200);
    expect(facts.engineChatRouting).toBe(world.engine === "v2");
    expect(facts.nativeStatus).toBe(200);
    expect(facts.tokenPresent).toBe(true);
    expect(facts.serverPortPresent).toBe(true);
    if (world.engine === "v2") {
      expect(facts.engineRunning).toBe(true);
      expect(facts.syntheticModelInNativeResponse).toBe(true);
    }
    expect(facts.electronBridge).toBe(false);
    expect(facts.origin).toBe(facts.expectedOrigin);
    expect(facts.browser).toMatch(/HeadlessChrome\//);
    if (facts.actualHostKind === "daytona") expect(facts.actualSourceSha).toMatch(/^[0-9a-f]{40,64}$/);
    else if (facts.actualSourceSha !== null) expect(facts.actualSourceSha).toMatch(/^[0-9a-f]{40,64}$/);
    evidence.recordAssertionEvidence(
      "Continuity headless app-web and engine fixture are real",
      `${facts.surface}; ${world.engine}; requested/resolved/actual placement=${facts.requestedPlacement}/${facts.resolvedPlacement}/${facts.actualHostKind}; sandbox=${facts.actualSandboxId ?? "none"}; ${facts.browser}; native ${facts.nativeStatus}; no Electron bridge=${String(!facts.electronBridge)}`,
      true,
    );
  });

  await step("one real send admits once and renders only the initially released first bullet", async () => {
    await user.type("composer", streamedContinuityPrompt);
    await user.click("Run task");
    await user.see({ text: streamedContinuityPrompt }, { timeoutMs: 2_000 });
    const gate = await probe.eventually(() => world.replyState(), {
      within: 90_000,
      intervalMs: 100,
      label: "provider held after the first exact chunk",
      until: (state) => state.deliveredChunks === 1,
    });
    expect(gate.prefix).toBe(streamedContinuityChunks[0]);
    const rendered = await probe.eventually(assistantText, {
      within: 5_000,
      intervalMs: 50,
      label: "only bullet one is rendered",
      until: (value) => value.messages.length === 1 && value.text === streamedContinuityBullets[0],
    });
    expect(rendered.text).toBe(streamedContinuityBullets[0]);
    await expectOneUserAdmission();
    expect(await promptPosts()).toBe(1);
    expect(await world.providerFinalRequests()).toHaveLength(1);
  });

  await step("B remains empty while bullet two and partial bullet three advance only in A", async () => {
    await select(world.neighbor);
    expect(await readTranscriptMessages(probe, "user")).toEqual([]);
    expect(await readTranscriptMessages(probe, "assistant")).toEqual([]);
    await world.releaseReply(2);
    const gate = await probe.eventually(() => world.replyState(), {
      within: 15_000,
      intervalMs: 50,
      label: "provider released bullet two and partial bullet three",
      until: (state) => state.deliveredChunks === 3,
    });
    expect(gate.prefix).toBe(streamedContinuityChunks.slice(0, 3).join(""));
    await waitForEngineHttpPrefix(streamedContinuityPartialThird, streamedContinuityBullets[2]);
    expect(await promptPosts()).toBe(1);
    expect(await world.providerFinalRequests()).toHaveLength(1);
    const b = await world.readNative(world.neighbor.sessionId);
    expect(b.status).toBe(200);
    expect(b.text).not.toContain(streamedContinuityPrompt);
    for (const bullet of streamedContinuityBullets) expect(b.text).not.toContain(bullet);
  });

  const firstReturnMs = await step("returning while bullet three is partial commits the exact full prefix in under 500ms", async () => {
    return observeWarmReturn(partialThirdPrefix, streamedContinuityBullets[2], {
      allowInitialCatchup: true,
      required: [streamedContinuityBullets[0]],
    });
  });

  await step("the same answer completes bullet three, then reaches a second mid-part switch", async () => {
    await world.releaseReply();
    const firstCumulativeGate = await probe.eventually(() => world.replyState(), {
      within: 15_000,
      intervalMs: 50,
      label: "engine provider HTTP stream reached partial bullet five",
      until: (state) => state.deliveredChunks === 4,
    });
    expect(firstCumulativeGate.prefix).toBe(streamedContinuityChunks.slice(0, 4).join(""));
    await waitForEngineHttpPrefix(streamedContinuityPartialFifth, streamedContinuityBullets[4]);
    const rendered = await probe.eventually(assistantText, {
      within: 5_000,
      intervalMs: 50,
      label: "cumulative answer through partial bullet five",
      until: (value) => value.messages.length === 1 && value.text === partialFifthPrefix,
    });
    expect(rendered.text).toBe(partialFifthPrefix);
    await select(world.neighbor);
    expect(await readTranscriptMessages(probe, "assistant")).toEqual([]);
    await world.releaseReply();
    const gate = await probe.eventually(() => world.replyState(), {
      within: 15_000,
      intervalMs: 50,
      label: "second offscreen cumulative release",
      until: (state) => state.deliveredChunks === 5,
    });
    expect(gate.prefix).toBe(streamedContinuityChunks.slice(0, 5).join(""));
    await waitForEngineHttpPrefix(streamedContinuityPartialSeventh, streamedContinuityBullets[6]);
    expect(await promptPosts()).toBe(1);
    expect(await world.providerFinalRequests()).toHaveLength(1);
  });

  const secondReturnMs = await step("a repeated middle-of-part return restores the newer cumulative prefix without replay", async () => {
    return observeWarmReturn(partialSeventhPrefix, streamedContinuityBullets[6], {
      allowInitialCatchup: true,
      required: [...streamedContinuityBullets.slice(0, 4), streamedContinuityPartialFifth],
    });
  });

  await step("the held answer finishes all ten unique bullets exactly once and leaves B unmodified", async () => {
    await world.releaseReply();
    await user.see({ text: streamedContinuityBullets[9] }, { timeoutMs: 30_000 });
    await user.see("Run task", { timeoutMs: 30_000 });
    const gate = await probe.eventually(() => world.replyState(), {
      within: 15_000,
      intervalMs: 50,
      label: "provider completed the exact controlled reply",
      until: (state) => state.complete,
    });
    expect(gate.prefix).toBe(streamedContinuityChunks.join(""));
    const assistant = await assistantText();
    expect(assistant.messages).toHaveLength(1);
    expect(assistant.text).toBe(completeContinuityAnswer);
    for (const bullet of streamedContinuityBullets) expect(occurrences(assistant.text, bullet)).toBe(1);
    await expectOneUserAdmission();
    expect(await promptPosts()).toBe(1);
    const providerRequests = await world.providerFinalRequests();
    expect(providerRequests).toHaveLength(1);
    expect(providerRequests[0]).toMatchObject({ promptMarker: streamedContinuityMarker, kind: "final" });
    const a = await world.readNative(world.session.sessionId);
    expect(a.status).toBe(200);
    expect(occurrences(a.text, streamedContinuityPrompt)).toBe(1);
    for (const bullet of streamedContinuityBullets) expect(occurrences(a.text, bullet)).toBe(1);
    const b = await world.readNative(world.neighbor.sessionId);
    expect(b.status).toBe(200);
    expect(b.text).not.toContain(streamedContinuityPrompt);
    for (const bullet of streamedContinuityBullets) expect(b.text).not.toContain(bullet);
  });

  await step("reload recovers the exact completed answer without another admission", async () => {
    await user.reload();
    await user.see({ text: streamedContinuityBullets[9] }, { timeoutMs: 60_000 });
    await user.see("Run task", { timeoutMs: 30_000 });
    const assistant = await assistantText();
    expect(assistant.messages).toHaveLength(1);
    expect(assistant.text).toBe(completeContinuityAnswer);
    await expectOneUserAdmission();
    expect(await promptPosts()).toBe(0);
    expect(await world.providerFinalRequests()).toHaveLength(1);
    const b = await world.readNative(world.neighbor.sessionId);
    expect(b.text).not.toContain(streamedContinuityPrompt);
    evidence.recordAssertionEvidence(
      "CONT-01 exact held-prefix continuity",
      `Exact 10-bullet answer once; click-to-prefix ${Math.round(firstReturnMs)}ms/${Math.round(secondReturnMs)}ms; one native prompt POST before reload and zero after; one final provider request; B empty.`,
      true,
    );
  });
});
