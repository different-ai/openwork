import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const gridPath = fileURLToPath(
  new URL("../app/(den)/dashboard/_components/connector-quick-add-grid.tsx", import.meta.url),
);

describe("connector quick add v2", () => {
  test("renders compact live connector tiles", () => {
    const grid = readFileSync(gridPath, "utf8");

    expect(grid).toContain("line-clamp-2");
    expect(grid).toContain("Added");
    expect(grid).toContain("Manage");
    expect(grid).toContain("quick-add-preset-");
  });
});
