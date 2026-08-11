import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const gridPath = fileURLToPath(
  new URL("../app/(den)/dashboard/_components/connector-quick-add-grid.tsx", import.meta.url),
);
const screenPath = fileURLToPath(
  new URL("../app/(den)/dashboard/_components/mcp-connections-screen.tsx", import.meta.url),
);

describe("connector quick add v2", () => {
  test("renders compact live connector tiles", () => {
    const grid = readFileSync(gridPath, "utf8");

    expect(grid).toContain("line-clamp-2");
    expect(grid).toContain("Added");
    expect(grid).toContain("Manage");
    expect(grid).toContain("quick-add-preset-");
    expect(grid).toContain("quick-add-feishu-hire");
    expect(grid).toContain("Read-only jobs, candidates, and applications");
  });

  test("uses the smart bar instead of the standalone add button", () => {
    const screen = readFileSync(screenPath, "utf8");

    expect(screen).toContain("connector-smart-bar");
    expect(screen).toContain("Advanced setup");
    expect(screen).toContain("feishu-hire-app-secret");
    expect(screen).toContain("hire:application:readonly");
    expect(screen).not.toMatch(/>\s*Add MCP\s*</);
  });
});
