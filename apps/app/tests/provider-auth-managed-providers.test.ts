import { describe, expect, test } from "bun:test";

import type { DenOrgLlmProvider } from "../src/app/lib/den";
import {
  getCloudManagedProviderId,
  resolveAppliedManagedProvidersFromSyncResult,
} from "../src/react-app/domains/connections/provider-auth/store";

function provider(input: Partial<DenOrgLlmProvider> & Pick<DenOrgLlmProvider, "id" | "providerId">): DenOrgLlmProvider {
  return {
    source: "models_dev",
    credentialKind: "api_key",
    name: input.providerId,
    providerConfig: {},
    hasApiKey: true,
    hasOpencodeAuth: false,
    hasCredential: true,
    models: [],
    createdAt: null,
    updatedAt: null,
    ...input,
  };
}

describe("cloud managed provider import identity", () => {
  test("resolves runtime provider IDs for OAuth and OpenWork managed providers", () => {
    expect(getCloudManagedProviderId(provider({
      id: "lpr_openai",
      providerId: "openai",
      credentialKind: "opencode_oauth",
    }))).toBe("openai");

    expect(getCloudManagedProviderId(provider({
      id: "lpr_openwork",
      providerId: "openwork-cloud",
      source: "openwork",
    }))).toBe("openwork");

    expect(getCloudManagedProviderId(provider({
      id: "lpr_nvidia",
      providerId: "nvidia",
      credentialKind: "api_key",
    }))).toBe("nvidia");

    expect(getCloudManagedProviderId(provider({
      id: "lpr_custom",
      providerId: "custom-source",
      credentialKind: "api_key",
      providerConfig: { id: "custom-runtime" },
    }))).toBe("custom-runtime");
  });

  test("remote sync only records providers identified as applied by Den", () => {
    const liveProviders = [
      provider({ id: "lpr_applied", providerId: "openai" }),
      provider({ id: "lpr_filtered", providerId: "anthropic" }),
    ];

    expect(resolveAppliedManagedProvidersFromSyncResult({
      providerCount: 1,
      providerIds: ["lpr_applied"],
    }, liveProviders).map((entry) => entry.id)).toEqual(["lpr_applied"]);
  });

  test("remote sync clears imported state when Den applies an empty provider set", () => {
    expect(resolveAppliedManagedProvidersFromSyncResult({
      providerCount: 0,
    }, [provider({ id: "lpr_filtered", providerId: "anthropic" })])).toEqual([]);
  });

  test("remote sync refuses ambiguous partial results without applied provider IDs", () => {
    expect(() => resolveAppliedManagedProvidersFromSyncResult({
      providerCount: 1,
    }, [
      provider({ id: "lpr_applied", providerId: "openai" }),
      provider({ id: "lpr_filtered", providerId: "anthropic" }),
    ])).toThrow("did not identify which providers were applied");
  });
});
