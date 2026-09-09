import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { presetAuthTypeOptions, SegmentedControl } from "../app/(den)/dashboard/_components/mcp-connection-form-controls";
import type { ExternalMcpPreset } from "../app/(den)/dashboard/_components/mcp-connections-data";

const screenPath = fileURLToPath(
  new URL("../app/(den)/dashboard/_components/mcp-connections-screen.tsx", import.meta.url),
);

describe("MCP URL entry UI contract", () => {
  test("opens the generic MCP dialog directly on URL discovery", () => {
    const screen = readFileSync(screenPath, "utf8");

    expect(screen).toContain('useState<"smart" | "advanced">(preset ? "advanced" : "smart")');
    expect(screen).toContain("Add an MCP server");
    expect(screen).toContain("Paste the MCP server URL");
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
    expect(screen).toContain("const activePreset = preset ?? resolution?.preset ?? null;");
    expect(screen).toContain("{activePreset ? `Add ${activePreset.displayName}` : \"Add a custom MCP server\"}");
    expect(screen).toContain("disabled={Boolean(activePreset)}");
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

  test("GitHub offers OAuth and PAT without allowing anonymous auth or changing the OAuth default", () => {
    const preset: ExternalMcpPreset = {
      presetId: "github", displayName: "GitHub", description: "Code", url: "https://api.githubcopilot.com/mcp/",
      authType: "oauth", supportedAuthTypes: ["oauth", "apikey"], requiresOAuthClient: true,
    };
    const options = presetAuthTypeOptions(preset);
    expect(options.map((option) => option.value)).toEqual(["oauth", "apikey"]);
    const render = (value: string) => renderToStaticMarkup(createElement(SegmentedControl, { options, value, onChange: () => {} }));
    expect(render(preset.authType)).toMatch(/aria-pressed="true"[^>]*>OAuth<\/button>/);
    expect(render("apikey")).toMatch(/aria-pressed="true"[^>]*>API key<\/button>/);
    expect(render("apikey")).not.toContain(">None<");
    expect(presetAuthTypeOptions({ ...preset, supportedAuthTypes: undefined }).map((option) => option.value)).toEqual(["oauth"]);
    expect(presetAuthTypeOptions(null).map((option) => option.value)).toEqual(["oauth", "apikey", "none"]);

    const screen = readFileSync(screenPath, "utf8");
    expect(screen).toContain("const authTypeOptions = presetAuthTypeOptions(activePreset);");
    expect(screen).toContain("authTypeOptions.length > 1");
    expect(screen).toContain("options={authTypeOptions}");
    expect(screen).toContain("if (!activePreset && !authTypeEdited.current)");
    expect(screen).toContain("authTypeEdited.current = true;");
  });
});
