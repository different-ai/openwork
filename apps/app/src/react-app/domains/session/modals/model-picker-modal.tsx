import { useEffect, useRef, useState } from "react";
import { ChevronRight, Cloud } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useIsMobile } from "@/hooks/use-mobile";
import { useSetWorkspaceDefaultModel } from "@/react-app/kernel/use-workspace-model-default";
import { ModelPickerList } from "@/react-app/domains/models/model-picker-list";
import { buildModelCatalog, resolveRetainedSelection, withoutBlockedSelection } from "@/react-app/domains/models/catalog";
import { useModelChoice } from "@/react-app/domains/models/use-model-catalog";
import { FAST_PRICING_WARNING, getModelBehaviorControls, getModelBehaviorSelection } from "@/app/lib/model-behavior";
import { readDenSettings } from "@/app/lib/den";
import { usePlatform } from "@/react-app/kernel/platform";
import { gatewayConnectCopy, gatewayConnectProviderKey, type GatewayConnectProvider } from "@/react-app/domains/connections/provider-auth/cloud-provider-config";
import { useCheckDesktopRestriction } from "../../cloud/desktop-config-provider";
import { useDenAuth } from "../../cloud/den-auth-provider";
import type { ModelOption, ModelRef } from "@/app/types";
import { AutoAccessFooter, openAutoProviderSettings } from "../../cloud/auto-access-ui";
import { isAutoModel, type ModelCatalogOption, type ModelPickerCatalogState, type RetainedModelSelection } from "@/react-app/domains/models/model-catalog";

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
  const titleRef = useRef<HTMLHeadingElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [advanced, setAdvanced] = useState(false);
  const platform = usePlatform();
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
  const behavior = getModelBehaviorSelection(selected?.behaviorOptions ?? [], props.currentBehaviorValue !== undefined ? props.currentBehaviorValue : selected?.behaviorValue ?? null);
  const controls = getModelBehaviorControls(behavior.options, behavior.value);
  const autoVisible = retained?.reason !== "policy" && retained?.reason !== "disabled" && (options.some(isAutoModel) || isAutoModel(props.current));
  useEffect(() => { if (props.open) { props.setQuery(""); setAdvanced(false); } }, [props.open]);
  const openSettings = () => { props.onClose({ restorePromptFocus: false }); (props.onOpenProviderSettings ?? openAutoProviderSettings)(); };
  // A provider sign-in opened from this dialog stays in front until it finishes or is cancelled.
  return <Dialog open={props.open} onOpenChange={(open) => { if (!open && !choice.loginOpen) props.onClose(); }}>
    <DialogContent initialFocus={() => isMobile ? titleRef.current : searchInputRef.current} aria-describedby={undefined} className="flex max-h-[calc(100dvh-2rem)] min-h-0 flex-col overflow-hidden rounded-2xl sm:max-w-90" data-testid="all-models-picker">
      <DialogHeader><DialogTitle ref={titleRef} tabIndex={-1}>Models</DialogTitle></DialogHeader>
      <ModelPickerList searchInputRef={searchInputRef} autoFocusSearch={false} options={options} current={props.current} query={props.query} onQueryChange={props.setQuery}
        catalogState={catalogState} retainedSelection={retained} onSetWorkspaceDefault={props.onSetWorkspaceDefault ?? setWorkspaceDefault} currentBehaviorValue={behavior.value}
        onConnectProvider={!restrictToCloud ? props.onOpenSettings : undefined} onOpenProviderSettings={!checkRestriction({ restriction: "allowControlSettings" }) ? openSettings : undefined}
        openWorkModelsSyncing={autoVisible && props.openWorkModelsSyncing} onReloadWorkspace={props.onReloadWorkspace} onRetryAuto={catalogState.onRetry}
        onSelect={(option) => choice.choose(option, () => props.onSelect({ providerID: option.providerID, modelID: option.modelID }))} />
      <details open={advanced} className="group/advanced border-t border-border" data-testid="current-model-settings">
        <summary onClick={(event) => { event.preventDefault(); setAdvanced((value) => !value); }} className="flex h-11 cursor-pointer list-none items-center gap-2 text-sm"><ChevronRight className="size-4 transition-transform group-open/advanced:rotate-90" />Advanced options</summary>
        {advanced ? <div className="pb-2 pl-6">
          {selected && !isAutoModel(selected) ? <>
            <div className="flex h-11 items-center justify-between text-sm"><span>Effort</span><span className="text-muted-foreground">{behavior.label}</span></div>
            <p role="status" className="pb-2 text-xs text-muted-foreground">{getModelBehaviorSelection(behavior.options, controls.fast ? controls.toggleValue ?? null : behavior.value).description}</p>
            <div role="group" aria-label="Thinking and effort" className="flex flex-wrap gap-1">{controls.options.map((option) => <Button key={option.value ?? "default"} size="sm" variant="ghost" aria-pressed={option.value === behavior.value} onClick={() => props.onBehaviorChange(props.current, option.value)}>{option.label}</Button>)}</div>
            {controls.hasFast ? <div className="flex h-11 items-center justify-between text-sm" title={FAST_PRICING_WARNING}><span>Fast mode</span><Switch aria-label="Fast mode" size="sm" checked={controls.fast} disabled={controls.toggleValue === undefined} onCheckedChange={() => { if (controls.toggleValue !== undefined) props.onBehaviorChange(props.current, controls.toggleValue); }} /></div> : null}
          </> : <p className="text-sm text-muted-foreground">{isAutoModel(props.current) ? "Auto manages its model settings." : "Choose an available model to change its settings."}</p>}
        </div> : null}
      </details>
      {props.gatewayConnectProviders?.filter((provider) => !provider.models?.length).map((provider) => <div key={gatewayConnectProviderKey(provider)} className="flex items-center gap-2 text-sm">
        <Cloud className="size-4" strokeWidth={1.5} /><span className="min-w-0 flex-1 truncate">{gatewayConnectCopy(provider.name)}</span>
        <Button size="sm" variant="ghost" disabled={!props.onConnectGatewayProvider || props.disabledProviders?.includes(provider.providerId)} onClick={() => void props.onConnectGatewayProvider?.(provider)}>Login</Button>
      </div>)}
      {!restrictToCloud ? <Button variant="ghost" size="sm" className="self-start" onClick={props.onOpenSettings}>Connect more providers</Button> : null}
      <AutoAccessFooter available={autoVisible} syncing={autoVisible && props.openWorkModelsSyncing} />
      <div className="flex items-center justify-end gap-2">
        {auth.isSignedIn ? <Button variant="ghost" size="sm" onClick={() => platform.openLink(new URL("/dashboard/model-connections", readDenSettings().baseUrl).toString())}>My Model Connections</Button> : null}
        <Button variant="ghost" size="sm" onClick={() => props.onClose()}>Done</Button>
      </div>
    </DialogContent>
  </Dialog>;
}
