import { describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { agentMarkdown } from "../lib/agent-markdown";
import {
  CLAUDE_COWORK_ALTERNATIVE_PATH,
  MIGRATION_GUIDE_PATH,
  claudeCoworkAlternativeFaq
} from "../lib/claude-cowork-alternative";
import sitemap from "../app/sitemap";

mock.module("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));
const { ClaudeCoworkAlternativePage } = await import("../components/claude-cowork-alternative-page");

const html = renderToStaticMarkup(createElement(ClaudeCoworkAlternativePage, { stars: "23k" }));
const text = html
  .replace(/<[^>]+>/g, " ")
  .replace(/&#x27;/g, "'")
  .replace(/&amp;/g, "&")
  .replace(/\s+/g, " ");

describe("Claude Cowork alternative page", () => {
  test("leads with the answer-first headline and a download action", () => {
    expect(html).toMatch(/<h1[^>]*>The free, open-source alternative to Claude Cowork<\/h1>/);
    expect(text).toContain("macOS, Windows, and Linux");
    expect(html).toContain('href="/download"');
    expect(html).toContain(`href="${MIGRATION_GUIDE_PATH}"`);
  });

  test("renders the comparison and every FAQ entry as visible text", () => {
    expect(html).toContain("<table");
    expect(claudeCoworkAlternativeFaq.length).toBeLessThanOrEqual(6);
    for (const entry of claudeCoworkAlternativeFaq) {
      expect(text).toContain(entry.question);
    }
  });

  test("is discoverable by crawlers and agents", () => {
    expect(sitemap().map((entry) => entry.url)).toContain(`https://openworklabs.com${CLAUDE_COWORK_ALTERNATIVE_PATH}`);
    const markdown = agentMarkdown[CLAUDE_COWORK_ALTERNATIVE_PATH];
    expect(markdown).toStartWith("# The free, open-source alternative to Claude Cowork");
    expect(markdown).toContain("| Desktop app for Linux | Partial [");
  });
});
