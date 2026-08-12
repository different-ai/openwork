import { describe, expect, test } from "vitest";

import type { DenOrgLlmProvider } from "../src/app/lib/den";
import type { ModelOption } from "../src/app/types";
import {
  assignedModelOptions,
  mergeModelOptions,
} from "../src/react-app/domains/connections/provider-auth/assigned-model-options";

function provider(
  input: Pick<DenOrgLlmProvider, "id" | "source" | "providerId" | "name" | "hasApiKey" | "models">,
): DenOrgLlmProvider {
  return {
    ...input,
    providerConfig: {},
    createdAt: null,
    updatedAt: null,
  };
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

  test("keeps local API-key models and lets the live workspace catalog replace fallbacks", () => {
    const fallback = option("lpr_anthropic_team", "claude-sonnet", "Assigned Sonnet");
    const live = option("lpr_anthropic_team", "claude-sonnet", "Live Sonnet");
    const local = option("openai", "gpt-5", "GPT-5");

    expect(mergeModelOptions([live, local], [fallback])).toEqual([live, local]);
  });
});
