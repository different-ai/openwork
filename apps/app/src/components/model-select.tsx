"use client";

import * as React from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { useIsMobile } from "@/hooks/use-mobile";
import type { ModelOption, ModelRef } from "@/app/types";
import { getModelBehaviorControls, getModelBehaviorSelection } from "@/app/lib/model-behavior";
import { FAST_DEFAULT_VARIANT } from "@openwork/types/cloud-model-fast";
import { fastModeShortcutLabel } from "@/react-app/shell/fast-mode-shortcut";
import { resolveThinkingModeShortcutOs } from "@/react-app/shell/thinking-mode-shortcut";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ModelPickerList } from "@/react-app/domains/models/model-picker-list";
import { useModelCatalog, useModelChoice } from "@/react-app/domains/models/use-model-catalog";
import { useWorkspace } from "@/react-app/shell/workspace-provider";
import { useSetWorkspaceDefaultModel } from "@/react-app/kernel/use-workspace-model-default";
import { useCheckDesktopRestriction } from "@/react-app/domains/cloud/desktop-config-provider";
import { AutoAccessFooter, openAutoProviderSettings } from "@/react-app/domains/cloud/auto-access-ui";
import { openModelPickerEvent, openProviderAuthEvent } from "@/react-app/shell/new-providers-listener";
import { openComposerModelPickerEvent } from "@/app/lib/inference-access";
import { isAutoModel, nonDefaultModelSummary, type RetainedModelSelection } from "@/react-app/domains/models/model-catalog";
import { useModelPickerCatalogStore } from "@/react-app/domains/session/models/model-collections-store";

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
  const [query, setQuery] = React.useState("");
  const [advanced, setAdvanced] = React.useState(false);
  const [effort, setEffort] = React.useState(false);
  const [focusAlternative, setFocusAlternative] = React.useState(false);
  const isMobile = useIsMobile();
  const popupRef = React.useRef<HTMLDivElement>(null);
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  const effortButtonRef = React.useRef<HTMLButtonElement>(null);
  const backButtonRef = React.useRef<HTMLButtonElement>(null);
  const previousEffort = React.useRef(effort);
  React.useLayoutEffect(() => {
    const previous = previousEffort.current;
    previousEffort.current = effort;
    if (!open || previous === effort) return;
    (effort ? backButtonRef.current : effortButtonRef.current)?.focus({ preventScroll: true });
  }, [effort, open]);
  const workspace = useWorkspace();
  const setWorkspaceDefault = useSetWorkspaceDefaultModel();
  const checkRestriction = useCheckDesktopRestriction();
  const choice = useModelChoice(JSON.stringify([sessionId, value, behaviorValue, disabled]));
  const catalog = useModelCatalog({ client: workspace.client, baseUrl: workspace.opencodeBaseUrl, directory: workspace.selectedWorkspaceRoot,
    enabled: true, refreshWhen: open, fallbackOptions, pendingOptions: choice.pendingOptions, disabledProviders: choice.disabledProviders,
    current: value, savedSelection, sessionScoped: Boolean(sessionId), openWorkModelsSyncing });
  const { options, catalogState, retainedSelection, restrictToCloud, autoVisible } = catalog;
  React.useEffect(() => {
    const recover = (event: Event) => {
      if (!(event instanceof CustomEvent) || event.detail?.sessionId !== sessionId) return;
      setQuery(""); setAdvanced(false); setEffort(false); setFocusAlternative(true); onOpenChange(true);
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
  const selectedBehavior = getModelBehaviorSelection(selected?.behaviorOptions ?? behaviorOptions, behaviorValue);
  const controls = getModelBehaviorControls(selectedBehavior.options, selectedBehavior.value);
  const hasEffort = behaviorValue !== null || (selected?.behaviorOptions ?? behaviorOptions).some((option) => option.value !== null);
  // Fast shows on its own as a quiet "· Fast" after the model name; the effort beside it is the base level ("High", not "High + Fast").
  const fastOn = controls.fast && !isAutoModel(value);
  const summary = fastOn
    ? (behaviorValue === FAST_DEFAULT_VARIANT ? null : controls.options.find((option) => option.value === behaviorValue)?.label ?? null)
    : nonDefaultModelSummary(value, behaviorValue, selectedBehavior.label);
  const fastShortcutLabel = fastModeShortcutLabel(resolveThinkingModeShortcutOs(undefined, typeof navigator === "undefined" ? "" : navigator.platform));
  const select = (option: ModelOption) => choice.choose(option, () => {
    onChange({ providerID: option.providerID, modelID: option.modelID });
    onOpenChange(false);
  });
  const openProvider = () => { setQuery(""); setAdvanced(false); setEffort(false); onOpenChange(false); window.dispatchEvent(new Event(openProviderAuthEvent)); };
  const openSettings = () => { onOpenChange(false); openAutoProviderSettings(); };
  return <Popover open={open} onOpenChange={(next) => {
    // A provider sign-in opened from this picker owns focus until it finishes or is cancelled.
    if (!next && choice.loginOpen) return;
    setQuery(""); setAdvanced(false); setEffort(false); setFocusAlternative(false); onOpenChange(next);
  }}>
    <PopoverTrigger type="button" disabled={disabled} aria-label="Change model"
      className="inline-flex h-9 min-w-0 items-center gap-1.5 px-2.5 text-sm text-muted-foreground hover:text-foreground focus-visible:rounded focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
      <span className="max-w-56 truncate">{hideValue ? "Select model" : isAutoModel(value) ? "Auto" : catalog.currentOption?.title || "Select model"}{!hideValue && summary ? ` · ${summary}` : ""}</span>{!hideValue && fastOn ? <span data-testid="model-fast-indicator" className="shrink-0 text-xs font-medium">· Fast</span> : null}<ChevronDown className="size-3" />
    </PopoverTrigger>
    <PopoverContent ref={popupRef} tabIndex={-1} align="start" initialFocus={() => isMobile || focusAlternative ? popupRef.current : searchInputRef.current} data-testid="composer-model-picker" className="flex max-h-[min(var(--available-height),36rem)] w-90 max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-2xl p-0">
      {effort && selected ? <div data-slot="model-thinking-submenu" className="overflow-y-auto p-2">
        <Button ref={backButtonRef} variant="ghost" size="sm" onClick={() => setEffort(false)}><ChevronLeft className="size-4" />Back to models</Button>
        <p role="status" className="px-2 py-2 text-xs text-muted-foreground">{getModelBehaviorSelection(selectedBehavior.options, controls.fast ? controls.toggleValue ?? null : behaviorValue).description}</p>
        {controls.options.map((option) => <Button key={option.value ?? "default"} variant="ghost" className="h-11 w-full justify-between" aria-pressed={option.value === behaviorValue} onClick={() => { onBehaviorChange?.(option.value); setEffort(false); }}>
          {option.label}{option.value === behaviorValue ? <Check className="size-4" /> : null}
        </Button>)}
      </div> : <ModelPickerList searchInputRef={searchInputRef} autoFocusSearch={false} options={options} current={value} query={query} onQueryChange={setQuery} onSelect={select}
        focusAlternative={focusAlternative} catalogState={catalogState} retainedSelection={retainedSelection} onConnectProvider={!restrictToCloud ? openProvider : undefined}
        onOpenProviderSettings={!checkRestriction({ restriction: "allowControlSettings" }) ? openSettings : undefined}
        onSetWorkspaceDefault={onSetWorkspaceDefault ?? setWorkspaceDefault} currentBehaviorValue={behaviorValue} openWorkModelsSyncing={autoVisible && openWorkModelsSyncing} onReloadWorkspace={onReloadWorkspace} onRetryAuto={catalogState.onRetry} footer={<>
        <details open={advanced} className="group/advanced border-t border-border" data-testid="model-advanced-options">
          <summary onClick={(event) => { event.preventDefault(); setAdvanced((value) => !value); }} className="flex h-11 cursor-pointer list-none items-center gap-2 px-4 text-sm focus-visible:ring-2 focus-visible:ring-ring"><ChevronRight className="size-4 transition-transform group-open/advanced:rotate-90" />Advanced options</summary>
          {advanced ? <div className="px-3 pb-2">
            {selected && onBehaviorChange && !isAutoModel(selected) ? <>
              <Button ref={effortButtonRef} data-testid="model-effort" size="sm" variant="ghost" className="h-11 w-full justify-between" disabled={!hasEffort} onClick={() => setEffort(true)}>Effort<span className="text-muted-foreground">{hasEffort ? controls.options.find((option) => option.value === behaviorValue)?.label ?? selectedBehavior.label : "Unavailable"}</span></Button>
              {controls.hasFast ? <div className="flex h-11 items-center justify-between px-2 text-sm"><span className="flex items-center gap-2">Fast mode<kbd className="hidden rounded border border-border/70 bg-muted/40 px-1.5 py-0.5 font-sans text-[10px] leading-none text-muted-foreground sm:inline-flex">{fastShortcutLabel}</kbd></span><Switch aria-label="Fast mode" size="sm" checked={controls.fast} disabled={controls.toggleValue === undefined} onCheckedChange={() => { if (controls.toggleValue !== undefined) onBehaviorChange(controls.toggleValue); }} /></div> : null}
            </> : <p className="px-2 py-2 text-sm text-muted-foreground">{isAutoModel(value) ? "Auto manages its model settings." : "Choose an available model to change its settings."}</p>}
          </div> : null}
        </details>
        <div className="flex items-center justify-between border-t border-border px-2 py-1">
          {!restrictToCloud ? <Button variant="ghost" size="sm" className="h-9" onClick={openProvider}>Connect more providers</Button> : <span />}
          <Button variant="ghost" size="sm" className="h-9" onClick={() => { onOpenChange(false); window.dispatchEvent(new CustomEvent(openModelPickerEvent, { detail: { sessionId } })); }}>All models</Button>
        </div>
        <AutoAccessFooter available={autoVisible} syncing={autoVisible && openWorkModelsSyncing} />
      </>} />}
    </PopoverContent>
  </Popover>;
}
