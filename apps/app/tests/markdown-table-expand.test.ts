import { describe, expect, test } from "bun:test";

import { renderMarkdownHtml } from "../src/components/markdown/markdown-primitive";

const TABLE = "| PR | Status |\n| --- | --- |\n| [#5138](https://github.com/different-ai/openwork/pull/5138) | \"Ready\" |";

describe("chat markdown tables", () => {
  test("a chat table carries an expand button holding its own Markdown", () => {
    const html = renderMarkdownHtml(`Before\n\n${TABLE}\n\nAfter`, "chat");
    const escapedSource = TABLE.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    const wrapper = html.indexOf('<div data-openwork-table="" class="group/table relative my-4">');
    const button = html.indexOf(`<button type="button" data-openwork-table-expand="${escapedSource}"`);
    const table = html.indexOf('<table class="w-full border-collapse">');

    expect(wrapper).toBeGreaterThan(-1);
    expect(button).toBeGreaterThan(wrapper);
    expect(html.indexOf('aria-label="Expand table"', button)).toBeGreaterThan(button);
    expect(table).toBeGreaterThan(button);
    expect(html.indexOf('href="https://github.com/different-ai/openwork/pull/5138"', table)).toBeGreaterThan(table);
  });

  test("remote prose tables carry the same button", () => {
    const html = renderMarkdownHtml(TABLE, "remote");
    expect(html).toContain("data-openwork-table-expand=");
  });

  test("surface previews keep a plain table", () => {
    const html = renderMarkdownHtml(TABLE, "surface");
    expect(html).not.toContain("data-openwork-table");
    expect(html).toContain('<table class="my-4 w-full border-collapse">');
  });
});
