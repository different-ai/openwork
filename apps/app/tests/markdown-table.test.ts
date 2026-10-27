import { describe, expect, test } from "bun:test";

import { renderMarkdownHtml } from "../src/components/markdown/markdown";

const MARKDOWN = `| Name | Status |
| --- | --- |
| Artifact | Ready |`;

describe("markdown tables", () => {
  test("renders wide tables in a sanitized horizontal scroll container", () => {
    const html = renderMarkdownHtml(MARKDOWN);

    expect(html).toContain("data-openwork-table-scroll");
    expect(html).toContain("overflow-x-auto");
    expect(html).toContain("Name");
    expect(html).toContain("Status");
    expect(html).toContain("Artifact");
    expect(html).toContain("Ready");
  });
});