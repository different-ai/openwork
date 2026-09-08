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
  await user.click("Run task");

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
    await expectTargets([...oldTargets, world.latestTool], false);
    await agent.run("session.open", { sessionId: world.session.sessionId });
    await user.see({ text: world.closing });
    expect(await orderedHistory()).toEqual(world.history);
    await expectTargets([...oldTargets, world.latestTool]);
  });

  await step("cold reload keeps the bounded history tail ordered and old and new tool links usable", async () => {
    const bounded = await probe.desktopApi(`${world.historyPath}?limit=140`);
    expect(bounded.status).toBe(200);
    expect(bounded.body).toHaveLength(140);
    const retainedHistory = world.history.filter(text => JSON.stringify(bounded.body).includes(text));
    expect(retainedHistory.length).toBeGreaterThan(0);
    expect(retainedHistory.length).toBeLessThan(world.history.length);
    await user.reload();
    await user.see({ text: world.closing }, { timeoutMs: 60_000 });
    expect(await orderedHistory()).toEqual(retainedHistory);
    expect(occurrences((await readTranscriptMessages(probe, "user")).join("\n"), world.prompt)).toBe(1);
    expect(occurrences((await readTranscriptMessages(probe, "assistant")).join("\n"), world.closing)).toBe(1);
    await expectTargets([...oldTargets, world.latestTool]);
    await user.notSee({ text: /Something went wrong/ });
  });
});
