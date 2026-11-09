"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";
import { useIsMobile } from "@/hooks/use-mobile";
import type { ModelOption, ModelRef } from "@/app/types";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ModelPickerPanel } from "@/react-app/domains/models/model-picker-panel";
import { useModelCatalog, useModelChoice } from "@/react-app/domains/models/use-model-catalog";
import { useWorkspace } from "@/react-app/shell/workspace-provider";
import { useSetWorkspaceDefaultModel } from "@/react-app/kernel/use-workspace-model-default";
import { useCheckDesktopRestriction } from "@/react-app/domains/cloud/desktop-config-provider";
import { openAutoProviderSettings } from "@/react-app/domains/cloud/auto-access-ui";
import { openProviderAuthEvent } from "@/react-app/shell/new-providers-listener";
import { openComposerModelPickerEvent } from "@/app/lib/inference-access";
import { fixedModelTitle, managesOwnBehavior, modelTitle, modelTriggerSettings, type RetainedModelSelection } from "@/react-app/domains/models/model-catalog";
import { useModelPickerCatalogStore } from "@/react-app/domains/session/models/model-collections-store";
import { useDesktopFeature } from "@/react-app/domains/session/status/use-desktop-feature";

export { ModelPickerFooter } from "@/react-app/domains/models/model-picker-panel";

interface ModelSelectProps {
  open: boolean;
  value: ModelRef;
  hideValue?: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (model: ModelRef, variant?: string | null) => void;
  disabled?: boolean;
  sessionId?: string;
  openWorkModelsEntitled?: boolean;
  openWorkModelsSyncing?: boolean;
  fallbackOptions?: readonly ModelOption[];
  behaviorValue?: string | null;
  behaviorLabel?: string;
  behaviorOptions?: { value: string | null; label: string }[];
  onBehaviorChange?: (value: string | null) => void;
  onSetWorkspaceDefault?: (model: ModelRef, variant?: string | null) => void | boolean | Promise<void | boolean>;
  onReloadWorkspace?: () => void | Promise<unknown>;
  retainedSelection?: RetainedModelSelection;
}

export function ModelSelect({ open, value, hideValue = false, onOpenChange, onChange, disabled = false, sessionId,
  openWorkModelsSyncing = false, fallbackOptions = [], behaviorValue = null, behaviorOptions = [], onBehaviorChange, onSetWorkspaceDefault, onReloadWorkspace, retainedSelection: savedSelection }: ModelSelectProps) {
  const [focusAlternative, setFocusAlternative] = React.useState(false);
  const isMobile = useIsMobile();
  const popupRef = React.useRef<HTMLDivElement>(null);
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  const workspace = useWorkspace();
  const setWorkspaceDefault = useSetWorkspaceDefaultModel();
  const checkRestriction = useCheckDesktopRestriction();
  const plainFreeModel = useDesktopFeature("plainFreeModel");
  const choice = useModelChoice(JSON.stringify([sessionId, value, behaviorValue, disabled]));
  const catalog = useModelCatalog({ client: workspace.client, baseUrl: workspace.opencodeBaseUrl, directory: workspace.selectedWorkspaceRoot,
    enabled: true, refreshWhen: open, fallbackOptions, pendingOptions: choice.pendingOptions, disabledProviders: choice.disabledProviders,
    current: value, savedSelection, sessionScoped: Boolean(sessionId), openWorkModelsSyncing });
  const { options, catalogState, retainedSelection, restrictToCloud, autoVisible } = catalog;
  React.useEffect(() => {
    const recover = (event: Event) => {
      // The New Task composer has no session; its requests carry none either.
      if (!(event instanceof CustomEvent) || (event.detail?.sessionId || undefined) !== (sessionId || undefined)) return;
      setFocusAlternative(event.detail?.focusAlternative !== false); onOpenChange(true);
    };
    window.addEventListener(openComposerModelPickerEvent, recover);
    return () => window.removeEventListener(openComposerModelPickerEvent, recover);
  }, [sessionId, onOpenChange]);
  // The palette and shortcuts for this conversation switch among exactly these models.
  const catalogOwner = React.useRef(Symbol());
  React.useLayoutEffect(() => {
    if (sessionId) useModelPickerCatalogStore.getState().publish(sessionId, catalogOwner.current, catalog.actionOptions);
  }, [sessionId, catalog.actionOptions]);
  React.useEffect(() => {
    const owner = catalogOwner.current;
    return () => { if (sessionId) useModelPickerCatalogStore.getState().release(sessionId, owner); };
  }, [sessionId]);
  const selected = options.find((option) => option.providerID === value.providerID && option.modelID === value.modelID);
  const name = hideValue ? undefined : fixedModelTitle(value, { plainFreeModel }) ?? (catalog.currentOption ? modelTitle(catalog.currentOption, { plainFreeModel }) : undefined);
  // Fast shows on its own as a quiet "· Fast" after the model name. Nothing follows "Select model", and a
  // setting the list does not show is only called out once the list is the engine's answer for a verified sign-in.
  const { summary, fast: fastOn } = modelTriggerSettings({ model: value, named: name !== undefined,
    verified: catalogState.state === "ready" && !catalog.restoring,
    options: selected?.behaviorOptions ?? catalog.currentOption?.behaviorOptions ?? behaviorOptions, value: behaviorValue });
  const select = (option: ModelOption, behavior?: { variant: string | null }) => choice.choose(option, () => {
    onChange({ providerID: option.providerID, modelID: option.modelID }, behavior?.variant);
    // Setting the model keeps the variant when the model is unchanged, so apply it directly too.
    if (behavior && !managesOwnBehavior(option)) onBehaviorChange?.(behavior.variant);
    onOpenChange(false);
  });
  const openProvider = () => { onOpenChange(false); window.dispatchEvent(new Event(openProviderAuthEvent)); };
  const openSettings = () => { onOpenChange(false); openAutoProviderSettings(); };
  return <Popover open={open} onOpenChange={(next) => {
    // A provider sign-in opened from this picker owns focus until it finishes or is cancelled.
    if (!next && choice.loginOpen) return;
    setFocusAlternative(false); onOpenChange(next);
  }}>
    <PopoverTrigger type="button" disabled={disabled} aria-label="Change model"
      className="inline-flex h-9 min-w-0 items-center gap-1.5 px-2.5 text-sm text-muted-foreground hover:text-foreground focus-visible:rounded focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
      <span className="max-w-56 truncate">{name ?? "Select model"}{summary ? ` · ${summary}` : ""}{fastOn ? <span data-testid="model-fast-indicator" className="text-xs font-medium"> · Fast</span> : null}</span><ChevronDown className="size-3" />
    </PopoverTrigger>
    <PopoverContent ref={popupRef} tabIndex={-1} align="start" initialFocus={() => isMobile || focusAlternative ? popupRef.current : searchInputRef.current} data-testid="composer-model-picker" className="flex max-h-[min(var(--available-height),36rem)] w-90 max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-2xl p-0">
      <ModelPickerPanel searchInputRef={searchInputRef} options={options} current={value} behaviorValue={behaviorValue} fallbackBehaviorOptions={behaviorOptions}
        onSelect={select} onBehaviorChange={onBehaviorChange} focusAlternative={focusAlternative} catalogState={catalogState} retainedSelection={retainedSelection}
        onConnectProvider={!restrictToCloud ? openProvider : undefined} onOpenProviderSettings={!checkRestriction({ restriction: "allowControlSettings" }) ? openSettings : undefined}
        onSetWorkspaceDefault={onSetWorkspaceDefault ?? setWorkspaceDefault} openWorkModelsSyncing={openWorkModelsSyncing} autoVisible={autoVisible} onReloadWorkspace={onReloadWorkspace} />
    </PopoverContent>
  </Popover>;
}
