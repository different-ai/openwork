import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SiteFooter } from "../components/site-footer";

describe("Site footer", () => {
  test("links the SOC 2 Type I badge to the Trust Center", () => {
    const html = renderToStaticMarkup(createElement(SiteFooter));

    expect(html).toContain('href="/trust"');
    expect(html).toContain("SOC 2 Type I");
    expect(html).not.toContain("Type II");
  });
});
