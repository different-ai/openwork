import * as React from "react";
import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import type { ModelOption, ModelRef } from "@/app/types";
import { FAST_PRICING_WARNING, getModelBehaviorControls, getModelBehaviorSelection } from "@/app/lib/model-behavior";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { fastModeShortcutLabel } from "@/react-app/shell/fast-mode-shortcut";
import { resolveThinkingModeShortcutOs, thinkingModeShortcutLabel } from "@/react-app/shell/thinking-mode-shortcut";
import { AutoAccessFooter } from "@/react-app/domains/cloud/auto-access-ui";
import { ModelPickerList } from "./model-picker-list";
import { isAutoRouterModel, managesOwnBehavior, type ModelPickerCatalogState, type RetainedModelSelection } from "./model-catalog";

const chordClass = "hidden shrink-0 rounded border border-border/70 bg-muted/40 px-1.5 py-0.5 font-sans text-xs leading-none text-muted-foreground sm:inline-flex";

/** The picker's settings for the current model and its way out, under one hairline. */
export function ModelPickerFooter({ effortButtonRef, effortLabel, effortShortcut, canChangeEffort, onOpenEffort, fast, onConnectProvider }: {
  effortButtonRef?: React.Ref<HTMLButtonElement>;
  effortLabel: string;
  effortShortcut: string;
  canChangeEffort: boolean;
  onOpenEffort: () => void;
  fast?: { on: boolean; shortcut: string; disabled: boolean; onToggle: () => void };
  onConnectProvider?: () => void;
}) {
  return <div className="border-t border-border p-1.5" data-testid="model-behavior-rows">
    <button ref={effortButtonRef} type="button" data-testid="model-effort" disabled={!canChangeEffort} onClick={onOpenEffort}
      className="flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 text-left text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:hover:bg-transparent">
      <span className="min-w-0 flex-1">Effort</span>
      <span className="max-w-32 truncate text-muted-foreground">{effortLabel}</span>
      <kbd className={chordClass}>{effortShortcut}</kbd>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
    </button>
    {fast ? <div className="flex h-9 items-center gap-2.5 px-2 text-sm" title={FAST_PRICING_WARNING}>
      <span className="min-w-0 flex-1">Fast mode</span>
      <kbd className={chordClass}>{fast.shortcut}</kbd>
      <Switch aria-label="Fast mode" size="sm" checked={fast.on} disabled={fast.disabled} onCheckedChange={fast.onToggle} />
    </div> : null}
    {/* The list above already holds every model; there is no second, larger picker. */}
    {onConnectProvider ? <div className="flex items-center pt-0.5">
      <Button variant="ghost" size="sm" className="h-8 px-2 font-normal text-muted-foreground" onClick={onConnectProvider}>Connect more providers</Button>
    </div> : null}
  </div>;
}

export type ModelPickerPanelProps = {
  /** Selectable models, from the shared catalog. */
  options: readonly ModelOption[];
  current: ModelRef;
  /** Effort/Fast variant applied to `current`. */
  behaviorValue: string | null;
  /** Used when `current` is not in `options` (e.g. still loading). */
  fallbackBehaviorOptions?: readonly { value: string | null; label: string }[];
  /** `behavior.variant` is set when the search named an option such as "fast" or "high". */
  onSelect: (option: ModelOption, behavior?: { variant: string | null }) => void;
  /** Omit where effort cannot be changed. */
  onBehaviorChange?: (value: string | null) => void;
  catalogState: ModelPickerCatalogState;
  retainedSelection?: RetainedModelSelection;
  focusAlternative?: boolean;
  searchInputRef?: React.Ref<HTMLInputElement>;
  onConnectProvider?: () => void;
  onOpenProviderSettings?: () => void;
  onSetWorkspaceDefault?: (model: ModelRef, variant?: string | null) => void | boolean | Promise<void | boolean>;
  openWorkModelsSyncing?: boolean;
  autoVisible: boolean;
  onReloadWorkspace?: () => void | Promise<unknown>;
  /** Rows under the footer that only one surface offers. */
  footerExtra?: React.ReactNode;
};

/**
 * The one model picker body: search, the model list, the current model's
 * effort (as a submenu) and Fast mode. The composer shows it in a popover;
 * surfaces without a composer show the same panel in a dialog.
 */
export function ModelPickerPanel(props: ModelPickerPanelProps) {
  const { options, current, behaviorValue, onBehaviorChange } = props;
  const [query, setQuery] = React.useState("");
  const [effort, setEffort] = React.useState(false);
  const effortButtonRef = React.useRef<HTMLButtonElement>(null);
  const backButtonRef = React.useRef<HTMLButtonElement>(null);
  const previousEffort = React.useRef(effort);
  React.useLayoutEffect(() => {
    const previous = previousEffort.current;
    previousEffort.current = effort;
    if (previous === effort) return;
    (effort ? backButtonRef.current : effortButtonRef.current)?.focus({ preventScroll: true });
  }, [effort]);
  const selected = options.find((option) => option.providerID === current.providerID && option.modelID === current.modelID && !option.disabled);
  const behaviorOptions = selected?.behaviorOptions ?? props.fallbackBehaviorOptions ?? [];
  const selectedBehavior = getModelBehaviorSelection([...behaviorOptions], behaviorValue);
  const controls = getModelBehaviorControls(selectedBehavior.options, selectedBehavior.value);
  const hasEffort = behaviorValue !== null || behaviorOptions.some((option) => option.value !== null);
  const shortcutOs = resolveThinkingModeShortcutOs(undefined, typeof navigator === "undefined" ? "" : navigator.platform);
  const autoSelected = managesOwnBehavior(current);
  const canChangeEffort = Boolean(selected && onBehaviorChange && !autoSelected && hasEffort);
  const effortValueLabel = autoSelected ? (isAutoRouterModel(current) ? "Managed by Smart Router" : "Managed by OpenWork") : hasEffort ? controls.options.find((option) => option.value === behaviorValue)?.label ?? selectedBehavior.label : "Unavailable";

  if (effort && selected) {
    return <div data-slot="model-thinking-submenu" className="overflow-y-auto p-2">
      <button ref={backButtonRef} type="button" aria-label="Back to models" className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setEffort(false)}>
        <ChevronLeft className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0"><span className="block truncate text-sm font-medium">Effort</span><span className="block truncate text-xs text-muted-foreground">{selected.title}</span></span>
      </button>
      <p role="status" className="px-2 py-2 text-xs text-muted-foreground">{getModelBehaviorSelection(selectedBehavior.options, controls.fast ? controls.toggleValue ?? null : behaviorValue).description}</p>
      {controls.options.map((option) => <Button key={option.value ?? "default"} variant="ghost" className="h-11 w-full justify-between" aria-pressed={option.value === behaviorValue} onClick={() => { onBehaviorChange?.(option.value); setEffort(false); }}>
        {option.label}{option.value === behaviorValue ? <Check className="size-4" /> : null}
      </Button>)}
    </div>;
  }

  return <ModelPickerList searchInputRef={props.searchInputRef} autoFocusSearch={false} options={options} current={current} query={query} onQueryChange={setQuery} onSelect={props.onSelect}
    focusAlternative={props.focusAlternative} catalogState={props.catalogState} retainedSelection={props.retainedSelection} onConnectProvider={props.onConnectProvider}
    onOpenProviderSettings={props.onOpenProviderSettings} onSetWorkspaceDefault={props.onSetWorkspaceDefault} currentBehaviorValue={behaviorValue}
    openWorkModelsSyncing={props.autoVisible && props.openWorkModelsSyncing} onReloadWorkspace={props.onReloadWorkspace} onRetryAuto={props.catalogState.onRetry} footer={<>
      <ModelPickerFooter effortButtonRef={effortButtonRef} effortLabel={effortValueLabel} effortShortcut={thinkingModeShortcutLabel(shortcutOs)} canChangeEffort={canChangeEffort} onOpenEffort={() => setEffort(true)}
        fast={selected && onBehaviorChange && !autoSelected && controls.hasFast ? { on: controls.fast, shortcut: fastModeShortcutLabel(shortcutOs), disabled: controls.toggleValue === undefined,
          onToggle: () => { if (controls.toggleValue !== undefined) onBehaviorChange(controls.toggleValue); } } : undefined}
        onConnectProvider={props.onConnectProvider} />
      {props.footerExtra}
      <AutoAccessFooter available={props.autoVisible} syncing={props.autoVisible && Boolean(props.openWorkModelsSyncing)} />
    </>} />;
}
