import { describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { agentMarkdown } from "../lib/agent-markdown";
import { CLAUDE_COWORK_3P_PATH } from "../lib/claude-cowork-3p";
import { CLAUDE_COWORK_ALTERNATIVE_PATH } from "../lib/claude-cowork-alternative";
import {
  capabilitiesCheckedAt,
  capabilityColumns,
  capabilityGroups,
  capabilityRows,
  supportLabel,
  supportTotals
} from "../lib/cowork-capabilities";

mock.module("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));
const { ClaudeCowork3pPage } = await import("../components/claude-cowork-3p-page");
const { ClaudeCoworkAlternativePage } = await import("../components/claude-cowork-alternative-page");

const decode = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

const pages = {
  [CLAUDE_COWORK_ALTERNATIVE_PATH]: renderToStaticMarkup(createElement(ClaudeCoworkAlternativePage, { stars: "23k" })),
  [CLAUDE_COWORK_3P_PATH]: renderToStaticMarkup(createElement(ClaudeCowork3pPage, { stars: "23k" }))
};

describe("Claude Cowork capability matrix data", () => {
  test("stays short and gives every cell a source", () => {
    expect(capabilityGroups.length).toBeGreaterThanOrEqual(3);
    expect(capabilityRows.length).toBeLessThanOrEqual(22);
    for (const row of capabilityRows) {
      for (const column of capabilityColumns) {
        const cell = row.cells[column.key];
        expect(cell.source).toMatch(/^(https:\/\/|\/)/);
        if (cell.value === "partial") expect(cell.note).toBeTruthy();
      }
    }
  });

  test("never counts a planned item as Yes", () => {
    for (const row of capabilityRows) {
      for (const column of capabilityColumns) {
        const cell = row.cells[column.key];
        if (cell.planned) {
          expect(column.key).toBe("openwork");
          expect(cell.value).not.toBe("yes");
        }
      }
    }
  });

  test("computes totals from the cells", () => {
    for (const column of capabilityColumns) {
      const totals = supportTotals(column.key);
      const values = capabilityRows.map((row) => row.cells[column.key].value);
      expect(totals.yes).toBe(values.filter((value) => value === "yes").length);
      expect(totals.partial).toBe(values.filter((value) => value === "partial").length);
      expect(totals.yes + totals.partial + totals.no).toBe(capabilityRows.length);
    }
  });
});

describe.each(Object.entries(pages))("capability matrix on %s", (path, html) => {
  const text = decode(html);

  test("renders every group, row, and total, with no takeaway sentence", () => {
    expect(html).toContain("<table");
    for (const group of capabilityGroups) expect(text).toContain(group.label);
    for (const row of capabilityRows) expect(text).toContain(row.label);
    expect(text).toContain(`Yes, of ${capabilityRows.length}`);
    for (const column of capabilityColumns) {
      const totals = supportTotals(column.key);
      if (totals.partial > 0) expect(text).toContain(`+${totals.partial} partial`);
    }
    expect(text).not.toContain("covers the most today");
    expect(text).toContain(`Sources, checked ${capabilitiesCheckedAt}`);
    expect(html).toContain('href="/roadmap"');
  });

  test("renders one label per cell", () => {
    const labels = (text.match(/\b(Yes|Partial|No)\b/g) ?? []).length;
    expect(labels).toBeGreaterThanOrEqual(capabilityRows.length * capabilityColumns.length);
  });

  test("ships the same matrix to agents", () => {
    const markdown = agentMarkdown[path];
    expect(markdown).toContain("| Capability | Claude Enterprise | Claude on 3P | OpenWork |");
    for (const row of capabilityRows) {
      const cells = capabilityColumns.map((column) => supportLabel(row.cells[column.key].value));
      expect(markdown).toMatch(new RegExp(`\\| ${row.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\| ${cells.map((cell) => `${cell}[^|]*`).join("\\| ")}\\|`));
    }
    expect(markdown).toContain(`| **Yes, of ${capabilityRows.length}** |`);
    expect(markdown).not.toContain("covers the most today");
  });
});
