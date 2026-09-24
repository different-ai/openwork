import { describe, expect, test } from "bun:test";

import type { ProviderListItem } from "../src/app/types";
import type { GatewayConnectProvider } from "../src/react-app/domains/connections/provider-auth/cloud-provider-config";
import {
  buildLibraryModelProviders,
  libraryModelDetailId,
  libraryModelSignInKey,
  modelNamesSummary,
  modelVendor,
  parseLibraryModelDetailId,
} from "../src/react-app/domains/settings/library-models";
import { primaryLibraryFilter, extensionInventoryFilters } from "../src/react-app/domains/settings/extension-taxonomy";
import { filterForSection } from "../src/react-app/domains/settings/pages/extensions-view";

function provider(id: string, source: ProviderListItem["source"], models: Record<string, string>): ProviderListItem {
  return {
    id, name: id === "anthropic" ? "Anthropic" : id, source, env: [], options: {},
    models: Object.fromEntries(Object.entries(models).map(([modelId, name]) => [modelId, {
      id: modelId, providerID: id, name, api: { id: modelId, url: "", npm: "" },
      capabilities: { temperature: true, reasoning: false, attachment: false, toolcall: true, input: { text: true, audio: false, image: false, video: false, pdf: false }, output: { text: true, audio: false, image: false, video: false, pdf: false }, interleaved: false },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } }, limit: { context: 1, output: 1 }, status: "active", options: {}, headers: {}, release_date: "",
    }])),
  } satisfies ProviderListItem;
}

const googleCloud: GatewayConnectProvider = {
  cloudProviderId: "ipr_google", credentialSetId: "gcs_member", providerId: "ipr_google", name: "Google Cloud", authUrl: null,
  models: [
    { id: "gwm_a_b_c", name: "Gemini 2.5 Pro", config: { id: "gwm_a_b_c" }, upstreamModelId: "gemini-2.5-pro", modelGroupId: "gmg_1", modelGroupName: "Everyone", credentialSetId: "gcs_member", credentialSetName: "Your Google account" },
    { id: "gwm_a_b_d", name: "Claude Sonnet 4.5", config: { id: "gwm_a_b_d" }, upstreamModelId: "claude-sonnet-4-5@20250929", modelGroupId: "gmg_1", modelGroupName: "Everyone", credentialSetId: "gcs_member", credentialSetName: "Your Google account" },
  ],
};

describe("Library, Models", () => {
  test("Models is a Library filter with its own URL", () => {
    expect(extensionInventoryFilters).toContain("model");
    expect(primaryLibraryFilter("model")).toBe("model");
    expect(filterForSection("models")).toBe("model");
  });

  test("providers land where they come from: this computer, added by you, or OpenWork", () => {
    const rows = buildLibraryModelProviders({
      connected: [
        provider("ollama", "config", { "llama3.2": "Llama 3.2" }),
        provider("anthropic", "api", { "claude-sonnet-4-5": "Claude Sonnet 4.5" }),
        provider("openwork", "custom", { "gpt-5.4": "GPT-5.4" }),
      ],
      pending: [googleCloud],
      importedCloudProviders: {},
      isAllowed: () => true,
    });
    expect(rows.map((row) => [row.name, row.section, row.state])).toEqual([
      ["Anthropic", "mine", "api_key"],
      ["Google Cloud", "openwork", "needs_signin"],
      ["ollama", "mac", "ready"],
      ["openwork", "openwork", "ready"],
    ]);
    const google = rows.find((row) => row.name === "Google Cloud");
    expect(google?.iconSlug).toBe("googlecloud");
    expect(google && libraryModelSignInKey(google)).toBe("ipr_google:gcs_member");
    expect(google?.models.map((model) => `${model.name}: ${model.vendor}`)).toEqual(["Claude Sonnet 4.5: Anthropic", "Gemini 2.5 Pro: Google"]);
  });

  test("organization policy hides providers the person may not use", () => {
    const rows = buildLibraryModelProviders({
      connected: [provider("anthropic", "api", { a: "A" }), provider("opencode", "custom", { "big-pickle": "Big Pickle" })],
      pending: [googleCloud],
      importedCloudProviders: {},
      isAllowed: (id) => id !== "opencode" && id !== "ipr_google",
    });
    expect(rows.map((row) => row.name)).toEqual(["Anthropic"]);
  });

  test("a provider that is partly signed in keeps its ready row and remembers the set still to sign in", () => {
    const rows = buildLibraryModelProviders({
      connected: [provider("ipr_google", "custom", { gwm_x: "Gemini 2.5 Flash" })],
      pending: [googleCloud],
      importedCloudProviders: { ipr_google: { cloudProviderId: "ipr_google", providerId: "ipr_google", sourceProviderId: "google-vertex", name: "Google Cloud", source: "openwork_gateway", updatedAt: null, modelIds: ["gwm_x"], importedAt: null } },
      isAllowed: () => true,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "Google Cloud", state: "ready", section: "openwork", iconSlug: "googlecloud" });
    expect(rows[0]?.pending).toHaveLength(1);
  });

  test("rows read in words and open by a stable address", () => {
    expect(modelNamesSummary([{ name: "A" }, { name: "B" }, { name: "C" }, { name: "D" }, { name: "E" }])).toBe("A, B, C and 2 more");
    expect(parseLibraryModelDetailId(libraryModelDetailId({ key: "pending:ipr_google" }))).toBe("pending:ipr_google");
    expect(modelVendor({ id: "acme-1", name: "Acme One" }, { name: "Acme", sourceProviderId: "acme" }).vendor).toBe("Acme");
  });
});
