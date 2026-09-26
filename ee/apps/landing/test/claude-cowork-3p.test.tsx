import { describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import sitemap from "../app/sitemap";
import { agentMarkdown } from "../lib/agent-markdown";
import { CLAUDE_COWORK_3P_PATH, claudeCowork3pFaq, threeWayRows } from "../lib/claude-cowork-3p";

mock.module("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));
const { ClaudeCowork3pPage } = await import("../components/claude-cowork-3p-page");
const { ClaudeCoworkAlternativePage } = await import("../components/claude-cowork-alternative-page");

const decode = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

const html = renderToStaticMarkup(createElement(ClaudeCowork3pPage, { stars: "23k" }));
const text = decode(html);

describe("Claude Cowork on 3P page", () => {
  test("answers first and renders the three-way comparison", () => {
    expect(html).toMatch(/<h1[^>]*>OpenWork vs Claude Cowork on 3P<\/h1>/);
    for (const row of threeWayRows) {
      expect(text).toContain(row.label);
      expect(text).toContain(row.enterprise);
      expect(text).toContain(row.thirdParty);
      expect(text).toContain(row.openwork);
    }
    expect(text).toContain("Anthropic details as of 2026-09-25");
  });

  test("embeds the calculator focused on 3P with 500 people", () => {
    expect(html).toContain('value="500"');
    expect(text).toContain("Claude Desktop on 3P");
    expect(text).toContain("How we calculate");
    expect(text).toContain("Volume pricing above 250 users");
  });

  test("renders every FAQ entry and is discoverable", () => {
    for (const entry of claudeCowork3pFaq) expect(text).toContain(entry.question);
    expect(sitemap().map((entry) => entry.url)).toContain(`https://openworklabs.com${CLAUDE_COWORK_3P_PATH}`);
    expect(agentMarkdown[CLAUDE_COWORK_3P_PATH]).toContain("| Models | Claude models | Claude model IDs only |");
  });

  test("is linked from the main Claude Cowork alternative page", () => {
    const main = renderToStaticMarkup(createElement(ClaudeCoworkAlternativePage, { stars: "23k" }));
    expect(main).toContain(`href="${CLAUDE_COWORK_3P_PATH}"`);
    expect(main).toContain("Cost calculator");
  });
});
