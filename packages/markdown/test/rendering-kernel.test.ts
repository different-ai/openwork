import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  createMarkdownRenderingKernel,
  type MarkdownHighlightRequest,
} from "../src/index";

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

function assertContains(value: string, expected: string) {
  assert.ok(value.includes(expected), `expected output to contain ${JSON.stringify(expected)}`);
}

function assertExcludes(value: string, expected: string) {
  assert.ok(!value.includes(expected), `expected output to exclude ${JSON.stringify(expected)}`);
}

describe("markdown rendering kernel", () => {
  test("handles empty input, fenced-code detection, and emoji aliases", () => {
    const kernel = createFixtureKernel();

    assert.equal(kernel.renderSync("  \n", "conversation"), "");
    assert.equal(kernel.hasFencedCodeBlock("inline `code`"), false);
    assert.equal(kernel.hasFencedCodeBlock("before\n```ts\nconst value = 1\n```"), true);
    assertContains(kernel.renderSync("Ship it :tada:", "conversation"), "Ship it 🎉");
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

    assertContains(conversation, 'href="https://example.com"');
    assertContains(conversation, 'href="mailto:hello@example.com"');
    assertContains(conversation, 'href="./notes.md"');
    assertContains(conversation, 'data-openwork-link-href="./notes.md"');
    assertContains(conversation, 'data-openwork-link-chevron="./notes.md"');
    assertContains(conversation, 'href="#" data-openwork-link-href="javascript:alert(1)"');
    assertContains(conversation, 'src="#" alt="unsafe image"');
    assertContains(conversation, 'target="_blank" rel="noreferrer noopener"');

    assertContains(documentPreview, 'href="./notes.md"');
    assertContains(documentPreview, 'href="#"');
    assertExcludes(documentPreview, "data-openwork-link-href");
    assertExcludes(documentPreview, "data-openwork-link-chevron");
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

    assertContains(conversation, "<strong>safe</strong>");
    assertContains(conversation, '<img src="/ok.png">');
    assertExcludes(conversation, "onerror");
    assertExcludes(conversation, "<script");
    assertExcludes(conversation, "pwned");
    assertExcludes(documentPreview, "<strong");
    assertExcludes(documentPreview, "<img");
    assertExcludes(documentPreview, "<script");
    assertExcludes(documentPreview, "onerror");
    assert.equal(sanitizedInputs.length, 2);
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

    assertExcludes(kernel.renderSync(forged, "document-preview"), "raw-marker-bypass");

    const highlighted = await kernel.renderHighlighted(forged, "document-preview");

    assertContains(highlighted, 'data-openwork-shiki="true"');
    assertContains(highlighted, "const safe = true");
    assertExcludes(highlighted, "<script");
    assertExcludes(highlighted, "raw-marker-bypass");
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

    assert.deepEqual(requestedLanguages, ["text"]);
    assertContains(html, 'class="language-madeup"');
    assertContains(html, "&lt;div&gt;unsafe as code&lt;/div&gt;");
    assertExcludes(html, "data-openwork-shiki");
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

    assertContains(conversation, '<h1 class="font-semibold my-5 text-xl">');
    assertContains(conversation, '<ol start="3" class="my-3 pl-6 list-decimal">');
    assertContains(conversation, '<ul class="my-3 pl-6 list-disc">');
    assertContains(conversation, "border-l border-border bg-muted/40");
    assertContains(conversation, 'style="text-align: left" class="border border-border p-2 bg-muted text-left"');
    assertContains(conversation, 'data-openwork-image-preview="collapsed"');
    assertContains(conversation, 'data-openwork-image-toggle=""');
    assertContains(conversation, 'data-openwork-link-href="https://example.com"');

    assertContains(documentPreview, '<h1 class="my-5 text-xl font-semibold">');
    assertContains(documentPreview, '<ol start="3" class="my-3 list-decimal pl-6">');
    assertContains(documentPreview, '<ul class="my-3 list-disc pl-6">');
    assertContains(documentPreview, "border-l border-dls-border bg-dls-hover/40");
    assertContains(documentPreview, 'style="text-align: left" class="border border-dls-border bg-dls-hover p-2 text-left"');
    assertContains(documentPreview, 'class="my-4 max-w-full rounded-[18px] border border-dls-border/70"');
    assertExcludes(documentPreview, "data-openwork-image-preview");
    assertExcludes(documentPreview, "data-openwork-link-href");

    const conversationCode = await kernel.renderHighlighted("```ts\nconst value = 1\n```", "conversation");
    const documentCode = await kernel.renderHighlighted("```ts\nconst value = 1\n```", "document-preview");

    assertContains(conversationCode, "rounded-lg border border-border/70");
    assertContains(documentCode, "rounded-[18px] border border-dls-border/70");
  });
});
