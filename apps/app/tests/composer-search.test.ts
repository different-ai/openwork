import { describe, expect, test } from "bun:test";

import {
  composerHighlightSegments,
  damerauLevenshtein,
  rankComposerSearch,
  type ComposerSearchEntry,
} from "../src/react-app/domains/session/surface/composer/composer-search";

function entries(labels: string[], keywords: Record<string, string[]> = {}): ComposerSearchEntry<string>[] {
  return labels.map((label) => ({ id: label, label, keywords: keywords[label], value: label }));
}

const catalog = entries(
  [
    "GitHub",
    "HubSpot",
    "HubSpot deal summary",
    "Customer briefing",
    "Slack",
    "Slack standup digest",
    "Linear",
    "hubspot-export.csv",
  ],
  { Linear: ["Issues and projects"] },
);

function labels(query: string): string[] {
  return rankComposerSearch(query, catalog).map((match) => match.entry.label);
}

describe("rankComposerSearch", () => {
  test("empty query returns nothing so callers show their browse view", () => {
    expect(labels("   ")).toEqual([]);
  });

  test("exact match beats prefix matches", () => {
    const result = labels("hubspot");
    expect(result[0]).toBe("HubSpot");
    expect(result).toContain("HubSpot deal summary");
  });

  test("prefix and word-start matches rank above mid-word matches", () => {
    const result = labels("hub");
    expect(result.indexOf("HubSpot")).toBeLessThan(result.indexOf("GitHub"));
    expect(result.indexOf("HubSpot deal summary")).toBeLessThan(result.indexOf("GitHub"));
  });

  test("skipped letters still find the item", () => {
    expect(labels("hbspt")[0]).toBe("HubSpot");
  });

  test("a query covering most of a short label beats a tighter run in a long label", () => {
    const result = rankComposerSearch("hbspt", entries(["Hubspot deal summary", "HubSpot"])).map((match) => match.entry.label);
    expect(result).toEqual(["HubSpot", "Hubspot deal summary"]);
  });

  test("abbreviated words across a multi-word label match", () => {
    expect(labels("cust brf")).toEqual(["Customer briefing"]);
  });

  test("word-start tokens match out of order", () => {
    expect(labels("digest standup")[0]).toBe("Slack standup digest");
  });

  test("a transposed letter still matches", () => {
    expect(labels("slakc")[0]).toBe("Slack");
  });

  test("a single wrong letter in a longer word still matches", () => {
    expect(labels("custonmer")).toContain("Customer briefing");
  });

  test("short queries do not match through typos", () => {
    expect(labels("zqx")).toEqual([]);
  });

  test("keywords match but rank below label matches", () => {
    const result = rankComposerSearch("issues", catalog);
    expect(result[0]?.entry.label).toBe("Linear");
    expect(result[0]?.tier).toBe("keyword");
    expect(result[0]?.highlights).toEqual([]);
  });

  test("limit caps the result count", () => {
    expect(rankComposerSearch("s", catalog, { limit: 2 })).toHaveLength(2);
  });

  test("highlights point at the matched characters", () => {
    const [hubspot] = rankComposerSearch("hbspt", catalog);
    expect(hubspot?.highlights).toEqual([0, 2, 3, 4, 6]);
    const [briefing] = rankComposerSearch("cust brf", catalog);
    expect(briefing?.highlights.slice(0, 4)).toEqual([0, 1, 2, 3]);
  });
});

describe("composerHighlightSegments", () => {
  test("groups contiguous highlighted characters", () => {
    expect(composerHighlightSegments("HubSpot", [0, 1, 2])).toEqual([
      { text: "Hub", match: true },
      { text: "Spot", match: false },
    ]);
  });

  test("returns the full label when nothing is highlighted", () => {
    expect(composerHighlightSegments("Slack", [])).toEqual([{ text: "Slack", match: false }]);
  });
});

describe("damerauLevenshtein", () => {
  test("counts a transposition as one edit", () => {
    expect(damerauLevenshtein("slakc", "slack")).toBe(1);
    expect(damerauLevenshtein("hubsopt", "hubspot")).toBe(1);
    expect(damerauLevenshtein("abc", "abc")).toBe(0);
  });
});
