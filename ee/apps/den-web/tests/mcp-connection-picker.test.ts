import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const screenPath = fileURLToPath(
  new URL("../app/(den)/dashboard/_components/mcp-connections-screen.tsx", import.meta.url),
);

describe("MCP connection picker UI contract", () => {
  test("shows a scrollable service picker before the custom URL flow", () => {
    const screen = readFileSync(screenPath, "utf8");
    const customMcp = screen.indexOf('data-testid="select-custom-mcp"');
    const presetList = screen.indexOf("{presets.map((service)");

    expect(screen).toContain('useState<"picker" | "smart" | "advanced">');
    expect(screen).toContain('data-testid="mcp-service-picker"');
    expect(screen).toContain("max-h-[min(55vh,440px)]");
    expect(screen).toContain("overflow-y-auto");
    expect(customMcp).toBeGreaterThan(-1);
    expect(presetList).toBeGreaterThan(customMcp);
  });

  test("keeps known services separate from custom URL discovery", () => {
    const screen = readFileSync(screenPath, "utf8");

    expect(screen).toContain("Choose a service, or connect an MCP server by URL.");
    expect(screen).toContain("Connect with a server URL");
    expect(screen).toContain("Paste the MCP server URL");
    expect(screen).toContain('placeholder="https://mcp.example.com/mcp"');
    expect(screen).toContain('onClick={() => onSelectPreset(service)}');
    expect(screen).toContain('if (kind !== "url" && kind !== "domain")');
    expect(screen).not.toContain("or just type a name like");
  });
});
