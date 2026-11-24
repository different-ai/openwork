import type { ModelRef } from "../../../app/types";
import type { DenDesktopConfig } from "../../../app/lib/den";
import { isOpencodeV2BaseUrl } from "../../../app/lib/opencode-v2-adapter";

export function orgDefaultModelForEngine(
  defaultModel: DenDesktopConfig["defaultModel"],
  opencodeBaseUrl: string | null | undefined,
): ModelRef | null {
  if (!defaultModel || !opencodeBaseUrl || !isOpencodeV2BaseUrl(opencodeBaseUrl)) return null;
  const providerID = defaultModel.providerID.trim();
  const modelID = defaultModel.modelID.trim();
  return providerID && modelID ? { providerID, modelID } : null;
}

export function newChatDefaultModel(input: {
  workspaceDefault: { model: ModelRef; variant: string | null } | null;
  orgDefault: ModelRef | null;
  appDefault: { model: ModelRef | null; variant: string | null };
}): { model: ModelRef | null; variant: string | null } {
  if (input.workspaceDefault) return input.workspaceDefault;
  if (input.orgDefault) return { model: input.orgDefault, variant: null };
  return input.appDefault;
}
