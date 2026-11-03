import assert from "node:assert/strict";
import { test } from "node:test";
import { catalogEntriesFromPresets } from "./connector-picker";
import type { ExternalMcpPreset } from "./mcp-connections-data";

const preset = (overrides: Partial<ExternalMcpPreset>): ExternalMcpPreset => ({
  presetId: "example", displayName: "Example", description: "Example tools.", url: "https://mcp.example.com/mcp", authType: "oauth", ...overrides,
});

test("a provider that refused OpenWork is marked before anyone clicks Add", () => {
  assert.equal(catalogEntriesFromPresets([preset({ registrationStatus: "dynamic_refused" })])[0]?.signInNote, "Approved apps only");
});

test("a provider with no registration method says it needs an OAuth app, unless OpenWork already handles that", () => {
  assert.equal(catalogEntriesFromPresets([preset({ registrationStatus: "requires_client" })])[0]?.signInNote, "Needs an OAuth app");
  assert.equal(catalogEntriesFromPresets([preset({ registrationStatus: "requires_client", requiresOAuthClient: true })])[0]?.signInNote, undefined);
  assert.equal(catalogEntriesFromPresets([preset({ registrationStatus: "requires_client", defaultOAuthClientId: "openwork" })])[0]?.signInNote, undefined);
});

test("one-click and unchecked providers carry no note", () => {
  for (const registrationStatus of ["client_metadata", "dynamic_open", "no_auth", "unknown", undefined] as const) {
    assert.equal(catalogEntriesFromPresets([preset({ registrationStatus })])[0]?.signInNote, undefined);
  }
});
