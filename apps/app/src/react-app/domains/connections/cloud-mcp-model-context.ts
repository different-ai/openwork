import type { ModelRef } from "@/app/types";
import type { OpenworkCloudMcpProviderModelContext } from "@/app/lib/openwork-server";

/** Resolve Connect's model in the same scope as the conversation, not a legacy
 * app preference left behind by another workspace or organization. */
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
  // An unscoped legacy preference is not evidence that this workspace uses
  // that model. Until the engine confirms it exists, check Connect itself
  // without claiming the current model is unusable. Explicit selections still
  // get the server's missing-model/tool-capability diagnostics.
  if (!scopedModel && !input.providerList?.all.some((provider) =>
    provider.id === model.providerID && Boolean(provider.models[model.modelID]))) return undefined;
  return { provider: model.providerID, model: model.modelID };
}
