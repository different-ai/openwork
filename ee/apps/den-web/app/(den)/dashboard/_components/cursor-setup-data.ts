"use client";

import { useQuery } from "@tanstack/react-query";
import { autoRouterMemberListSchema, autoRouterModelId, autoRouterModelName, autoRouterThinkingLevels, type AutoRouterMemberList, type AutoRouterThinkingLevel } from "@openwork/types/den/auto-router";
import { claudeCodeModelName, cursorModelName, smartRouterToolName } from "@openwork/types/den/gateway-cursor";
import { z } from "zod";
import { getErrorMessage, requestJson } from "../../_lib/den-flow";
import { getLibraryRoute } from "../../_lib/den-org";
import { ORG_SCOPE_HEADER } from "../../_lib/org-scope";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

const usableProvidersSchema = z.object({
  inferenceProviders: z.array(z.object({
    name: z.string(),
    providerId: z.string(),
    models: z.array(z.object({
      id: z.string(),
      name: z.string(),
      upstreamModelId: z.string(),
      config: z.record(z.string(), z.unknown()).optional(),
    })),
  })),
});

export type GatewayToolModel = {
  alias: string;
  modelId: string;
  name: string;
  providerName: string;
  providerKey: string;
  upstreamModelId: string;
  contextWindow: number | null;
  thinkingLevels: AutoRouterThinkingLevel[];
  smartRouterName: string | null;
};

function contextWindow(config: Record<string, unknown> | undefined): number | null {
  const limit = config?.limit;
  const context = typeof limit === "object" && limit !== null && !Array.isArray(limit) ? Reflect.get(limit, "context") : null;
  return typeof context === "number" && Number.isFinite(context) ? context : null;
}

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

export function gatewayToolModelLabel(model: GatewayToolModel): string {
  return model.smartRouterName === null ? `${model.name} · ${model.providerName}` : model.name;
}

export function gatewayToolModelName(model: GatewayToolModel, thinking?: AutoRouterThinkingLevel): string {
  if (model.smartRouterName !== null) return smartRouterToolName({ routerName: model.smartRouterName, routerId: model.modelId });
  return cursorModelName({ name: model.name, modelId: model.modelId, thinking });
}

export function claudeCodeToolModelName(model: GatewayToolModel): string {
  if (model.smartRouterName !== null) return gatewayToolModelName(model);
  return claudeCodeModelName({ name: model.name, modelId: model.modelId, contextWindow: model.contextWindow });
}

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

export function claudeModelId(model: GatewayToolModel): string | null {
  return /^claude-[a-z0-9-]+$/.test(model.upstreamModelId) ? model.upstreamModelId : null;
}

export function getCursorSetupRoute(orgSlug?: string | null): string {
  return `${getLibraryRoute(orgSlug)}/tools/cursor`;
}
