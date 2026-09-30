import { describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("next/navigation", () => ({ useRouter: () => ({ push: () => {} }), usePathname: () => "/roadmap" }));

const { RoadmapPage, ROADMAP_PRODUCTS } = await import("../components/roadmap-page");

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

describe("Roadmap page", () => {
  test("lists every product in order, starting with Desktop", () => {
    expect(ROADMAP_PRODUCTS.map((product) => product.label)).toEqual([
      "Desktop",
      "Admin",
      "Visibility",
      "MCP Gateway",
      "Sharing and activity",
      "Web",
      "Automations",
      "Workflows",
      "Dashboards",
      "New apps"
    ]);
  });

  test("each product shows Ready, Building and Coming soon as columns", () => {
    const html = renderToStaticMarkup(createElement(RoadmapPage));
    for (const product of ROADMAP_PRODUCTS) {
      const start = html.indexOf(`id="${product.id}"`);
      expect(start).toBeGreaterThan(-1);
      const section = html.slice(start, html.indexOf("</section>", start));
      expect(section).toContain('data-column="ready"');
      expect(section).toContain('data-column="building"');
      expect(section).toContain('data-column="soon"');
    }
  });

  test("reuses the landing product previews and keeps unshipped work out of Ready", () => {
    const html = renderToStaticMarkup(createElement(RoadmapPage));
    const plain = text(html);
    expect(plain).toContain("Connect any agent");
    expect(plain).toContain("https://api.openworklabs.com/mcp/agent");
    expect(plain).toContain("What’s working in Acme Studio");
    expect(plain).toContain("At-risk accounts digest");

    const ready = ROADMAP_PRODUCTS.flatMap((product) => product.items.ready);
    for (const unshipped of ["Session sharing", "Audit logs", "Live edit", "OpenWork in Slack", "Custom schedules"]) {
      expect(ready).not.toContain(unshipped);
    }
    expect(ROADMAP_PRODUCTS.find((product) => product.id === "new-apps")?.items.ready).toEqual([]);
    expect(plain).not.toContain("Code Mode");
  });
});
