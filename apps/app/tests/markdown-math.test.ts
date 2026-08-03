import { describe, expect, test } from "bun:test";

import { renderHighlightedMarkdownHtml, renderMarkdownHtml } from "../src/components/markdown/markdown-primitive";

describe("markdown math", () => {
  test("renders inline $...$ math with KaTeX instead of raw LaTeX source", () => {
    const html = renderMarkdownHtml("The mass-energy relation $E = mc^2$ is famous.");

    expect(html).toContain('class="katex"');
    expect(html).not.toContain("$E = mc^2$");
    // Surrounding prose survives.
    expect(html).toContain("The mass-energy relation");
    expect(html).toContain("is famous.");
  });

  test("renders $$...$$ as display math", () => {
    const html = renderMarkdownHtml("$$\n\\int_0^1 x^2 dx = \\frac{1}{3}\n$$");

    expect(html).toContain("katex-display");
    // The fraction became real markup, not literal source.
    expect(html).toContain("<mfrac>");
    expect(html).not.toContain("$$");
  });

  test("renders \\(...\\) inline math that models commonly emit", () => {
    const html = renderMarkdownHtml("Kinetic energy is \\(\\frac{1}{2}mv^2\\) in classical mechanics.");

    expect(html).toContain('class="katex"');
    expect(html).toContain("<mfrac>");
    expect(html).not.toContain("\\(");
    expect(html).toContain("in classical mechanics.");
  });

  test("renders \\[...\\] as display math", () => {
    const html = renderMarkdownHtml("Before\n\n\\[\nx = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}\n\\]\n\nAfter");

    expect(html).toContain("katex-display");
    expect(html).toContain("<msqrt>");
    expect(html).not.toContain("\\[");
    expect(html).toContain("Before");
    expect(html).toContain("After");
  });

  test("keeps the accessible MathML branch through sanitization", () => {
    const html = renderMarkdownHtml("$E = mc^2$");

    // <semantics>/<annotation> are not in DOMPurify's default MathML allowlist,
    // so this asserts the ADD_TAGS allowance is still in place.
    expect(html).toContain("<math");
    expect(html).toContain("<semantics>");
    expect(html).toContain("<annotation");
    expect(html).toContain("E = mc^2");
  });

  test("fails gracefully on malformed LaTeX without breaking the rest of the message", () => {
    const html = renderMarkdownHtml("Start $\\frac{1}{$ and \\(\\badmacro\\) end.");

    // Nothing throws, and the prose on either side is still rendered.
    expect(html).toContain("Start");
    expect(html).toContain("end.");
    expect(html.length).toBeGreaterThan(0);
  });

  test("leaves currency amounts alone", () => {
    const html = renderMarkdownHtml("It costs $5 and then $10 per seat.");

    expect(html).not.toContain('class="katex"');
    expect(html).toContain("$5");
    expect(html).toContain("$10");
  });

  test("does not treat code spans or fenced code as math", () => {
    const html = renderMarkdownHtml("Use `$x$` inline.\n\n```sh\necho $HOME $PATH\n```");

    expect(html).not.toContain('class="katex"');
    expect(html).toContain("$x$");
    expect(html).toContain("$HOME");
  });

  test("renders math in the Shiki-highlighted parser too, so formulas do not flicker", async () => {
    const html = await renderHighlightedMarkdownHtml("$E = mc^2$\n\n```ts\nconst a = 1;\n```");

    expect(html).toContain('class="katex"');
    expect(html).toContain("data-openwork-shiki");
  });

  test("renders math on the surface presentation as well", () => {
    const html = renderMarkdownHtml("$E = mc^2$", "surface");

    expect(html).toContain('class="katex"');
  });
});
