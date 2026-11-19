import { useEffect, useRef } from "react";
import { Cloud } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/hooks/use-mobile";
import { useSetWorkspaceDefaultModel } from "@/react-app/kernel/use-workspace-model-default";
import { ModelPickerPanel } from "@/react-app/domains/models/model-picker-panel";
import { buildModelCatalog, resolveRetainedSelection, withoutBlockedSelection } from "@/react-app/domains/models/catalog";
import { useModelChoice } from "@/react-app/domains/models/use-model-catalog";
import { gatewayConnectCopy, gatewayConnectProviderKey, type GatewayConnectProvider } from "@/react-app/domains/connections/provider-auth/cloud-provider-config";
import { useCheckDesktopRestriction } from "../../cloud/desktop-config-provider";
import { useDenAuth } from "../../cloud/den-auth-provider";
import type { ModelOption, ModelRef } from "@/app/types";
import { openAutoProviderSettings } from "../../cloud/auto-access-ui";
import { isAutoModel, managesOwnBehavior, type ModelCatalogOption, type ModelPickerCatalogState, type RetainedModelSelection } from "@/react-app/domains/models/model-catalog";

export const MODEL_PICKER_DEFAULT_SUBTITLE = "Select a model for this session.";
export const MODEL_PICKER_UNAVAILABLE_SUBTITLE = "The model you were using is no longer available, please select a different model for this session.";
export function resolveModelPickerSubtitle(subtitle: string | undefined) { return subtitle ?? MODEL_PICKER_DEFAULT_SUBTITLE; }

export type ModelPickerModalProps = {
  open: boolean;
  /** What to list: the shared catalog's options for this surface. */
  options: readonly ModelCatalogOption[];
  /** Everything the person could have chosen, disabled rows included; names a saved choice that is not listed. */
  knownOptions?: readonly ModelCatalogOption[];
  disabledProviders?: string[];
  organizationModelsEmpty?: boolean;
  organizationModelsSettingsUrl?: string;
  query: string;
  setQuery: (value: string) => void;
  subtitle?: string;
  target: "default" | "session";
  current: ModelRef;
  currentBehaviorValue?: string | null;
  onSelect: (model: ModelRef) => void;
  onBehaviorChange: (model: ModelRef, value: string | null) => void;
  onToggleProvider?: (providerId: string, enabled: boolean) => void;
  onOpenSettings: () => void;
  onClose: (options?: { restorePromptFocus?: boolean }) => void;
  openWorkModelsEntitled?: boolean;
  openWorkModelsSyncing?: boolean;
  onRefreshOrganizationModels?: () => void | Promise<void>;
  restrictToCloud?: boolean;
  gatewayProviderIds?: ReadonlySet<string>;
  gatewayConnectProviders?: GatewayConnectProvider[];
  onConnectGatewayProvider?: (provider: GatewayConnectProvider) => void | Promise<void>;
  catalogState?: ModelPickerCatalogState;
  retainedSelection?: RetainedModelSelection;
  onSetWorkspaceDefault?: (model: ModelRef, variant?: string | null) => void | boolean | Promise<void | boolean>;
  onOpenProviderSettings?: () => void;
  onReloadWorkspace?: () => void | Promise<unknown>;
};

export type ModelPickerEmptyState = { messageKey: string; showConnectProvider: boolean; showRefreshOrganizationModels: boolean; showOrganizationModelsSettings: boolean };
export function resolveModelPickerEmptyState(input: { providerGroupCount: number; query: string; organizationModelsEmpty: boolean; restrictToCloud: boolean; organizationModelsSettingsUrl?: string }): ModelPickerEmptyState | null {
  if (input.providerGroupCount > 0) return null;
  return { messageKey: input.query.trim() ? "models.no_models_match_search" : input.organizationModelsEmpty ? "models.organization_models_empty" : "models.no_models_available",
    showConnectProvider: !input.query.trim() && !input.organizationModelsEmpty && !input.restrictToCloud,
    showRefreshOrganizationModels: !input.query.trim() && input.organizationModelsEmpty,
    showOrganizationModelsSettings: !input.query.trim() && input.organizationModelsEmpty && Boolean(input.organizationModelsSettingsUrl) };
}

export function ModelPickerModal(props: ModelPickerModalProps) {
  const isMobile = useIsMobile();
  const setWorkspaceDefault = useSetWorkspaceDefaultModel();
  const checkRestriction = useCheckDesktopRestriction();
  const auth = useDenAuth();
  const popupRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const choice = useModelChoice(JSON.stringify([props.open, props.current, props.currentBehaviorValue]));
  const restrictToCloud = props.restrictToCloud || checkRestriction({ restriction: "allowCustomProviders" });
  const catalogState = props.catalogState ?? { state: "ready", onRetry: props.onRefreshOrganizationModels } satisfies ModelPickerCatalogState;
  // Callers pass the shared catalog; applying the same pipeline here keeps the dialog correct for any caller
  // (it is idempotent) and applies this dialog's own policy, disabled-provider and gateway inputs.
  const catalog = buildModelCatalog({ runtime: [...(props.knownOptions ?? props.options)], signedIn: auth.isSignedIn, restrictToCloud, checkRestriction,
    disabledProviders: props.disabledProviders, gatewayProviderIds: props.gatewayProviderIds });
  const retained = resolveRetainedSelection({ current: props.current, catalog, saved: props.retainedSelection, signedIn: auth.isSignedIn,
    restrictToCloud, checkRestriction, catalogState: catalogState.state, sessionScoped: props.target === "session" });
  const options = withoutBlockedSelection(catalog.options, retained);
  const selected = options.find((option) => option.providerID === props.current.providerID && option.modelID === props.current.modelID && !option.disabled);
  const behaviorValue = props.currentBehaviorValue !== undefined ? props.currentBehaviorValue : selected?.behaviorValue ?? null;
  const autoVisible = retained?.reason !== "policy" && retained?.reason !== "disabled" && (options.some(isAutoModel) || isAutoModel(props.current));
  useEffect(() => { if (props.open) props.setQuery(""); }, [props.open]);
  const openSettings = () => { props.onClose({ restorePromptFocus: false }); (props.onOpenProviderSettings ?? openAutoProviderSettings)(); };
  const pendingProviders = props.gatewayConnectProviders?.filter((provider) => !provider.models?.length) ?? [];
  // The same panel as the composer's picker, in a dialog for surfaces without a composer.
  return <Dialog open={props.open} onOpenChange={(open) => { if (!open && !choice.loginOpen) props.onClose(); }}>
    <DialogContent ref={popupRef} showCloseButton={false} initialFocus={() => isMobile ? popupRef.current : searchInputRef.current} aria-describedby={undefined}
      className="flex max-h-[min(calc(100dvh-2rem),36rem)] min-h-0 w-90 max-w-[calc(100vw-2rem)] flex-col gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-90 lg:w-90 lg:max-w-90 lg:rounded-2xl" data-testid="all-models-picker">
      <DialogTitle className="sr-only">Models</DialogTitle>
      <ModelPickerPanel searchInputRef={searchInputRef} options={options} current={props.current} behaviorValue={behaviorValue}
        onSelect={(option, behavior) => choice.choose(option, () => {
          props.onSelect({ providerID: option.providerID, modelID: option.modelID });
          if (behavior && !managesOwnBehavior(option)) props.onBehaviorChange({ providerID: option.providerID, modelID: option.modelID }, behavior.variant);
        })}
        onBehaviorChange={(value) => props.onBehaviorChange(props.current, value)}
        catalogState={catalogState} retainedSelection={retained}
        onConnectProvider={!restrictToCloud ? props.onOpenSettings : undefined}
        onOpenProviderSettings={!checkRestriction({ restriction: "allowControlSettings" }) ? openSettings : undefined}
        onSetWorkspaceDefault={props.onSetWorkspaceDefault ?? setWorkspaceDefault}
        openWorkModelsSyncing={props.openWorkModelsSyncing} autoVisible={autoVisible} onReloadWorkspace={props.onReloadWorkspace}
        footerExtra={pendingProviders.length ? <div className="border-t border-border p-1.5">{pendingProviders.map((provider) => <div key={gatewayConnectProviderKey(provider)} className="flex h-9 items-center gap-2.5 px-2 text-sm">
          <Cloud className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} /><span className="min-w-0 flex-1 truncate">{gatewayConnectCopy(provider.name)}</span>
          <Button size="sm" variant="ghost" disabled={!props.onConnectGatewayProvider || props.disabledProviders?.includes(provider.providerId)} onClick={() => void props.onConnectGatewayProvider?.(provider)}>Login</Button>
        </div>)}</div> : null} />
    </DialogContent>
  </Dialog>;
}
