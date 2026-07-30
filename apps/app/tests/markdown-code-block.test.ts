import { describe, expect, test } from "bun:test";

import { renderHighlightedMarkdownHtml, renderMarkdownHtml } from "../src/components/markdown/markdown";
import { renderHighlightedMarkdownHtml as renderPrimitiveHighlightedMarkdownHtml, renderMarkdownHtml as renderPrimitiveMarkdownHtml } from "../src/components/markdown/markdown-primitive";
import { textHighlightParts } from "../src/components/markdown/text-highlights";

const CODE = "const value = 1;\nconsole.log(value);";
const MARKDOWN = `\`\`\`ts\n${CODE}\n\`\`\``;

describe("markdown code blocks", () => {
  test("renders fallback code blocks with subtle theme-aware styling and copy affordance", () => {
    const html = renderMarkdownHtml(MARKDOWN);

    expect(html).toContain("data-openwork-code-block");
    expect(html).toContain("bg-gray-2/60");
    expect(html).toContain("data-openwork-code-copy");
    expect(html).toContain("data-openwork-code-copy-icon");
    expect(html).toContain("data-openwork-code-copy-check-icon");
    expect(html).toContain("h-7 w-7");
    expect(html).toContain('aria-label="Copy code block"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('class="sr-only"');
    expect(html).toContain('title="Copy code block"');
    expect(html).not.toContain(">Copy</span>");
    expect(html).toContain("pt-11");
    expect(html).toContain(CODE.split("\n")[0]);
    expect(html).toContain(CODE.split("\n")[1]);
  });

  test("renders highlighted code blocks with the same copy affordance and dual Shiki themes", async () => {
    const html = await renderHighlightedMarkdownHtml(MARKDOWN);

    expect(html).toContain("data-openwork-code-block");
    expect(html).toContain("data-openwork-shiki");
    expect(html).toContain("data-openwork-code-copy");
    expect(html).toContain("data-openwork-code-copy-icon");
    expect(html).toContain("data-openwork-code-copy-check-icon");
    expect(html).toContain("--shiki-dark");
    expect(html).toContain("github-light");
    expect(html).toContain("github-dark");
  });

  test("renders surface code blocks without chat-only copy controls", async () => {
    const fallbackHtml = renderPrimitiveMarkdownHtml(MARKDOWN, "surface");
    expect(fallbackHtml).toContain("border-dls-border/70");
    expect(fallbackHtml).toContain("bg-gray-1/80");
    expect(fallbackHtml).toContain('class="language-ts"');
    expect(fallbackHtml).not.toContain("data-openwork-code-copy");

    const highlightedHtml = await renderPrimitiveHighlightedMarkdownHtml(MARKDOWN, "surface");
    expect(highlightedHtml).toContain("data-openwork-shiki");
    expect(highlightedHtml).toContain("github-light");
    expect(highlightedHtml).not.toContain("github-dark");
    expect(highlightedHtml).not.toContain("data-openwork-code-copy");
  });
});

describe("markdown safety and links", () => {
  test("blocks unsafe markdown link targets and strips raw HTML from surface markdown", () => {
    const html = renderMarkdownHtml(`[bad](javascript:alert(1))`);

    expect(html).toContain('href="#"');

    const surfaceHtml = renderPrimitiveMarkdownHtml(`<img src="x" onerror="alert(1)"><script>alert(1)</script>`, "surface");
    expect(surfaceHtml).not.toContain("onerror");
    expect(surfaceHtml).not.toContain("<script");
  });

  test("keeps chat file link actions separate from simple surface links", () => {
    const markdown = `[Open docs](./docs/readme.md) and [OpenWork](https://openworklabs.com)`;
    const chatHtml = renderMarkdownHtml(markdown);
    expect(chatHtml).toContain("data-openwork-link-chevron");
    expect(chatHtml).toContain("data-openwork-link-href");
    expect(chatHtml).toContain('href="https://openworklabs.com"');

    const surfaceHtml = renderPrimitiveMarkdownHtml(markdown, "surface");
    expect(surfaceHtml).not.toContain("data-openwork-link-chevron");
    expect(surfaceHtml).not.toContain("data-openwork-link-href");
    expect(surfaceHtml).toContain('href="./docs/readme.md"');
    expect(surfaceHtml).toContain('href="https://openworklabs.com"');
  });
});

describe("markdown text highlighting", () => {
  test("splits matching text without changing the original casing", () => {
    expect(textHighlightParts("Markdown makes marks in markdown.", "MARK")).toEqual([
      { text: "Mark", highlighted: true },
      { text: "down makes ", highlighted: false },
      { text: "mark", highlighted: true },
      { text: "s in ", highlighted: false },
      { text: "mark", highlighted: true },
      { text: "down.", highlighted: false },
    ]);
  });

  test("treats highlight queries as literal text", () => {
    expect(textHighlightParts("Find a+b and a+b again", "a+b")).toEqual([
      { text: "Find ", highlighted: false },
      { text: "a+b", highlighted: true },
      { text: " and ", highlighted: false },
      { text: "a+b", highlighted: true },
      { text: " again", highlighted: false },
    ]);
  });
});
