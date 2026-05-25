import type { DesktopPolicyKey } from "@openwork/types/den/desktop-policies";
import type { DenDesktopConfig } from "../lib/den";
import type { ModelRef } from "../types";

export type DesktopAppRestrictionKey = DesktopPolicyKey;

export type DesktopAppRestrictionChecker = (input: {
  restriction: DesktopAppRestrictionKey;
}) => boolean;

export const DESKTOP_RESTRICTION_OPENCODE_PROVIDER_ID = "opencode";

export function checkDesktopAppRestriction(input: {
  config: DenDesktopConfig | null | undefined;
  restriction: DesktopAppRestrictionKey;
}) {
  return input.config?.[input.restriction] === false;
}

export function isDesktopProviderBlocked(input: {
  providerId: string;
  checkRestriction: DesktopAppRestrictionChecker;
}) {
  const providerId = input.providerId.trim().toLowerCase();
  if (!providerId) return false;

  if (providerId === DESKTOP_RESTRICTION_OPENCODE_PROVIDER_ID) {
    return input.checkRestriction({ restriction: "allowZenModel" });
  }

  return false;
}

export function isDesktopModelBlocked(input: {
  model: ModelRef;
  checkRestriction: DesktopAppRestrictionChecker;
}) {
  return isDesktopProviderBlocked({
    providerId: input.model.providerID,
    checkRestriction: input.checkRestriction,
  });
}

type DesktopAppRestrictionSyncContext = {
  checkRestriction: DesktopAppRestrictionChecker;
  reconcileRestrictedModels?: () => void;
  ensureProjectProviderDisabledState?: (providerId: string, disabled: boolean) => Promise<unknown>;
  onError?: (error: Error, details: {
    restriction: DesktopAppRestrictionKey;
    action: string;
    providerId?: string;
  }) => void;
};

export async function runDesktopAppRestrictionSyncEffects(
  input: DesktopAppRestrictionSyncContext,
) {
  const shouldDisableOpencodeProvider = input.checkRestriction({ restriction: "allowZenModel" });

  input.reconcileRestrictedModels?.();

  if (input.ensureProjectProviderDisabledState) {
    try {
      await input.ensureProjectProviderDisabledState(
        DESKTOP_RESTRICTION_OPENCODE_PROVIDER_ID,
        shouldDisableOpencodeProvider,
      );
    } catch (error) {
      input.onError?.(
        error instanceof Error ? error : new Error(String(error ?? "Desktop restriction effect failed.")),
        {
          restriction: "allowZenModel",
          action: "ensureProjectProviderDisabledState",
          providerId: DESKTOP_RESTRICTION_OPENCODE_PROVIDER_ID,
        },
      );
    }
  }
}
