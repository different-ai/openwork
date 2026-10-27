import { useEffect, useRef, useState } from "react";
import { createDenClient, readDenSettings } from "@/app/lib/den";
import type { ModelRef } from "@/app/types";
import { useDenAuth } from "@/react-app/domains/cloud/den-auth-provider";
import { isCloudManagedProviderKey } from "@/react-app/domains/connections/provider-auth/cloud-provider-config";
import { modelRefKey } from "../models/model-collections-store";
import { confirmedOrganizationRemoval } from "./model-removal";
import { MODEL_UNAVAILABLE_CONFIRMATION_MS } from "./model-availability";
import { useModelRecoveryStore } from "./model-recovery-store";

const EMPTY_MODELS: readonly ModelRef[] = [];

/** An engine catalog is a transport snapshot, never evidence that an org removed access. */
export function useModelRemovalConfirmation(input: {
  model: ModelRef | null;
  missing: boolean;
  ready: boolean;
  scope: string;
  chatKey: string;
  refreshEngine: () => Promise<boolean>;
}) {
  const auth = useDenAuth();
  const settings = readDenSettings();
  const token = settings.authToken?.trim() ?? "";
  const organizationId = settings.activeOrgId?.trim() ?? "";
  const [confirmed, setConfirmed] = useState<{ modelKey: string; assignedModels: readonly ModelRef[] } | null>(null);
  const modelKey = input.model ? modelRefKey(input.model) : null;
  const current = useRef(input);
  current.current = input;
  const recovery = useModelRecoveryStore((state) => state.byChat[input.chatKey]);

  useEffect(() => {
    setConfirmed(null);
    if (!auth.isSignedIn || !token || !organizationId || !input.ready) return;
    const client = createDenClient({ baseUrl: settings.baseUrl, token, requireCompleteInventory: true });
    const selected = current.current.model;
    const needsConfirmation = input.missing && selected && isCloudManagedProviderKey(selected.providerID);
    if (!needsConfirmation && !recovery) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finishPause: (() => void) | undefined;
    const pause = () => new Promise<void>((resolve) => {
      finishPause = resolve;
      timer = setTimeout(resolve, MODEL_UNAVAILABLE_CONFIRMATION_MS);
    });
    const inspect = async () => {
      try {
        const before = await client.getModelRemovalInventory(organizationId);
        if (cancelled) return;
        if (recovery) {
          const previousKey = modelRefKey(recovery.previous);
          useModelRecoveryStore.getState().markReturned(input.chatKey,
            before.models.some((model) => modelRefKey(model) === previousKey)
              && !before.lockedModels.some((model) => modelRefKey(model) === previousKey));
        }
        if (needsConfirmation && selected) {
          await pause();
          if (cancelled) return;
          // Refetch after the reload grace period, then read Den independently a second time.
          const stillMissing = await current.current.refreshEngine();
          if (cancelled) return;
          const after = await client.getModelRemovalInventory(organizationId);
          if (cancelled) return;
          const removed = confirmedOrganizationRemoval({ model: selected, before, after,
            engineSettled: current.current.ready, engineMissing: stillMissing });
          const locked = new Set(after.lockedModels.map(modelRefKey));
          setConfirmed(removed && modelKey ? { modelKey,
            assignedModels: after.models.filter((model) => !locked.has(modelRefKey(model))) } : null);
        }
      } catch {
        // Offline, sign-in failures, old Den versions and partial inventories are all unknown.
        if (!cancelled) setConfirmed(null);
      }
      if (!cancelled) timer = setTimeout(() => void inspect(), 30_000);
    };
    void inspect();
    return () => { cancelled = true; clearTimeout(timer); finishPause?.(); };
  }, [auth.isSignedIn, token, organizationId, settings.baseUrl, input.scope, input.chatKey,
    input.missing, input.ready, modelKey, recovery?.previous.providerID, recovery?.previous.modelID]);

  const verified = Boolean(input.missing && input.ready && modelKey && confirmed?.modelKey === modelKey);
  return { confirmed: verified, assignedModels: verified ? confirmed?.assignedModels ?? EMPTY_MODELS : EMPTY_MODELS };
}
