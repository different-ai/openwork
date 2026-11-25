import { describe, expect, test } from "bun:test";
import type { GatewayUsableModel } from "@openwork/types/den/gateway";

import type { CloudImportedProvider } from "../src/app/cloud/import-state";
import {
  gatewayConnectProviderKey,
  type GatewayConnectProvider,
  type LiveGatewayProvider,
} from "../src/react-app/domains/connections/provider-auth/cloud-provider-config";
import { librarySignInBrand } from "../src/react-app/domains/settings/library-models";
import { buildLibraryModelProviders } from "../src/react-app/shell/library-model-providers";

const model = (name: string, credentialSetId = "gcs_shared"): GatewayUsableModel => ({
  id: `gwm_group_${credentialSetId.slice(4)}_${name}`,
  name,
  config: { id: `gwm_group_${credentialSetId.slice(4)}_${name}` },
  upstreamModelId: name,
  modelGroupId: "gmg_group",
  modelGroupName: "Default",
  credentialSetId,
  credentialSetName: "Shared",
});

const live = (overrides: Partial<LiveGatewayProvider> & Pick<LiveGatewayProvider, "id" | "name" | "providerId">): LiveGatewayProvider => ({
  credentialStatus: "ready",
  updatedAt: "2026-11-24T00:00:00.000Z",
  models: [],
  authorizationRequests: [],
  ...overrides,
});

const imported = (overrides: Partial<CloudImportedProvider> & Pick<CloudImportedProvider, "cloudProviderId" | "name">): CloudImportedProvider => ({
  providerId: overrides.cloudProviderId,
  sourceProviderId: "openai",
  source: null,
  updatedAt: null,
  modelIds: [],
  importedAt: null,
  ...overrides,
});

describe("buildLibraryModelProviders", () => {
  test("live providers: ready with models, needs sign-in when only a pending set, blocked otherwise", () => {
    const vertexSignIn: GatewayConnectProvider = { cloudProviderId: "ipr_vertex", credentialSetId: "gcs_me", providerId: "ipr_vertex", name: "Google Cloud / Mine", authUrl: null };
    const rows = buildLibraryModelProviders({
      liveGatewayProviders: [
        live({ id: "ipr_vertex", name: "Google Cloud", providerId: "google-vertex", credentialStatus: "member_auth_required", authorizationRequests: [{ credentialSetId: "gcs_me", name: "Mine", authUrl: "", models: [model("Gemini 2.5 Pro", "gcs_me")] }] }),
        live({ id: "ipr_anthropic", name: "Anthropic", providerId: "anthropic", models: [model("Claude Sonnet"), model("Claude Sonnet")] }),
        live({ id: "ipr_broken", name: "Bedrock", providerId: "amazon-bedrock", credentialStatus: "org_credential_missing" }),
      ],
      importedCloudProviders: {},
      gatewayConnectProviders: [vertexSignIn],
    });
    expect(rows.map((row) => [row.name, row.state, row.modelNames])).toEqual([
      ["Anthropic", "ready", ["Claude Sonnet"]],
      ["Bedrock", "blocked", []],
      ["Google Cloud", "needs_signin", ["Gemini 2.5 Pro"]],
    ]);
    expect(rows.find((row) => row.id === "ipr_vertex")?.signInKey).toBe(gatewayConnectProviderKey(vertexSignIn));
    expect(rows.filter((row) => row.state === "needs_signin")).toHaveLength(1);
  });

  test("server sync: synced providers are ready, skipped sign-ins become rows, gateway ids are not shown as names", () => {
    const rows = buildLibraryModelProviders({
      liveGatewayProviders: null,
      importedCloudProviders: {
        lpr_openai: imported({ cloudProviderId: "lpr_openai", name: "OpenAI", modelIds: ["gpt-4o", "gpt-4o-mini"] }),
        ipr_gw: imported({ cloudProviderId: "ipr_gw", name: "Team models", modelIds: ["gwm_a_b_c"] }),
      },
      gatewayConnectProviders: [{ cloudProviderId: "ipr_litellm", credentialSetId: "gcs_x", providerId: "ipr_litellm", name: "LiteLLM / Work", authUrl: null, models: [model("GPT-5", "gcs_x")] }],
    });
    expect(rows.map((row) => [row.name, row.state, row.modelNames, row.modelCount])).toEqual([
      ["LiteLLM", "needs_signin", ["GPT-5"], 1],
      ["OpenAI", "ready", ["gpt-4o", "gpt-4o-mini"], 2],
      ["Team models", "ready", [], 1],
    ]);
  });

  test("a live provider is not listed twice when it is also synced", () => {
    const rows = buildLibraryModelProviders({
      liveGatewayProviders: [live({ id: "ipr_a", name: "A", providerId: "anthropic", models: [model("Claude")] })],
      importedCloudProviders: { ipr_a: imported({ cloudProviderId: "ipr_a", name: "A", modelIds: ["gwm_x"] }) },
      gatewayConnectProviders: [],
    });
    expect(rows).toHaveLength(1);
  });
});

describe("librarySignInBrand", () => {
  test("names the account people know", () => {
    expect(librarySignInBrand({ providerKey: "google-vertex" })).toBe("google");
    expect(librarySignInBrand({ providerKey: "amazon-bedrock" })).toBe("aws");
    expect(librarySignInBrand({ providerKey: "litellm" })).toBe("account");
    expect(librarySignInBrand({ providerKey: null })).toBe("account");
  });
});
