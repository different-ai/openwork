import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const runnerPath = join(
  import.meta.dir,
  "../app/(den)/dashboard/_components/mcp-tool-runner.tsx",
);

describe("MCP tool runner layout", () => {
  test("keeps the Refresh tools action on one line", () => {
    const runner = readFileSync(runnerPath, "utf8");
    const refreshLabelIndex = runner.indexOf("<span>Refresh tools</span>");
    const refreshAction = runner.slice(Math.max(0, refreshLabelIndex - 400), refreshLabelIndex + 100);

    expect(refreshLabelIndex).toBeGreaterThan(-1);
    expect(refreshAction).toContain('className="shrink-0 whitespace-nowrap"');
  });
});
