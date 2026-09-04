import { describe, expect, test } from "bun:test";
import { paletteFilter } from "../app/(den)/dashboard/_lib/palette-filter";

const connectorsKeywords = ["Connectors", "mcp", "integrations", "servers", "connect", "Page"];
const toolTesterKeywords = ["Tool Tester", "tools", "test", "mcp", "Page"];

describe("Den command palette filter", () => {
  test("ranks a first alias above a later alias", () => {
    const connectors = paletteFilter("Pages:page:Manage:Connectors", "mcp", connectorsKeywords);
    const toolTester = paletteFilter("Pages:page:Manage:Tool Tester", "mcp", toolTesterKeywords);

    expect(connectors).toBeGreaterThan(toolTester);
  });

  test("ranks a label substring above an alias", () => {
    const labelMatch = paletteFilter(
      "Pages:page:Team:Settings:Billing",
      "bill",
      ["Settings › Billing", "Settings", "Billing", "plan", "invoice", "payment", "Page"],
    );
    const aliasMatch = paletteFilter("example", "bill", ["Invoices", "billing"]);

    expect(labelMatch).toBeGreaterThan(aliasMatch);
  });

  test("requires every token in a multi-word query", () => {
    expect(paletteFilter("Pages:page:Manage:Tool Tester", "tool tester", toolTesterKeywords)).toBeGreaterThan(0);
    expect(paletteFilter("Pages:page:Manage:Connectors", "tool tester", connectorsKeywords)).toBe(0);
  });

  test("returns one for an empty query", () => {
    expect(paletteFilter("Pages:page:Manage:Connectors", "  ", connectorsKeywords)).toBe(1);
  });

  test("keeps fuzzy single-token matches below every alias tier", () => {
    const score = paletteFilter("Pages:page:Manage:Connectors", "cnnctrs", connectorsKeywords);

    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(0.65);
  });
});
