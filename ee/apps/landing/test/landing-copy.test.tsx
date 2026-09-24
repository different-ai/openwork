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
