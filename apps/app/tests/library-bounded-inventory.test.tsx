/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LibraryInventory, type LibraryRow } from "../src/react-app/domains/settings/pages/mcp-view";

const rows = (count: number): LibraryRow[] => Array.from({ length: count }, (_, index) => ({ key: `skill:${index}`, taxonomy: "skill", section: "mac", searchText: `Skill ${index}`, node: <span>Skill {index}</span> }));

describe("Library inventory render boundary", () => {
  for (const count of [0, 1, 20, 10000]) {
    test(`${count} items render at most one section page without hiding its size`, () => {
      const html = renderToStaticMarkup(<LibraryInventory rows={rows(count)} loading={false} filter="all" />);
      expect((html.match(/data-library-row-key=/g) ?? []).length).toBe(Math.min(count, 20));
      if (count > 20) {
        expect(html).toContain("Showing 1–20 of 10000");
        expect(html).toContain("Next On this computer items");
      }
    });
  }
  test("search applies before the page boundary", () => {
    const html = renderToStaticMarkup(<LibraryInventory rows={rows(10000)} loading={false} filter="all" search="Skill 9999" />);
    expect(html).toContain("Skill 9999");
    expect((html.match(/data-library-row-key=/g) ?? []).length).toBe(1);
  });
  test("loading and empty inventories remain distinct", () => {
    const loading = renderToStaticMarkup(<LibraryInventory rows={[]} loading filter="all" emptyState={<p>No items</p>} />);
    expect(loading).toContain("data-slot=\"skeleton\"");
    expect(loading).not.toContain("No items");
    const empty = renderToStaticMarkup(<LibraryInventory rows={[]} loading={false} filter="all" emptyState={<p>No items</p>} />);
    expect(empty).toContain("No items");
  });
});
