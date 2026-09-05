import { describe, expect, test } from "vitest";

import type { DenOrgLlmProvider } from "../src/app/lib/den";
import type { ModelOption } from "../src/app/types";
import {
  assignedModelOptions,
  mergeModelOptions,
} from "../src/react-app/domains/connections/provider-auth/assigned-model-options";

function provider(
  input: Pick<DenOrgLlmProvider, "id" | "source" | "providerId" | "name" | "hasApiKey" | "models"> &
    Partial<Pick<DenOrgLlmProvider, "providerConfig" | "hasMyCredential">>,
): DenOrgLlmProvider {
  return {
    providerConfig: {},
    createdAt: null,
    updatedAt: null,
    ...input,
  };
}

const perMemberModels = [{ id: "litellm-model-01", name: "LiteLLM Model 1", config: {}, createdAt: null }];

function perMemberProvider(hasMyCredential: boolean | undefined): DenOrgLlmProvider {
  return provider({
    id: "lpr_acme_litellm",
    source: "custom",
    providerId: "acme-litellm",
    name: "Acme LiteLLM",
    providerConfig: { env: ["LITELLM_API_KEY"] },
    hasApiKey: false,
    ...(hasMyCredential === undefined ? {} : { hasMyCredential }),
    models: perMemberModels,
  });
}

function option(providerID: string, modelID: string, title: string): ModelOption {
  return {
    providerID,
    modelID,
    title,
    behaviorTitle: "Reasoning",
    behaviorLabel: "Default",
    behaviorDescription: "",
    behaviorValue: null,
    isFree: false,
  };
}

describe("assigned model options", () => {
  test("exposes member-assigned provider models before a workspace exists", () => {
    const result = assignedModelOptions([
      provider({
        id: "lpr_anthropic_team",
        source: "custom",
        providerId: "anthropic",
        name: "Team Anthropic",
        hasApiKey: true,
        models: [{ id: "claude-sonnet", name: "Claude Sonnet", config: {}, createdAt: null }],
      }),
      provider({
        id: "lpr_openwork_subscription",
        source: "openwork",
        providerId: "openwork",
        name: "OpenWork Models",
        hasApiKey: false,
        models: [{ id: "gpt-5", name: "GPT-5", config: {}, createdAt: null }],
      }),
    ]);

    expect(result).toMatchObject([
      {
        providerID: "lpr_anthropic_team",
        modelID: "claude-sonnet",
        title: "Claude Sonnet",
        description: "Team Anthropic",
        source: "cloud",
      },
      {
        providerID: "openwork",
        modelID: "gpt-5",
        title: "GPT-5",
        description: "OpenWork Models",
        source: "cloud",
      },
    ]);
  });

  test("drops a granted provider whose credential the member no longer has", () => {
    // A per-member provider (hasApiKey is always false) is offered only while
    // the calling member holds an active binding. After the member's key is
    // removed the grant remains but the engine can never connect it, so the
    // picker must not list its models (field-reported stale "Enabled" defect).
    expect(assignedModelOptions([perMemberProvider(false)])).toEqual([]);
    expect(assignedModelOptions([perMemberProvider(undefined)])).toEqual([]);

    expect(assignedModelOptions([perMemberProvider(true)])).toMatchObject([
      { providerID: "lpr_acme_litellm", modelID: "litellm-model-01", source: "cloud" },
    ]);
  });

  test("keeps shared-key providers and providers that declare no credential", () => {
    expect(
      assignedModelOptions([
        provider({
          id: "lpr_shared",
          source: "custom",
          providerId: "shared-gateway",
          name: "Shared Gateway",
          providerConfig: { env: ["SHARED_GATEWAY_API_KEY"] },
          hasApiKey: true,
          models: perMemberModels,
        }),
        provider({
          id: "lpr_keyless",
          source: "custom",
          providerId: "keyless-gateway",
          name: "Keyless Gateway",
          hasApiKey: false,
          models: perMemberModels,
        }),
      ]).map((option) => option.providerID),
    ).toEqual(["lpr_shared", "lpr_keyless"]);
  });

  test("keeps local API-key models and lets the live workspace catalog replace fallbacks", () => {
    const fallback = option("lpr_anthropic_team", "claude-sonnet", "Assigned Sonnet");
    const live = option("lpr_anthropic_team", "claude-sonnet", "Live Sonnet");
    const local = option("openai", "gpt-5", "GPT-5");

    expect(mergeModelOptions([live, local], [fallback])).toEqual([live, local]);
  });
});
