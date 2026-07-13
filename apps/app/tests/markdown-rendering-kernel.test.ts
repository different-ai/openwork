import { describe, expect, test } from "bun:test";

import {
  createMarkdownRenderingKernel,
  type MarkdownHighlightRequest,
} from "../src/components/markdown/rendering-kernel";
import {
  applyTextHighlights as applySharedTextHighlights,
  clearTextHighlights as clearSharedTextHighlights,
  SEARCH_HIGHLIGHT_SELECTOR as SHARED_SEARCH_HIGHLIGHT_SELECTOR,
} from "../src/components/markdown/text-highlights";
import {
  applyTextHighlights as applySessionTextHighlights,
  clearTextHighlights as clearSessionTextHighlights,
  SEARCH_HIGHLIGHT_SELECTOR as SESSION_SEARCH_HIGHLIGHT_SELECTOR,
} from "../src/react-app/domains/session/surface/text-highlights";

function fixtureSanitizer(html: string) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/\s+on[a-z]+=(?:"[^"]*"|'[^']*')/gi, "");
}

function successfulHighlighter(request: MarkdownHighlightRequest) {
  return Promise.resolve(
    `<pre class="shiki"><code><span class="line">${request.code}</span></code></pre>`,
  );
}

function createFixtureKernel(sanitizeHtml = fixtureSanitizer) {
  return createMarkdownRenderingKernel({
    sanitizeHtml,
    isHighlightLanguageSupported: (language) => ["js", "ts", "text"].includes(language),
    highlightCode: successfulHighlighter,
  });
}

describe("markdown rendering kernel", () => {
  test("keeps the session text-highlight path as a compatibility alias to one owner", () => {
    expect(applySessionTextHighlights).toBe(applySharedTextHighlights);
    expect(clearSessionTextHighlights).toBe(clearSharedTextHighlights);
    expect(SESSION_SEARCH_HIGHLIGHT_SELECTOR).toBe(SHARED_SEARCH_HIGHLIGHT_SELECTOR);
    expect(SHARED_SEARCH_HIGHLIGHT_SELECTOR).toBe('mark[data-search-highlight="true"]');
  });

  test("pins safe URLs and keeps presentation-specific link behavior", () => {
    const kernel = createFixtureKernel();
    const markdown = [
      "[web](https://example.com)",
      "[mail](mailto:hello@example.com)",
      "[file](./notes.md)",
      "[unsafe](javascript:alert(1))",
      "![unsafe image](data:text/html,pwned)",
    ].join(" ");

    const conversation = kernel.renderSync(markdown, "conversation");
    const documentPreview = kernel.renderSync(markdown, "document-preview");

    expect(conversation).toContain('href="https://example.com"');
    expect(conversation).toContain('href="mailto:hello@example.com"');
    expect(conversation).toContain('href="./notes.md"');
    expect(conversation).toContain('data-openwork-link-href="./notes.md"');
    expect(conversation).toContain('data-openwork-link-chevron="./notes.md"');
    expect(conversation).toContain('href="#" data-openwork-link-href="javascript:alert(1)"');
    expect(conversation).toContain('src="#" alt="unsafe image"');
    expect(conversation).toContain('target="_blank" rel="noreferrer noopener"');

    expect(documentPreview).toContain('href="./notes.md"');
    expect(documentPreview).toContain('href="#"');
    expect(documentPreview).not.toContain("data-openwork-link-href");
    expect(documentPreview).not.toContain("data-openwork-link-chevron");
  });

  test("routes conversation raw HTML through sanitization and strips document raw HTML", () => {
    const sanitizedInputs: string[] = [];
    const kernel = createFixtureKernel((html) => {
      sanitizedInputs.push(html);
      return fixtureSanitizer(html);
    });
    const raw = '<strong>safe</strong><img src="/ok.png" onerror="pwn()"><script>pwned()</script>';

    const conversation = kernel.renderSync(raw, "conversation");
    const documentPreview = kernel.renderSync(raw, "document-preview");

    expect(conversation).toContain("<strong>safe</strong>");
    expect(conversation).toContain('<img src="/ok.png">');
    expect(conversation).not.toContain("onerror");
    expect(conversation).not.toContain("<script");
    expect(conversation).not.toContain("pwned");
    expect(documentPreview).not.toContain("<strong");
    expect(documentPreview).not.toContain("<img");
    expect(documentPreview).not.toContain("<script");
    expect(documentPreview).not.toContain("onerror");
    expect(sanitizedInputs).toHaveLength(2);
  });

  test("closes the crafted Shiki marker bypass while preserving generated highlighting", async () => {
    // Identity output makes this a parser trust-boundary assertion rather
    // than relying on the fixture sanitizer to hide an accepted raw token.
    const kernel = createFixtureKernel((html) => html);
    const forged = [
      '<script data-openwork-shiki="true">raw-marker-bypass</script>',
      "",
      "```js",
      "const safe = true",
      "```",
    ].join("\n");

    expect(kernel.renderSync(forged, "document-preview")).not.toContain("raw-marker-bypass");

    const highlighted = await kernel.renderHighlighted(forged, "document-preview");

    expect(highlighted).toContain('data-openwork-shiki="true"');
    expect(highlighted).toContain("const safe = true");
    expect(highlighted).not.toContain("<script");
    expect(highlighted).not.toContain("raw-marker-bypass");
  });

  test("falls back to escaped plain code and normalizes unsupported highlight languages", async () => {
    const requestedLanguages: string[] = [];
    const kernel = createMarkdownRenderingKernel({
      sanitizeHtml: fixtureSanitizer,
      isHighlightLanguageSupported: () => false,
      highlightCode: ({ language }) => {
        requestedLanguages.push(language);
        return Promise.reject(new Error("highlighter unavailable"));
      },
    });

    const html = await kernel.renderHighlighted("```madeup\n<div>unsafe as code</div>\n```", "conversation");

    expect(requestedLanguages).toEqual(["text"]);
    expect(html).toContain('class="language-madeup"');
    expect(html).toContain("&lt;div&gt;unsafe as code&lt;/div&gt;");
    expect(html).not.toContain("data-openwork-shiki");
  });

  test("pins tables, images, links, and classes for both presentation variants", async () => {
    const kernel = createFixtureKernel();
    const fixture = [
      "# Heading",
      "",
      "> quoted",
      "",
      "3. third",
      "4. fourth",
      "",
      "- bullet",
      "",
      "| Left | Right |",
      "| :--- | ---: |",
      "| one | two |",
      "",
      "![Diagram](./diagram.png \"Diagram title\")",
      "",
      "[Read more](https://example.com)",
    ].join("\n");

    const conversation = kernel.renderSync(fixture, "conversation");
    const documentPreview = kernel.renderSync(fixture, "document-preview");

    expect(conversation).toContain('<h1 class="font-semibold my-5 text-xl">');
    expect(conversation).toContain('<ol start="3" class="my-3 pl-6 list-decimal">');
    expect(conversation).toContain('<ul class="my-3 pl-6 list-disc">');
    expect(conversation).toContain("border-l border-border bg-muted/40");
    expect(conversation).toContain('style="text-align: left" class="border border-border p-2 bg-muted text-left"');
    expect(conversation).toContain('data-openwork-image-preview="collapsed"');
    expect(conversation).toContain('data-openwork-image-toggle=""');
    expect(conversation).toContain('data-openwork-link-href="https://example.com"');

    expect(documentPreview).toContain('<h1 class="my-5 text-xl font-semibold">');
    expect(documentPreview).toContain('<ol start="3" class="my-3 list-decimal pl-6">');
    expect(documentPreview).toContain('<ul class="my-3 list-disc pl-6">');
    expect(documentPreview).toContain("border-l border-dls-border bg-dls-hover/40");
    expect(documentPreview).toContain('style="text-align: left" class="border border-dls-border bg-dls-hover p-2 text-left"');
    expect(documentPreview).toContain('class="my-4 max-w-full rounded-[18px] border border-dls-border/70"');
    expect(documentPreview).not.toContain("data-openwork-image-preview");
    expect(documentPreview).not.toContain("data-openwork-link-href");

    const conversationCode = await kernel.renderHighlighted("```ts\nconst value = 1\n```", "conversation");
    const documentCode = await kernel.renderHighlighted("```ts\nconst value = 1\n```", "document-preview");

    expect(conversationCode).toContain("rounded-lg border border-border/70");
    expect(documentCode).toContain("rounded-[18px] border border-dls-border/70");
  });
});
