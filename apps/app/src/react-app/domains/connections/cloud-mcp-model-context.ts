import type { ModelRef } from "@/app/types";
import type { OpenworkCloudMcpProviderModelContext } from "@/app/lib/openwork-server";

export function cloudMcpModelContext(input: {
  sessionModel?: ModelRef | null;
  workspaceModel?: ModelRef | null;
  orgModel?: ModelRef | null;
  globalModel?: ModelRef | null;
  providerList?: { all: ReadonlyArray<{ id: string; models: Readonly<Record<string, unknown>> }> };
}): OpenworkCloudMcpProviderModelContext | undefined {
  const scopedModel = input.sessionModel ?? input.workspaceModel ?? input.orgModel;
  const model = scopedModel ?? input.globalModel;
  if (!model?.providerID.trim() || !model.modelID.trim()) return undefined;
  if (!scopedModel && !input.providerList?.all.some((provider) =>
    provider.id === model.providerID && Boolean(provider.models[model.modelID]))) return undefined;
  return { provider: model.providerID, model: model.modelID };
}
