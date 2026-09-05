import { expect } from "vitest";
import { eventually, observeTranscript, spec } from "@openwork/testkit";
import { streamedMarkdown, streamedMarkdownMarker } from "../worlds/chat.ts";

const test = spec.world(streamedMarkdown, { timeout: 300_000 });
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
  await using transcript = await observeTranscript(probe, [
    { role: "user", text: prompt },
    ...blockSentinels.map((text): { role: "assistant"; text: string } => ({ role: "assistant", text })),
  ]);
  await user.type("composer", prompt);
  await user.click("Run task");
  await user.see({ text: prompt }, { timeoutMs: 2_000 });

  await step("finished blocks render as markdown while later blocks are still arriving", async () => {
    await user.see({ text: headingText }, { timeoutMs: 90_000 });
    await user.notSee({ text: closingText });
    await user.notSee({ text: "## Streamed" });
  });

  await step("the settled answer shows every block exactly once and no markdown syntax", async () => {
    await user.see({ text: closingText }, { timeoutMs: 120_000 });
    await user.see("Run task", { timeoutMs: 60_000 });
    expectSettledDocument(await probe.text());
    await user.see({ text: "alpha list item" });
    await user.see({ text: 'const streamed = "delta";' });
    await user.notSee({ text: /Something went wrong/ });
  });

  await step("sent text and streamed blocks never disappear or duplicate", async () => {
    expect(await transcript.finish()).toMatchObject({
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
      within: 5_000, until: (state) => state?.time > 0,
    });
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
  });
});
