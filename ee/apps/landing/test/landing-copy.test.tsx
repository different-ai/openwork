import { describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));
const { LandingHome } = await import("../components/landing-home");

const props = {
  stars: "23k",
  downloadHref: "/download",
  windowsDownloadHref: "/download",
  linuxDownloadHref: "/download",
  callHref: "/enterprise#book",
  isMobileVisitor: false,
};

const textContent = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("Landing display copy", () => {
  test("renders the approved headline and subtitle", () => {
    const html = renderToStaticMarkup(createElement(LandingHome, props));
    expect(textContent(html)).toContain("Your AI workspace. Without vendor lock-in.");
    expect(textContent(html)).toContain("The open-source alternative to Claude Cowork and Codex. Run any model on any infrastructure.");
    expect(html.match(/<h1\b/g)).toHaveLength(1);
  });

  test("lists the four products with their pages and keeps the SOC 2 headline", () => {
    const html = renderToStaticMarkup(createElement(LandingHome, props));
    const text = textContent(html);
    for (const name of ["MCP Gateway", "AI Gateway", "Desktop App", "Cloud App"]) {
      expect(text).toContain(name);
    }
    expect(html).toContain('href="/connect"');
    expect(html).toContain('href="/docs/ai-gateway/overview"');
    expect(html).toContain('href="/cloud"');
    expect(text).toContain("SOC 2 Type II");
    expect(html).toContain('href="/trust"');
    expect(text).not.toContain("SOVEREIGN AI");
    expect(text).not.toContain("Where to next");
  });

  test("header replaces Product, Connect and Cloud links with a Products menu", () => {
    const html = renderToStaticMarkup(createElement(LandingHome, props));
    const header = html.slice(html.indexOf("<header"), html.indexOf("</header>"));
    expect(header).toMatch(/<button[^>]*aria-expanded="false"[^>]*>Products/);
    expect(header).not.toContain('href="/#product"');
    expect(textContent(header)).toContain("Enterprise");
    expect(textContent(header)).toContain("Pricing");
  });

  test("uses the download action on desktop and browser action on mobile", () => {
    const desktop = renderToStaticMarkup(createElement(LandingHome, props));
    const mobile = renderToStaticMarkup(createElement(LandingHome, { ...props, isMobileVisitor: true }));
    expect(desktop).toContain("Download OpenWork");
    expect(mobile).toContain("Open in browser");
    expect(mobile).not.toContain("Get Started for Free");
    expect(mobile).not.toContain("Download for free");
    expect(mobile).toContain('href="/download"');
  });
});
