import { X } from "lucide-react";
import { useEffect } from "react";
import { createDenClient, readDenSettings } from "@/app/lib/den";
import type { ModelRef } from "@/app/types";
import { Button } from "@/components/ui/button";
import { modelTitle } from "@/react-app/domains/models/model-catalog";
import { modelRecoveryChatKey, useModelRecoveryStore } from "../model-recovery-store";

export function ModelRecoveryNote(props: {
  scope?: string;
  sessionId?: string;
  selectedModel: ModelRef;
  onChange: () => void;
  onSwitchBack: (model: ModelRef) => void;
}) {
  const chatKey = modelRecoveryChatKey(props.scope ?? "", props.sessionId);
  const recovery = useModelRecoveryStore((state) => state.byChat[chatKey]);
  const settings = readDenSettings();
  const token = settings.authToken?.trim() ?? "";
  const organizationId = settings.activeOrgId?.trim() ?? "";
  const previousProvider = recovery?.previous.providerID;
  const previousModel = recovery?.previous.modelID;
  // Each visible composer owns return monitoring, including an alternate-workspace
  // pane. A dismissed note can reappear only after a verified usable return.
  useEffect(() => {
    if (!props.scope || !previousProvider || !previousModel || !token || !organizationId) return;
    const client = createDenClient({ baseUrl: settings.baseUrl, token, requireCompleteInventory: true });
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const inspect = async () => {
      try {
        const inventory = await client.getModelRemovalInventory(organizationId);
        if (cancelled) return;
        const same = (model: ModelRef) => model.providerID === previousProvider && model.modelID === previousModel;
        useModelRecoveryStore.getState().markReturned(chatKey,
          inventory.models.some(same) && !inventory.lockedModels.some(same));
      } catch { /* Unverifiable is not a newly removed or restored assignment. */ }
      if (!cancelled) timer = setTimeout(() => void inspect(), 30_000);
    };
    void inspect();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [props.scope, previousProvider, previousModel, token, organizationId, settings.baseUrl, chatKey]);
  if (!props.scope || !recovery || recovery.dismissed
    || recovery.replacement.providerID !== props.selectedModel.providerID
    || recovery.replacement.modelID !== props.selectedModel.modelID) return null;
  return (
    <div data-testid="model-recovery-note" role="status" className="mt-2 flex flex-wrap items-center gap-x-1 text-xs text-muted-foreground">
      <span>{modelTitle(recovery.previous)} {recovery.returned ? "is available again" : "was removed by your organization"} · Using {modelTitle(recovery.replacement)} ·</span>
      <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={props.onChange}>Change</Button>
      {recovery.returned ? <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => {
        props.onSwitchBack(recovery.previous);
        useModelRecoveryStore.getState().clear(chatKey);
      }}>Switch back</Button> : null}
      <Button variant="ghost" size="icon" className="ml-auto size-6" aria-label="Dismiss model change" onClick={() => useModelRecoveryStore.getState().dismiss(chatKey)}>
        <X className="size-3.5" aria-hidden="true" />
      </Button>
    </div>
  );
}
