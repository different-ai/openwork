import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SiteFooter } from "../components/site-footer";

describe("Site footer", () => {
  test("names the OpenCode attribution link", () => {
    const html = renderToStaticMarkup(createElement(SiteFooter));
    expect(html).toContain('href="https://opencode.ai" aria-label="OpenCode"');
  });

  test("links the SOC 2 Type II badge to the Trust Center", () => {
    const html = renderToStaticMarkup(createElement(SiteFooter));

    expect(html).toContain('href="/trust"');
    expect(html).toContain("SOC 2 Type II. View Trust Center");
    expect(html).toContain('src="/soc-2-type-ii.svg"');
  });
});
