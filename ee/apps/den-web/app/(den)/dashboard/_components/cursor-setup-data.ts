"use client";

import { useQuery } from "@tanstack/react-query";
import { autoRouterThinkingLevels, type AutoRouterThinkingLevel } from "@openwork/types/den/auto-router";
import { z } from "zod";
import { getErrorMessage, requestJson } from "../../_lib/den-flow";
import { getLibraryRoute } from "../../_lib/den-org";
import { ORG_SCOPE_HEADER } from "../../_lib/org-scope";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

/**
 * Setting up a 3rd party tool with an AI Gateway API key (feature `gatewayCursorSetup`): the models
 * the viewer can use right now, one entry per model however many groups and credential sets grant
 * it, as the AI Gateway lists them.
 */
const usableProvidersSchema = z.object({
  inferenceProviders: z.array(z.object({
    name: z.string(),
    /** The catalog provider, such as `anthropic` or `openai`. */
    providerId: z.string(),
    models: z.array(z.object({
      /** gwm_<group>_<credential set>_<model>: it ends with the model's own id. */
      id: z.string(),
      name: z.string(),
      upstreamModelId: z.string(),
      config: z.record(z.string(), z.unknown()).optional(),
    })),
  })),
});

export type GatewayToolModel = {
  /** The Gateway model id (`gwm_…`) tools send to the provider-less endpoints. */
  alias: string;
  /** The end of the alias that names the model itself; what a Cursor name is matched on. */
  modelId: string;
  name: string;
  providerName: string;
  /** The catalog provider, such as `anthropic` or `openai`. */
  providerKey: string;
  thinkingLevels: AutoRouterThinkingLevel[];
};

/** Characters of a TypeID after its prefix. */
const MODEL_ID_LENGTH = 26;

export function gatewayToolModels(payload: z.infer<typeof usableProvidersSchema>): GatewayToolModel[] {
  const models = new Map<string, GatewayToolModel>();
  for (const provider of payload.inferenceProviders) {
    for (const model of provider.models) {
      const modelId = model.id.slice(-MODEL_ID_LENGTH);
      if (models.has(modelId)) continue;
      models.set(modelId, {
        alias: model.id,
        modelId,
        name: model.name,
        providerName: provider.name,
        providerKey: provider.providerId,
        thinkingLevels: autoRouterThinkingLevels(model.upstreamModelId, model.config ?? {}),
      });
    }
  }
  return [...models.values()].sort((a, b) => a.name.localeCompare(b.name) || a.modelId.localeCompare(b.modelId));
}

export function useGatewayToolModels(enabled: boolean) {
  const { orgId } = useOrgDashboard();
  return useQuery({
    queryKey: ["gateway-tool-setup", "models", orgId],
    enabled: enabled && Boolean(orgId),
    queryFn: async ({ signal }) => {
      if (!orgId) throw new Error("Select an organization first.");
      const { response, payload } = await requestJson("/v1/inference-providers?scope=usable", { method: "GET", headers: { [ORG_SCOPE_HEADER]: orgId }, signal }, 15_000);
      if (!response.ok) throw new Error(getErrorMessage(payload, "Your models did not load. Try again."));
      const parsed = usableProvidersSchema.safeParse(payload);
      if (!parsed.success) throw new Error("Your models did not load. Try again.");
      return gatewayToolModels(parsed.data);
    },
  });
}

/**
 * Providers whose models answer the Gateway's provider-less endpoint each tool calls: Codex sends the
 * Responses API, Claude Code the Anthropic Messages API. Cursor reaches every model.
 */
const RESPONSES_PROVIDERS = new Set(["openai", "azure"]);
const MESSAGES_PROVIDERS = new Set(["anthropic", "google-vertex-anthropic", "microsoft-foundry"]);

export function codexModels(models: readonly GatewayToolModel[]) {
  return models.filter((model) => RESPONSES_PROVIDERS.has(model.providerKey));
}

export function claudeCodeModels(models: readonly GatewayToolModel[]) {
  return models.filter((model) => MESSAGES_PROVIDERS.has(model.providerKey));
}

export function getCursorSetupRoute(orgSlug?: string | null): string {
  return `${getLibraryRoute(orgSlug)}/tools/cursor`;
}
