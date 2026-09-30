import { describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import sitemap from "../app/sitemap";
import { agentMarkdown } from "../lib/agent-markdown";
import { CLAUDE_COWORK_3P_PATH, claudeCowork3pFaq } from "../lib/claude-cowork-3p";

mock.module("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));
const { ClaudeCowork3pPage } = await import("../components/claude-cowork-3p-page");
const { ClaudeCoworkAlternativePage } = await import("../components/claude-cowork-alternative-page");

const decode = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

const html = renderToStaticMarkup(createElement(ClaudeCowork3pPage, { stars: "23k" }));
const text = decode(html);

describe("Claude Cowork on 3P page", () => {
  test("answers first and renders the capability matrix", () => {
    expect(html).toMatch(/<h1[^>]*>OpenWork vs Claude Cowork on 3P<\/h1>/);
    expect(html).toContain("<table");
    expect(text).toContain("Claude on 3P");
  });

  test("compares features, not cost", () => {
    expect(text).not.toContain("Cost calculator");
    expect(text).not.toContain("How we calculate");
    expect(agentMarkdown[CLAUDE_COWORK_3P_PATH]).not.toContain("calculator");
  });

  test("renders every FAQ entry and is discoverable", () => {
    expect(claudeCowork3pFaq.length).toBeLessThanOrEqual(6);
    for (const entry of claudeCowork3pFaq) expect(text).toContain(entry.question);
    expect(sitemap().map((entry) => entry.url)).toContain(`https://openworklabs.com${CLAUDE_COWORK_3P_PATH}`);
    expect(agentMarkdown[CLAUDE_COWORK_3P_PATH]).toContain("| Any model, including open-weight and self-hosted | No | Partial [");
  });

  test("is linked from the main Claude Cowork alternative page", () => {
    const main = renderToStaticMarkup(createElement(ClaudeCoworkAlternativePage, { stars: "23k" }));
    expect(main).toContain(`href="${CLAUDE_COWORK_3P_PATH}"`);
    expect(main).toContain("Cost calculator");
  });
});
