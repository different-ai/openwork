import { expect } from "vitest";
import { eventually, observeTranscript, readTranscriptMessages, spec } from "@openwork/testkit";
import { streamedMarkdown, streamedMarkdownMarker, streamedMarkdownReasoning, streamedToolHistory } from "../worlds/chat.ts";

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

  await step("switching conversations preserves the full cached history and keeps targets scoped", async () => {
    await agent.run("session.open", { sessionId: world.neighbor.sessionId });
    await user.see("composer", { editable: true });
    await user.notSee({ text: world.opening });
    // Return before the inactive transcript's 15-second GC window. The slower
    // palette isolation checks below deliberately belong to the cold path.
    await agent.run("session.open", { sessionId: world.session.sessionId });
    await user.see({ text: world.closing });
    expect(await orderedHistory()).toEqual(world.history);
    await expectTargets([...oldTargets, world.latestTool]);
    await agent.run("session.open", { sessionId: world.neighbor.sessionId });
    await user.see("composer", { editable: true });
    await expectTargets([...oldTargets, world.latestTool], false);
  });

  await step("cold reload keeps the bounded history tail ordered and old and new tool links usable", async () => {
    const bounded = await probe.desktopApi(`${world.historyPath}?limit=140`);
    expect(bounded.status).toBe(200);
    expect(bounded.body).toHaveLength(140);
    const retainedHistory = world.history.filter(text => JSON.stringify(bounded.body).includes(text));
    expect(retainedHistory.length).toBeGreaterThan(0);
    expect(retainedHistory.length).toBeLessThan(world.history.length);
    await agent.run("session.open", { sessionId: world.session.sessionId });
    await user.reload();
    await user.see({ text: world.closing }, { timeoutMs: 60_000 });
    expect(await orderedHistory()).toEqual(retainedHistory);
    expect(occurrences((await readTranscriptMessages(probe, "user")).join("\n"), world.prompt)).toBe(1);
    expect(occurrences((await readTranscriptMessages(probe, "assistant")).join("\n"), world.closing)).toBe(1);
    await expectTargets([...oldTargets, world.latestTool]);
    await user.notSee({ text: /Something went wrong/ });
  });
});
