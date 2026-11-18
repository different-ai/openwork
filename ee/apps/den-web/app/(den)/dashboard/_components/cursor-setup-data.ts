"use client";

import { useQuery } from "@tanstack/react-query";
import { autoRouterMemberListSchema, autoRouterModelId, autoRouterModelName, autoRouterThinkingLevels, type AutoRouterMemberList, type AutoRouterThinkingLevel } from "@openwork/types/den/auto-router";
import { claudeCodeModelName, cursorModelName, smartRouterToolName } from "@openwork/types/den/gateway-cursor";
import { z } from "zod";
import { getErrorMessage, requestJson } from "../../_lib/den-flow";
import { getLibraryRoute } from "../../_lib/den-org";
import { ORG_SCOPE_HEADER } from "../../_lib/org-scope";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

/**
 * Setting up a 3rd party tool with an AI Gateway API key: the models
 * the viewer can use right now, one entry per model however many groups and credential sets grant
 * it, as the AI Gateway lists them, then the Smart Routers they can use.
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
  /**
   * The Gateway model id (`gwm_…`) tools send to the provider-less endpoints; `openwork-smart-<id>`
   * for a Smart Router (POST /chat/completions only).
   */
  alias: string;
  /** The end of the alias that names the model itself; what a Cursor name is matched on. */
  modelId: string;
  name: string;
  providerName: string;
  /** The catalog provider, such as `anthropic` or `openai`. */
  providerKey: string;
  /** The provider's own id for the model, such as `claude-sonnet-4-5`. */
  upstreamModelId: string;
  /** Tokens the model reads at most, when its catalog entry says. */
  contextWindow: number | null;
  thinkingLevels: AutoRouterThinkingLevel[];
  /** A Smart Router's own name ("Engineering"), or null for a model. */
  smartRouterName: string | null;
};

function contextWindow(config: Record<string, unknown> | undefined): number | null {
  const limit = config?.limit;
  const context = typeof limit === "object" && limit !== null && !Array.isArray(limit) ? Reflect.get(limit, "context") : null;
  return typeof context === "number" && Number.isFinite(context) ? context : null;
}

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
        upstreamModelId: model.upstreamModelId,
        contextWindow: contextWindow(model.config),
        thinkingLevels: autoRouterThinkingLevels(model.upstreamModelId, model.config ?? {}),
        smartRouterName: null,
      });
    }
  }
  return [...models.values()].sort((a, b) => a.name.localeCompare(b.name) || a.modelId.localeCompare(b.modelId));
}

/**
 * The viewer's Smart Routers as tool models, after the models: "Smart: <name>" like the desktop's
 * picker. Smart picks the model and thinking level per prompt, so there are no levels to choose and
 * no context window or Claude id to declare.
 */
export function smartToolModels(payload: AutoRouterMemberList): GatewayToolModel[] {
  return payload.routers
    .map((router) => ({
      alias: autoRouterModelId(router.id),
      modelId: router.id,
      name: autoRouterModelName(router.name),
      providerName: "Smart Model Router",
      providerKey: "openwork",
      upstreamModelId: "",
      contextWindow: null,
      thinkingLevels: ["default" as const],
      smartRouterName: router.name,
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.modelId.localeCompare(b.modelId));
}

/** How a dropdown shows a model: "Claude Opus 5.5 · Anthropic", or "Smart: Engineering". */
export function gatewayToolModelLabel(model: GatewayToolModel): string {
  return model.smartRouterName === null ? `${model.name} · ${model.providerName}` : model.name;
}

/** The name Cursor and Codex take: `openwork/<model>-<id end>[:level]`, or `openwork/smart-<router>-<id end>`. */
export function gatewayToolModelName(model: GatewayToolModel, thinking?: AutoRouterThinkingLevel): string {
  if (model.smartRouterName !== null) return smartRouterToolName({ routerName: model.smartRouterName, routerId: model.modelId });
  return cursorModelName({ name: model.name, modelId: model.modelId, thinking });
}

/** The name Claude Code takes: like Cursor's, with `[1m]` on 1M token models (never on a Smart Router). */
export function claudeCodeToolModelName(model: GatewayToolModel): string {
  if (model.smartRouterName !== null) return gatewayToolModelName(model);
  return claudeCodeModelName({ name: model.name, modelId: model.modelId, contextWindow: model.contextWindow });
}

/** Smart Routers are optional here: any failure just lists none. */
async function fetchSmartRouters(orgId: string, signal: AbortSignal): Promise<GatewayToolModel[]> {
  try {
    const { response, payload } = await requestJson("/v1/org/auto-router/mine", { method: "GET", headers: { [ORG_SCOPE_HEADER]: orgId }, signal }, 15_000);
    if (!response.ok) return [];
    const parsed = autoRouterMemberListSchema.safeParse(payload);
    return parsed.success ? smartToolModels(parsed.data) : [];
  } catch {
    return [];
  }
}

export function useGatewayToolModels(enabled: boolean) {
  const { orgId } = useOrgDashboard();
  return useQuery({
    queryKey: ["gateway-tool-setup", "models", orgId],
    enabled: enabled && Boolean(orgId),
    queryFn: async ({ signal }) => {
      if (!orgId) throw new Error("Select an organization first.");
      const [{ response, payload }, smart] = await Promise.all([
        requestJson("/v1/inference-providers?scope=usable", { method: "GET", headers: { [ORG_SCOPE_HEADER]: orgId }, signal }, 15_000),
        fetchSmartRouters(orgId, signal),
      ]);
      if (!response.ok) throw new Error(getErrorMessage(payload, "Your models did not load. Try again."));
      const parsed = usableProvidersSchema.safeParse(payload);
      if (!parsed.success) throw new Error("Your models did not load. Try again.");
      return [...gatewayToolModels(parsed.data), ...smart];
    },
  });
}

/** A Claude model Claude Code knows by this id, so it can treat the OpenWork name as that model. */
export function claudeModelId(model: GatewayToolModel): string | null {
  return /^claude-[a-z0-9-]+$/.test(model.upstreamModelId) ? model.upstreamModelId : null;
}

export function getCursorSetupRoute(orgSlug?: string | null): string {
  return `${getLibraryRoute(orgSlug)}/tools/cursor`;
}
