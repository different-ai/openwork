import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const screenPath = fileURLToPath(
  new URL("../app/(den)/dashboard/_components/mcp-connections-screen.tsx", import.meta.url),
);

describe("MCP URL entry UI contract", () => {
  test("opens the generic MCP dialog directly on URL discovery", () => {
    const screen = readFileSync(screenPath, "utf8");

    expect(screen).toContain('useState<"smart" | "advanced">(preset ? "advanced" : "smart")');
    expect(screen).toContain("Add an MCP server");
    expect(screen).toContain("Paste the MCP server URL");
    expect(screen).toContain("Paste a server URL and we&apos;ll check it for you.");
    expect(screen).toContain('placeholder="https://mcp.example.com/mcp"');
    expect(screen).toContain('if (kind !== "url" && kind !== "domain")');
    expect(screen).not.toContain('data-testid="select-custom-mcp"');
    expect(screen).not.toContain('data-testid="mcp-service-picker"');
    expect(screen).not.toContain('aria-label="Filter services"');
    expect(screen).not.toContain('placeholder="Search services"');
    expect(screen).not.toContain("or just type a name");
  });

  test("keeps preset quick-add setup separate from the generic URL flow", () => {
    const screen = readFileSync(screenPath, "utf8");

    expect(screen).toContain("setFormPreset(preset);");
    expect(screen).toContain("{preset ? `Add ${preset.displayName}` : \"Add a custom MCP server\"}");
    expect(screen).toContain("disabled={Boolean(preset)}");
    expect(screen).not.toContain("existingConnectionUrls");
    expect(screen).not.toContain("onSelectPreset");
  });

  test("offers one compact bulk control for long optional permission lists", () => {
    const screen = readFileSync(screenPath, "utf8");

    expect(screen).toContain("optionalScopes.length > OPTIONAL_SCOPE_BULK_TOGGLE_THRESHOLD");
    expect(screen).toContain('role="checkbox"');
    expect(screen).toContain('"mixed"');
    expect(screen).toContain('"Deselect all" : "Select all"');
    expect(screen).toContain('data-testid="toggle-all-optional-permissions"');
    expect(screen).toContain("toggleAllOptionalScopes(current, optionalScopes)");
  });
});
