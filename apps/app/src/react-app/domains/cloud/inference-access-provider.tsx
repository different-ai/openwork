import { createContext, use, useEffect, useRef, useState, type ReactNode } from "react";
import type { InferenceAccess } from "@openwork/types/den/inference";
import type { ModelRef } from "@/app/types";
import { createDenClient, readDenSettings } from "@/app/lib/den";
import { denSessionUpdatedEvent, denSettingsChangedEvent } from "@/app/lib/den-session-events";
import { newProvidersEvent } from "@/app/lib/provider-events";
import { allowanceResetLabel, formatAllowanceUsd, inferenceAccessRefreshEvent, modelSelectionUpgradeReason, pendingInferenceUsageLabel, type InferenceUpgradeReason } from "@/app/lib/inference-access";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { usePlatform } from "@/react-app/kernel/platform";
import { openModelPickerEvent } from "@/react-app/shell/new-providers-listener";
import { useDenAuth } from "./den-auth-provider";
import { getOpenWorkModelsActionUrl } from "./openwork-models-promo";

type Access = InferenceAccess & { canUpgrade: boolean };
type Upgrade = { reason: InferenceUpgradeReason; sessionId?: string };
const InferenceAccessContext = createContext<{
  access: Access | null;
  checkSelection: (model: ModelRef, sessionId?: string) => boolean;
  showUpgrade: (reason: InferenceUpgradeReason, sessionId?: string) => void;
}>({ access: null, checkSelection: () => true, showUpgrade: () => undefined });

export function useInferenceAccess() { return use(InferenceAccessContext); }

export function InferenceAccessProvider({ children }: { children: ReactNode }) {
  const auth = useDenAuth();
  const platform = usePlatform();
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{ scope: string; access: Access } | null>(null);
  const [upgrade, setUpgrade] = useState<Upgrade | null>(null);
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
      setRevision((value) => value + 1);
    };
    window.addEventListener(denSettingsChangedEvent, clear);
    window.addEventListener(denSessionUpdatedEvent, clear);
    return () => {
      window.removeEventListener(denSettingsChangedEvent, clear);
      window.removeEventListener(denSessionUpdatedEvent, clear);
    };
  }, []);

  useEffect(() => {
    const generation = ++epoch.current;
    setResult(null);
    setUpgrade(null);
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

  const showUpgrade = (reason: InferenceUpgradeReason, sessionId?: string) => {
    setUpgrade({ reason, sessionId });
    window.dispatchEvent(new Event(inferenceAccessRefreshEvent));
  };
  const checkSelection = (model: ModelRef, sessionId?: string) => {
    const reason = modelSelectionUpgradeReason(access, model);
    if (!reason) return true;
    showUpgrade(reason, sessionId);
    return false;
  };
  const reset = allowanceResetLabel(access?.resetsAt);
  return (
    <InferenceAccessContext value={{ access, checkSelection, showUpgrade }}>
      {children}
      <Dialog open={upgrade !== null} onOpenChange={(open) => { if (!open) setUpgrade(null); }}>
        <DialogContent className="sm:max-w-md" data-testid="inference-upgrade-dialog">
          <DialogHeader>
            <DialogTitle>{upgrade?.reason === "free_allowance_exhausted" ? "Your free Luna allowance is used up" : "This model requires OpenWork Models"}</DialogTitle>
            <DialogDescription>
              {upgrade?.reason === "free_allowance_exhausted"
                ? `You've used this week's free allowance.${reset ? ` Resets ${reset}.` : " Check your allowance again after the weekly reset."}`
                : "Free access includes standard Luna. Upgrade to use the other managed OpenWork models."}
              {" Your selected model and draft have not changed."}
            </DialogDescription>
          </DialogHeader>
          {access?.canUpgrade === false ? <p className="text-sm text-muted-foreground">Ask a workspace owner or admin to upgrade OpenWork Models. You can keep using your own providers.</p> : null}
          <DialogFooter className="flex-wrap">
            <Button variant="outline" onClick={() => {
              window.dispatchEvent(new CustomEvent(openModelPickerEvent, { detail: { sessionId: upgrade?.sessionId } }));
              setUpgrade(null);
            }}>Choose another provider</Button>
            {access?.canUpgrade === true ? <Button onClick={() => platform.openLink(getOpenWorkModelsActionUrl(true))}>Upgrade</Button> : null}
            <Button variant="ghost" onClick={() => setUpgrade(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </InferenceAccessContext>
  );
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

export function InferenceErrorActions({ reason, resetsAt, sessionId, onOpenModelPicker }: {
  reason: InferenceUpgradeReason; resetsAt?: string | null; sessionId?: string; onOpenModelPicker?: () => void;
}) {
  const { access, showUpgrade } = useInferenceAccess();
  const platform = usePlatform();
  const reset = allowanceResetLabel(resetsAt);
  return <div className="flex flex-col gap-2" data-testid="inference-error-actions">
    {reset && reason === "free_allowance_exhausted" ? <p className="text-sm">Allowance resets {reset}.</p> : null}
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" onClick={() => access?.canUpgrade === true
        ? platform.openLink(getOpenWorkModelsActionUrl(true)) : showUpgrade(reason, sessionId)}>
        {access?.canUpgrade === true ? "Upgrade" : access?.canUpgrade === false ? "Ask admin" : "View allowance"}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => onOpenModelPicker ? onOpenModelPicker()
        : window.dispatchEvent(new CustomEvent(openModelPickerEvent, { detail: { sessionId } }))}>Choose another provider</Button>
    </div>
  </div>;
}
