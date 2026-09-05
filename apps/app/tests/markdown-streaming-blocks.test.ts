import { describe, expect, test } from "bun:test";

import {
  createStreamingMarkdownRenderer,
  renderMarkdownHtml,
  type MarkdownBlockHtml,
} from "../src/components/markdown/markdown-primitive";

// Without a window DOMPurify is inert here, so these assertions compare the
// lexer and parser output that the incremental path actually changes. The
// sanitizer decides per node from allowlists and carries no state between
// sibling blocks, so sanitizing each block on its own yields the same markup.
const joined = (blocks: MarkdownBlockHtml[]) => blocks.map((block) => block.__html).join("");

/** Feed `text` to the renderer a few characters at a time, like a streaming answer. */
function streamThrough(text: string, chunk: number) {
  const renderer = createStreamingMarkdownRenderer();
  const frames: MarkdownBlockHtml[][] = [];
  for (let end = chunk; end < text.length; end += chunk) frames.push(renderer.render(text.slice(0, end)));
  frames.push(renderer.render(text));
  return { renderer, frames };
}

// Shapes where a later line retroactively changes how an earlier line is read:
// setext underlines, lazy list continuation, loose list items after a blank
// line, a table delimiter row, fences and HTML blocks with blank lines inside,
// nested lists, math, and a raw HTML block.
const DOCUMENT = `# Heading

Intro paragraph with **bold**, \`inline.ts\`, and a [link](https://example.com).

Setext title
============

- first item
continues lazily
- second item

  a loose paragraph inside the second item
- third item
  - nested
  - list

| Column | Value |
| --- | --- |
| alpha | 1 |
| beta | 2 |

\`\`\`ts
const a = 1;

const b = 2;
\`\`\`

<div align="center">

inside html

</div>

Display math $$E = mc^2$$ and inline $x$.

> quoted
> lines

Trailing paragraph ***
`;

describe("streaming markdown blocks", () => {
  test("every streamed frame renders the same HTML as the whole-document renderer", () => {
    for (const chunk of [1, 7, 40]) {
      const { frames } = streamThrough(DOCUMENT, chunk);
      let end = chunk;
      for (const blocks of frames) {
        const text = DOCUMENT.slice(0, Math.min(end, DOCUMENT.length));
        expect(joined(blocks)).toBe(renderMarkdownHtml(text));
        end += chunk;
      }
    }
  });

  test("settled blocks keep their payload identity while later blocks stream in", () => {
    const renderer = createStreamingMarkdownRenderer();
    const settled = "# Title\n\nFirst paragraph.\n\n- one\n- two\n\n";
    const before = renderer.render(`${settled}Second par`);
    const after = renderer.render(`${settled}Second paragraph grows.\n\nThird`);

    expect(before.length).toBeGreaterThanOrEqual(4);
    // Everything before the growing tail is the exact same object, so React
    // leaves that DOM alone.
    for (let index = 0; index < before.length - 2; index += 1) {
      expect(after[index]).toBe(before[index]);
    }
    expect(joined(after)).toBe(renderMarkdownHtml(`${settled}Second paragraph grows.\n\nThird`));
    // The same text returns the same array without re-rendering.
    expect(renderer.render(`${settled}Second paragraph grows.\n\nThird`)).toBe(after);
  });

  test("a growing tail can reshape its predecessor block", () => {
    const renderer = createStreamingMarkdownRenderer();
    renderer.render("# Title\n\n- one\n- two\n\nbecomes a heading");
    const blocks = renderer.render("# Title\n\n- one\n- two\n\nbecomes a heading\n===");

    expect(joined(blocks)).toBe(renderMarkdownHtml("# Title\n\n- one\n- two\n\nbecomes a heading\n==="));
    expect(joined(blocks)).toContain("<h1");
  });

  test("reference definitions resolve across blocks on every frame", () => {
    const renderer = createStreamingMarkdownRenderer();
    const withoutDefinition = "# Title\n\nSee [the docs][docs] for more.\n\nAnother paragraph.\n\n";
    expect(joined(renderer.render(withoutDefinition))).toBe(renderMarkdownHtml(withoutDefinition));
    expect(joined(renderer.render(withoutDefinition))).not.toContain("<a ");

    const withDefinition = `${withoutDefinition}[docs]: https://example.com/docs\n`;
    const blocks = renderer.render(withDefinition);
    expect(joined(blocks)).toBe(renderMarkdownHtml(withDefinition));
    expect(joined(blocks)).toContain('href="https://example.com/docs"');

    // Once a definition exists, a later append still re-renders exactly.
    const appended = `${withDefinition}\nAnd [the docs][docs] again.\n`;
    expect(joined(renderer.render(appended))).toBe(renderMarkdownHtml(appended));
  });

  test("replaced text and Windows line endings fall back to a full render that still reuses unchanged blocks", () => {
    const renderer = createStreamingMarkdownRenderer();
    const first = renderer.render("# Title\r\n\r\nParagraph one.\r\n\r\nParagraph two.");
    expect(joined(first)).toBe(renderMarkdownHtml("# Title\n\nParagraph one.\n\nParagraph two."));

    const replaced = renderer.render("# Title\n\nParagraph one.\n\nA different second paragraph.");
    expect(joined(replaced)).toBe(renderMarkdownHtml("# Title\n\nParagraph one.\n\nA different second paragraph."));
    expect(replaced[0]).toBe(first[0]);
    expect(replaced[replaced.length - 1]).not.toBe(first[first.length - 1]);
  });

  test("blank and whitespace-only text renders no visible blocks", () => {
    const renderer = createStreamingMarkdownRenderer();
    expect(renderer.render("")).toEqual([]);
    expect(renderer.render("  \n\n ").every((block) => block.__html === "")).toBe(true);
  });

  test("reset drops the retained frame so the next render starts fresh", () => {
    const renderer = createStreamingMarkdownRenderer();
    const first = renderer.render("# Title\n\nParagraph.");
    renderer.reset();
    const second = renderer.render("# Title\n\nParagraph.");
    expect(joined(second)).toBe(joined(first));
    expect(second).not.toBe(first);
  });
});
