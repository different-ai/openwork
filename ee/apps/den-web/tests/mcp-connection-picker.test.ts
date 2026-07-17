import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const screenPath = fileURLToPath(
  new URL("../app/(den)/dashboard/_components/mcp-connections-screen.tsx", import.meta.url),
);

describe("MCP connection picker UI contract", () => {
  test("pins Custom MCP above a filterable, scrollable service list", () => {
    const screen = readFileSync(screenPath, "utf8");
    const customMcp = screen.indexOf('data-testid="select-custom-mcp"');
    const servicePicker = screen.indexOf('data-testid="mcp-service-picker"');
    const presetList = screen.indexOf("{presets.map((service)");

    expect(screen).toContain('useState<"picker" | "smart" | "advanced">');
    expect(screen).toContain('aria-label="Filter services"');
    expect(screen).toContain('placeholder="Search services"');
    expect(screen).toContain("filteredPresets.map((service)");
    expect(screen).toContain('data-testid="mcp-service-picker"');
    expect(screen).toContain("max-h-[min(42vh,340px)]");
    expect(screen).toContain("overflow-y-auto");
    expect(customMcp).toBeGreaterThan(-1);
    expect(servicePicker).toBeGreaterThan(customMcp);
    expect(presetList).toBe(-1);
  });

  test("keeps known services separate from custom URL discovery", () => {
    const screen = readFileSync(screenPath, "utf8");

    expect(screen).toContain("Choose a service, or connect an MCP server by URL.");
    expect(screen).toContain("Connect with a server URL");
    expect(screen).toContain('{alreadyAdded ? "Added" : "Add"}');
    expect(screen).toContain("Paste the MCP server URL");
    expect(screen).toContain('placeholder="https://mcp.example.com/mcp"');
    expect(screen).toContain('onClick={() => onSelectPreset(service)}');
    expect(screen).toContain('if (kind !== "url" && kind !== "domain")');
    expect(screen).not.toContain("or just type a name like");
  });
});
