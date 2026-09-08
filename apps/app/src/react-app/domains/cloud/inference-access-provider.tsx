import { createContext, use, useEffect, useRef, useState, type ReactNode } from "react";
import type { InferenceAccess } from "@openwork/types/den/inference";
import type { ModelOption, ModelRef } from "@/app/types";
import { createDenClient, readDenSettings } from "@/app/lib/den";
import { denSessionUpdatedEvent, denSettingsChangedEvent } from "@/app/lib/den-session-events";
import { newProvidersEvent } from "@/app/lib/provider-events";
import { allowanceResetLabel, formatAllowanceUsd, inferenceAccessRefreshEvent, managedModelRecommendation, modelSelectionUpgradeReason, pendingInferenceUsageLabel, type InferenceUpgradeReason } from "@/app/lib/inference-access";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { usePlatform } from "@/react-app/kernel/platform";
import { openModelPickerEvent, openProviderAuthEvent } from "@/react-app/shell/new-providers-listener";
import { useDenAuth } from "./den-auth-provider";
import { useCheckDesktopRestriction } from "./desktop-config-provider";
import { getOpenWorkModelsActionUrl } from "./openwork-models-promo";

type Access = InferenceAccess & { canUpgrade: boolean };
type RequestedModel = ModelRef & { title?: string };
type PickerRequest = { model: RequestedModel; sessionId?: string; scope: string };
type Upgrade = {
  reason: InferenceUpgradeReason;
  sessionId?: string;
  model?: RequestedModel;
  currentModel?: ModelRef;
  freeModel?: ModelOption;
  scope: string;
};
const InferenceAccessContext = createContext<{
  access: Access | null;
  pickerRequest: PickerRequest | null;
  checkSelection: (model: RequestedModel, sessionId?: string, availableModels?: readonly ModelOption[], currentModel?: ModelRef) => boolean;
  showUpgrade: (reason: InferenceUpgradeReason, sessionId?: string, model?: RequestedModel, availableModels?: readonly ModelOption[], currentModel?: ModelRef) => void;
}>({ access: null, pickerRequest: null, checkSelection: () => true, showUpgrade: () => undefined });

export function useInferenceAccess() { return use(InferenceAccessContext); }

export function InferenceAccessProvider({ children }: { children: ReactNode }) {
  const auth = useDenAuth();
  const platform = usePlatform();
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{ scope: string; access: Access } | null>(null);
  const [upgrade, setUpgrade] = useState<Upgrade | null>(null);
  const [pickerRequest, setPickerRequest] = useState<PickerRequest | null>(null);
  const epoch = useRef(0);
  const settings = readDenSettings();
  const identity = auth.verifiedIdentity;
  const scope = auth.status === "signed_in" && identity && identity.organizationId === settings.activeOrgId
    ? JSON.stringify([settings.baseUrl, identity.principalId, identity.organizationId, revision]) : null;
  const access = scope && result?.scope === scope ? result.access : null;

  useEffect(() => {
    const clear = () => {
      epoch.current += 1;
      setResult(null);
      setUpgrade(null);
      setPickerRequest(null);
      setRevision((value) => value + 1);
    };
    window.addEventListener(denSettingsChangedEvent, clear);
    window.addEventListener(denSessionUpdatedEvent, clear);
    const clearRequest = () => { setUpgrade(null); setPickerRequest(null); };
    window.addEventListener("hashchange", clearRequest);
    return () => {
      window.removeEventListener(denSettingsChangedEvent, clear);
      window.removeEventListener(denSessionUpdatedEvent, clear);
      window.removeEventListener("hashchange", clearRequest);
    };
  }, []);

  useEffect(() => {
    const generation = ++epoch.current;
    setResult(null);
    setUpgrade(null);
    setPickerRequest(null);
    if (!scope) return;
    const captured = readDenSettings();
    const token = captured.authToken;
    const orgId = captured.activeOrgId;
    if (!token || !orgId) return;
    let running = false;
    let refreshAgain = false;
    let lastRead = 0;
    let pendingRefresh: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      if (document.visibilityState === "hidden") return;
      if (running) { refreshAgain = true; return; }
      // Coalesce completion/error/provider events without losing the final read.
      if (Date.now() - lastRead < 3_000) {
        pendingRefresh ??= setTimeout(() => { pendingRefresh = undefined; void refresh(); }, 3_000);
        return;
      }
      running = true;
      lastRead = Date.now();
      try {
        const next = await createDenClient({ baseUrl: captured.baseUrl, token }).getInferenceAccess(orgId);
        const current = readDenSettings();
        if (epoch.current === generation && current.authToken === token && current.activeOrgId === orgId && current.baseUrl === captured.baseUrl) {
          setResult({ scope, access: next });
        }
      } catch {
        if (epoch.current === generation) setResult(null);
      } finally {
        running = false;
        if (refreshAgain && epoch.current === generation) {
          refreshAgain = false;
          void refresh();
        }
      }
    };
    const onRefresh = () => { void refresh(); };
    void refresh();
    const timer = setInterval(onRefresh, 60_000);
    window.addEventListener("focus", onRefresh);
    document.addEventListener("visibilitychange", onRefresh);
    window.addEventListener(inferenceAccessRefreshEvent, onRefresh);
    window.addEventListener(newProvidersEvent, onRefresh);
    return () => {
      epoch.current += 1;
      clearInterval(timer);
      clearTimeout(pendingRefresh);
      window.removeEventListener("focus", onRefresh);
      document.removeEventListener("visibilitychange", onRefresh);
      window.removeEventListener(inferenceAccessRefreshEvent, onRefresh);
      window.removeEventListener(newProvidersEvent, onRefresh);
    };
  }, [scope]);

  const showUpgrade = (reason: InferenceUpgradeReason, sessionId?: string, model?: RequestedModel, availableModels?: readonly ModelOption[], currentModel?: ModelRef) => {
    if (!scope) return;
    const freeModel = availableModels?.find((option) => !option.disabled && option.providerID === "openwork" && option.modelID === access?.modelID);
    setUpgrade({ reason, sessionId, model, currentModel, freeModel, scope });
    setPickerRequest(null);
    window.dispatchEvent(new Event(inferenceAccessRefreshEvent));
  };
  const checkSelection = (model: RequestedModel, sessionId?: string, availableModels?: readonly ModelOption[], currentModel?: ModelRef) => {
    const reason = modelSelectionUpgradeReason(access, model);
    if (!reason) {
      if (pickerRequest) setPickerRequest(null);
      return true;
    }
    showUpgrade(reason, sessionId, model, availableModels, currentModel);
    return false;
  };
  const activeUpgrade = upgrade?.scope === scope ? upgrade : null;
  const recommendation = activeUpgrade?.model ? managedModelRecommendation(access, activeUpgrade.model) : undefined;
  const modelName = recommendation?.displayName ?? activeUpgrade?.model?.title ?? activeUpgrade?.model?.modelID;
  const eligible = Boolean(activeUpgrade?.model && access && (access.kind === "paid"
    || (access.kind === "free" && activeUpgrade.model.modelID === access.modelID)));
  const keepingLuna = access?.kind === "free" && activeUpgrade?.currentModel && activeUpgrade.freeModel
    && activeUpgrade.currentModel.providerID === activeUpgrade.freeModel.providerID
    && activeUpgrade.currentModel.modelID === activeUpgrade.freeModel.modelID;
  const openRequestedPicker = (model: RequestedModel) => {
    if (!scope || !activeUpgrade) return;
    // Re-enter the real picker, not a captured callback whose session may have changed.
    setPickerRequest({ model, sessionId: activeUpgrade.sessionId, scope });
    setUpgrade(null);
    window.dispatchEvent(new CustomEvent(openModelPickerEvent, { detail: { sessionId: activeUpgrade.sessionId } }));
  };
  const reset = allowanceResetLabel(access?.resetsAt);
  return (
    <InferenceAccessContext value={{ access, pickerRequest: pickerRequest?.scope === scope ? pickerRequest : null, checkSelection, showUpgrade }}>
      {children}
      <Dialog open={activeUpgrade !== null} onOpenChange={(open) => { if (!open) setUpgrade(null); }}>
        <DialogContent className="sm:max-w-md" data-testid="inference-upgrade-dialog">
          <DialogHeader>
            <DialogTitle>{eligible ? `${modelName} is ready to use` : activeUpgrade?.reason === "free_allowance_exhausted"
              ? "Your free Luna allowance is used up" : modelName ? `Unlock ${modelName}` : "Upgrade your model access"}</DialogTitle>
            <DialogDescription>
              {eligible ? "Return to the model picker to confirm your selection. No task will run automatically."
                : activeUpgrade?.reason === "free_allowance_exhausted"
                 ? `You've used this week's free allowance.${reset ? ` Resets ${reset}.` : " Check your allowance again after the weekly reset."}`
                 : recommendation?.summary || "This model is available with a paid OpenWork plan. Free access includes standard Luna."}
              {" Your selected model and draft have not changed."}
            </DialogDescription>
          </DialogHeader>
          {!eligible && activeUpgrade?.reason === "free_allowance_exhausted" ? <InferenceAllowanceSummary /> : null}
          {!eligible && recommendation?.capabilities.length ? <p className="text-xs text-muted-foreground">{recommendation.capabilities.join(" · ")}</p> : null}
          {!eligible && access?.plan ? <div className="rounded-lg border border-border p-3 text-sm" data-testid="inference-upgrade-plan">
            <p className="font-medium">{access.plan.name}{access.plan.priceLabel ? ` · ${access.plan.priceLabel}` : ""}</p>
            <p className="text-muted-foreground">{access.plan.usageLabel}</p>
            {!access.plan.priceLabel ? <p className="text-xs text-muted-foreground">View plans for pricing.</p> : null}
          </div> : !eligible ? <p className="text-sm text-muted-foreground">View plans for current pricing and usage limits.</p> : null}
          {!eligible && access?.canUpgrade === false ? <p className="text-sm text-muted-foreground" data-testid="inference-ask-admin">Ask a workspace owner or admin to upgrade OpenWork Models. Only they can manage the plan.</p> : null}
          <DialogFooter className="flex-wrap">
            <Button variant="ghost" onClick={() => setUpgrade(null)}>Close</Button>
            {!eligible && activeUpgrade?.currentModel ? <Button data-testid="inference-keep-current-model" variant="secondary" onClick={() => setUpgrade(null)}>
              {keepingLuna ? "Keep using Luna" : "Keep current model"}
            </Button> : null}
            {eligible && activeUpgrade?.model ? <Button data-testid="inference-use-model" onClick={() => {
              if (activeUpgrade.model) openRequestedPicker(activeUpgrade.model);
            }}>Use {modelName}</Button> : !eligible && access?.canUpgrade === true ? <Button data-testid="inference-view-upgrade" onClick={() => platform.openLink(getOpenWorkModelsActionUrl(true))}>View upgrade</Button> : null}
          </DialogFooter>
          <OwnProviderAction onBeforeOpen={() => setUpgrade(null)} />
        </DialogContent>
      </Dialog>
    </InferenceAccessContext>
  );
}

export function OwnProviderAction({ onBeforeOpen }: { onBeforeOpen?: () => void }) {
  const checkRestriction = useCheckDesktopRestriction();
  if (checkRestriction({ restriction: "allowCustomProviders" })) return null;
  return <button type="button" data-testid="model-own-provider" className="rounded-md px-2 py-1 text-left text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => {
    onBeforeOpen?.();
    const path = window.location.hash.replace(/^#/, "");
    if (path.includes("/settings/")) {
      const workspace = path.match(/^\/workspace\/[^/]+/);
      window.location.hash = `${workspace?.[0] ?? ""}/settings/ai`;
    } else {
      window.dispatchEvent(new Event(openProviderAuthEvent));
    }
  }}>Use my own provider…</button>;
}

export function InferenceAllowanceSummary({ available = true, className = "" }: { available?: boolean; className?: string }) {
  const { access } = useInferenceAccess();
  if (!available || !access || (access.kind !== "free" && access.kind !== "exhausted")) return null;
  const reset = allowanceResetLabel(access.resetsAt);
  const pending = pendingInferenceUsageLabel(access);
  return <p className={`text-xs text-muted-foreground ${className}`} data-testid="inference-allowance">
    Free standard Luna{access.remainingUsd !== null && access.weeklyLimitUsd !== null ? `: ${formatAllowanceUsd(access.remainingUsd)} of ${formatAllowanceUsd(access.weeklyLimitUsd)} left this week` : ""}.
    {reset ? ` Resets ${reset}.` : ""}
    {pending ? ` ${pending}` : ""}
  </p>;
}

export function InferenceErrorActions({ reason, resetsAt, sessionId, onOpenModelPicker, requestedModel }: {
  reason: InferenceUpgradeReason; resetsAt?: string | null; sessionId?: string; onOpenModelPicker?: () => void; requestedModel?: RequestedModel;
}) {
  const { access, showUpgrade } = useInferenceAccess();
  const reset = allowanceResetLabel(resetsAt);
  return <div className="flex flex-col gap-2" data-testid="inference-error-actions">
    {reset && reason === "free_allowance_exhausted" ? <p className="text-sm">Allowance resets {reset}.</p> : null}
    <div className="flex flex-wrap gap-2">
      <Button size="sm" onClick={() => showUpgrade(reason, sessionId, requestedModel)}>
        {access?.canUpgrade === true ? "View upgrade" : access?.canUpgrade === false ? "Ask admin" : "View allowance"}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => onOpenModelPicker ? onOpenModelPicker()
        : window.dispatchEvent(new CustomEvent(openModelPickerEvent, { detail: { sessionId } }))}>Change model</Button>
    </div>
  </div>;
}
