import { useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import { Building, Check, Cloud, Laptop } from "lucide-react";
import { resolveExtensionIconSrc } from "@/react-app/design-system/extension-icon-src";
import type { ModelOption, ModelRef } from "@/app/types";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ActionContextMenu } from "@/components/ui/action-context-menu";
import { ProviderIcon } from "@/react-app/design-system/provider-icon";
import { AutoPickerRecovery, useObservedAutoAccessSnapshot } from "@/react-app/domains/cloud/auto-access-ui";
import { autoPickerCopy, type AutoPickerState } from "@/app/lib/inference-access";
import type { MenuAction } from "@/components/ui/action-menu-model";
import { Command, CommandCollection, CommandGroup, CommandGroupLabel, CommandHeader, CommandInput, CommandItem, CommandList, CommandPanel } from "@/components/ui/command";
import { immutableModelPin, isAutoModel, isPinModelShortcut, markExplicitModelChoice, modelGroups, modelSource, modelSubtitle, modelTitle, orderedModelPins, retainedModelCopy, withAutoDefaultPin, MODEL_SOURCE_LABELS, type ModelGroup, type ModelPickerCatalogState, type RetainedModelSelection } from "./model-catalog";
import { modelRefKey, useModelCollectionsStore } from "@/react-app/domains/session/models/model-collections-store";
import { useModelShortcutsStore } from "@/react-app/domains/shortcuts/model-shortcuts-store";
import { formatChord, resolveShortcutOs } from "@/react-app/domains/shortcuts/shortcut-keys";

export function ModelSourceIcon({ model }: { model: ModelRef & { source?: ModelOption["source"] } }) {
  const source = modelSource(model);
  const Icon = source === "gateway" ? Cloud : source === "organization" ? Building : Laptop;
  return <Icon role="img" aria-label={MODEL_SOURCE_LABELS[source]} className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />;
}

function ProviderMark({ model, description, retained = false }: { model: ModelRef; description?: string; retained?: boolean }) {
  return <div data-slot="model-provider-mark" className="flex size-4 shrink-0 items-center justify-center">
    {isAutoModel(model) ? <img src={resolveExtensionIconSrc("/openwork-mark.svg")} alt="OpenWork" className="size-4" /> : <ProviderIcon providerId={retained ? undefined : model.providerID} providerName={description} size={16} />}
  </div>;
}

function ModelLoadingRows() {
  return <div role="status" aria-label="Loading models" data-testid="model-catalog-loading" className="p-2">
    {[0, 1, 2].map((index) => <div key={index} className="flex h-11 items-center gap-2 px-2"><Skeleton className="size-4 rounded" /><div className="flex flex-1 flex-col gap-1.5"><Skeleton className="h-2.5 w-36 rounded" /><Skeleton className="h-2.5 w-18 rounded" /></div><span className="size-4" /></div>)}
  </div>;
}

export type ModelPickerListProps = {
  options: readonly ModelOption[];
  current: ModelRef;
  query: string;
  onQueryChange: (value: string) => void;
  onSelect: (option: ModelOption) => void;
  focusAlternative?: boolean;
  footer?: ReactNode;
  searchInputRef?: Ref<HTMLInputElement>;
  autoFocusSearch?: boolean;
  catalogState?: ModelPickerCatalogState;
  retainedSelection?: RetainedModelSelection;
  onConnectProvider?: () => void;
  onOpenProviderSettings?: () => void;
  onSetWorkspaceDefault?: (model: ModelRef, variant?: string | null) => void | boolean | Promise<void | boolean>;
  /** Effort currently applied to `current`; kept when that model becomes the workspace default. */
  currentBehaviorValue?: string | null;
  openWorkModelsSyncing?: boolean;
  onReloadWorkspace?: () => void | Promise<unknown>;
  onRetryAuto?: () => void | Promise<unknown>;
};

type AutoRowState = { model: ModelRef; state: AutoPickerState };
export function ModelPickerList(props: ModelPickerListProps) {
  return isAutoModel(props.current) || props.options.some(isAutoModel) || props.openWorkModelsSyncing
    ? <AutoStatusModelPickerList {...props} /> : <ModelPickerRows {...props} />;
}

function AutoStatusModelPickerList(props: ModelPickerListProps) {
  const snapshot = useObservedAutoAccessSnapshot();
  const status = snapshot?.data;
  const availableAuto = props.options.find(isAutoModel);
  const auto = isAutoModel(props.current) ? props.current : availableAuto;
  const matches = auto && status && modelRefKey(auto) === modelRefKey(status);
  const state = props.openWorkModelsSyncing ? "sync" : snapshot?.status === "error" ? "unavailable" : matches ? status.state : "ready";
  const blockedByPolicy = props.retainedSelection !== undefined && props.retainedSelection.reason !== "unavailable" && isAutoModel(props.current);
  return <ModelPickerRows {...props} options={withAutoDefaultPin(props.options, status)} openWorkModelsSyncing={!blockedByPolicy && props.openWorkModelsSyncing} autoRow={!blockedByPolicy && auto ? { model: auto, state } : undefined} />;
}

/** Context-menu rows show the chord that triggers the same command (DESIGN S6). */
function menuChord(label: string, chord: string) {
  return <><span className="min-w-0 flex-1">{label}</span><kbd className="ml-4 font-sans text-xs text-muted-foreground">{chord}</kbd></>;
}

function ModelPickerRows({ options, current, query, onQueryChange, onSelect, focusAlternative = false, footer, searchInputRef, autoFocusSearch = true,
  catalogState, retainedSelection, onConnectProvider, onOpenProviderSettings, onSetWorkspaceDefault, currentBehaviorValue, openWorkModelsSyncing, onReloadWorkspace, onRetryAuto, autoRow,
}: ModelPickerListProps & { autoRow?: AutoRowState }) {
  const favorites = useModelCollectionsStore((state) => state.favorites);
  const recent = useModelCollectionsStore((state) => state.recent);
  // A model bound to a saved shortcut in Settings shows its key on the row.
  const modelShortcuts = useModelShortcutsStore((state) => state.shortcuts);
  const shortcutLabels = useMemo(() => {
    const os = resolveShortcutOs(undefined, typeof navigator === "undefined" ? "" : navigator.platform);
    return new Map(modelShortcuts.map((shortcut) => [modelRefKey({ providerID: shortcut.action.providerID, modelID: shortcut.action.modelID }), formatChord(shortcut.keys, os)]));
  }, [modelShortcuts]);
  const groups = modelGroups(options, favorites, recent, query);
  const pins = orderedModelPins(options, favorites);
  const pinned = new Set(pins.map(modelRefKey));
  const root = useRef<HTMLDivElement>(null);
  const [highlighted, setHighlighted] = useState<ModelOption | null>(null);
  const [retryBusy, setRetryBusy] = useState(false);
  const [retryFailed, setRetryFailed] = useState(false);
  const blockedAuto = (option: ModelRef) => autoRow?.state !== undefined && autoRow.state !== "ready" && modelRefKey(option) === modelRefKey(autoRow.model);
  const canSelect = (option: ModelOption) => !option.disabled && !blockedAuto(option) && options.some((item) => modelRefKey(item) === modelRefKey(option) && !item.disabled);
  const select = (option: ModelOption) => { if (canSelect(option)) onSelect(option); };
  const alternative = pins.find((option) => !isAutoModel(option) && modelRefKey(option) !== modelRefKey(current))
    ?? options.find((option) => !option.disabled && !isAutoModel(option) && modelRefKey(option) !== modelRefKey(current));
  const alternativeKey = alternative ? modelRefKey(alternative) : undefined;
  useEffect(() => {
    if (!focusAlternative) return;
    const frame = requestAnimationFrame(() => {
      const row = [...(root.current?.querySelectorAll<HTMLElement>("[data-model-key]") ?? [])].find((item) => item.dataset.modelKey === alternativeKey);
      const target = row ?? root.current?.querySelector<HTMLInputElement>('[aria-label="Search all models"]');
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusAlternative, alternativeKey]);
  const clearSearch = () => {
    onQueryChange("");
    root.current?.querySelector<HTMLInputElement>('[aria-label="Search all models"]')?.focus({ preventScroll: true });
  };
  const retry = async () => {
    if (!catalogState?.onRetry || retryBusy) return;
    setRetryBusy(true); setRetryFailed(false);
    try { await catalogState.onRetry(); } catch { setRetryFailed(true); } finally { setRetryBusy(false); }
  };
  const toggle = (option: ModelOption) => {
    if (!immutableModelPin(option) && canSelect(option)) useModelCollectionsStore.getState().toggleFavorite(option);
  };
  const hasOptions = options.some((option) => !option.disabled);
  const loading = catalogState?.state === "loading";
  const failed = catalogState?.state === "error" || retryFailed;
  const retained = retainedSelection && modelRefKey(retainedSelection.model) === modelRefKey(current)
    && !options.some((option) => modelRefKey(option) === modelRefKey(current) && !option.disabled) ? retainedSelection : undefined;
  const retainedCopy = retained ? retainedModelCopy(retained.reason) : null;
  const retainedVisible = retained && (!query.trim() || `${retained.title ?? "Saved model"} ${retained.description ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()));
  const verifiedDate = catalogState?.lastVerifiedAt ? new Date(catalogState.lastVerifiedAt) : null;
  const verified = verifiedDate && Number.isFinite(verifiedDate.valueOf()) ? verifiedDate : null;
  return <div ref={root} className="flex min-h-0 flex-1 flex-col" onKeyDownCapture={(event) => {
    if (!isPinModelShortcut(event) || event.repeat) return;
    const focusedRow = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-model-key]") : null;
    const row = focusedRow ?? root.current?.querySelector<HTMLElement>("[data-model-key][data-highlighted]");
    const option = options.find((item) => modelRefKey(item) === row?.dataset.modelKey) ?? highlighted;
    if (!option) return;
    event.preventDefault(); event.stopPropagation(); toggle(option);
  }}>
    <Command items={groups} filter={null} value={query} onValueChange={onQueryChange}>
      <CommandHeader><CommandInput ref={searchInputRef} autoFocus={autoFocusSearch} aria-label="Search all models" placeholder="Search models…" className="h-8 text-base sm:text-base md:text-base lg:text-sm" /></CommandHeader>
      <CommandPanel className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain">
        {retainedVisible ? <div data-testid="retained-selected-model" aria-disabled="true" aria-label={`${retained.title || "Saved model"}, current model, ${retainedCopy?.subtitle}`} className="px-2 pt-2">
          <p className="flex h-7 items-center px-2 text-xs text-muted-foreground">Saved selection</p>
          <div className="flex min-h-11 items-center gap-2 rounded-md px-2 py-1 text-sm opacity-55">
            <ProviderMark model={retained.model} description={retained.description} retained />
            <span className="min-w-0 flex-1"><span className="block truncate font-medium">{isAutoModel(retained.model) ? "Auto" : retained.title || "Saved model"}</span><span className="block text-muted-foreground">{isAutoModel(retained.model) && autoRow?.state !== "ready" && autoRow ? autoPickerCopy(autoRow.state, false).subtitle : retainedCopy?.subtitle}</span></span>
            <ModelSourceIcon model={retained.model} /><span className="flex size-4 shrink-0 items-center justify-center"><Check aria-hidden="true" className="size-4" /></span>
          </div>
        </div> : null}
        {loading && !hasOptions ? <ModelLoadingRows /> : null}
        {!loading && groups.length === 0 && query.trim() ? <div role="status" className="flex flex-col items-center gap-1 px-4 py-7 text-center text-sm">
          <p>No models match “{query.trim()}”</p><p className="text-muted-foreground">Try a shorter name, or search by provider.</p>
          <Button size="sm" variant="outline" className="mt-2" onClick={clearSearch}>Clear search</Button>
        </div> : null}
        {!loading && !hasOptions && !query.trim() && !failed ? <div role="status" className="flex flex-col items-center gap-1 px-4 py-7 text-center text-sm" data-testid="model-catalog-empty">
          <p>No models yet</p><p className="text-muted-foreground">{onConnectProvider ? "Connect a provider, or turn Auto back on in AI providers." : "Your organization manages model access. Ask your workspace owner or admin."}</p><p className="text-muted-foreground">Nothing is connected in this workspace.</p>
          <div className="mt-2 flex gap-2">{onConnectProvider ? <Button size="sm" onClick={onConnectProvider}>Connect a provider</Button> : null}{onOpenProviderSettings ? <Button size="sm" variant="ghost" onClick={onOpenProviderSettings}>AI providers</Button> : null}</div>
        </div> : null}
        <CommandList>
          {(group: ModelGroup) => <CommandGroup key={group.value} items={group.items}>
            <CommandGroupLabel className="flex min-h-7 items-center">{group.value}</CommandGroupLabel>
            <CommandCollection>{(option: ModelOption) => {
              const key = modelRefKey(option);
              const name = modelTitle(option);
              const fixed = immutableModelPin(option);
              const active = modelRefKey(current) === key;
              const autoState = autoRow && modelRefKey(autoRow.model) === key ? autoRow.state : undefined;
              const blocked = !canSelect(option);
              const subtitle = autoState ? autoPickerCopy(autoState, false).subtitle : active && failed ? `${modelSubtitle(option)}${modelSubtitle(option) ? " · " : ""}availability not verified` : modelSubtitle(option);
              const pinLabel = pinned.has(key) ? "Unpin" : "Pin to top";
              const actions: MenuAction[] = [
                { type: "item", id: "pin", label: fixed ? "Pinned by your org" : pinLabel, webContent: fixed ? undefined : menuChord(pinLabel, "⇧P"), disabled: fixed || blocked, onSelect: () => toggle(option) },
                { type: "item", id: "default", label: "Set as workspace default", disabled: !onSetWorkspaceDefault || blocked, onSelect: async () => { if (canSelect(option) && onSetWorkspaceDefault) { const saved = await onSetWorkspaceDefault(option, active ? currentBehaviorValue ?? null : null); if (saved !== false) markExplicitModelChoice(); } } },
                { type: "item", id: "select", label: "Switch to this model", webContent: menuChord("Switch to this model", "⏎"), disabled: blocked, onSelect: () => select(option) },
                { type: "item", id: "copy", label: "Copy model ID", onSelect: () => navigator.clipboard.writeText(`${option.providerID}/${option.modelID}`) },
              ];
              return <ActionContextMenu key={key} actions={actions} render={<CommandItem
                value={`${key} ${name} ${subtitle}`} disabled={blocked}
                data-model-key={key} data-checked={active} data-testid={`model-option-${option.providerID}-${option.modelID}`}
                aria-label={`${name}, ${subtitle}, ${MODEL_SOURCE_LABELS[modelSource(option)]}${active ? ", current model" : ""}`}
                tabIndex={blocked ? -1 : 0} className="group/model min-h-11 gap-2 rounded-md px-2 py-1 text-sm data-disabled:opacity-55"
                onFocus={() => setHighlighted(option)} onClick={() => select(option)}
                onKeyDown={(event) => { if (event.key === "Enter" && event.target === event.currentTarget) { event.preventDefault(); select(option); } }}
              />}>
                <ProviderMark model={option} description={option.description} />
                <span data-slot="model-label" className="min-w-0 flex-1 leading-[18px]"><span className={`block truncate${active ? " font-medium" : ""}`} title={name}>{name}</span><span className="block text-sm text-muted-foreground">{subtitle}</span></span>
                {!fixed && !blocked ? <Button type="button" variant="ghost" size="sm" aria-label={`${pinLabel}: ${name}`} className="h-7 px-2 text-xs opacity-0 group-hover/model:opacity-100 group-focus-within/model:opacity-100 group-data-highlighted/model:opacity-100 focus:opacity-100"
                  onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); }} onKeyDown={(event) => event.stopPropagation()}
                  onClick={(event) => { event.preventDefault(); event.stopPropagation(); toggle(option); }}>{pinned.has(key) ? "Unpin" : "Pin"}</Button> : null}
                {shortcutLabels.get(key) ? <kbd data-testid="model-shortcut-key" className="shrink-0 rounded border border-border/70 bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] leading-none text-muted-foreground">{shortcutLabels.get(key)}</kbd> : null}
                <span data-slot="model-source" className="flex size-4 shrink-0 items-center justify-center"><ModelSourceIcon model={option} /></span>
                <span data-slot="model-selection" className="flex size-4 shrink-0 items-center justify-center">{active ? <Check aria-hidden="true" className="size-4 text-muted-foreground" /> : null}</span>
              </ActionContextMenu>;
            }}</CommandCollection>
          </CommandGroup>}
        </CommandList>
        {loading && hasOptions ? <ModelLoadingRows /> : null}
      </CommandPanel>
      {failed ? <div role="alert" className="flex items-center gap-2 border-t border-border px-4 py-2 text-sm" data-testid="model-catalog-error">
        <span className="min-w-0 flex-1 text-muted-foreground">{verified ? <>Showing models from <time dateTime={verified.toISOString()}>{verified.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</time>. Couldn’t refresh just now.</> : hasOptions ? "Couldn’t load the rest of your models. Pinned models still work." : "Couldn’t load your models. Try again."}</span>
        <Button size="sm" variant="outline" disabled={!catalogState?.onRetry || retryBusy || catalogState.refreshing} onClick={() => void retry()}>Retry</Button>
      </div> : null}
      {retainedCopy && !query.trim() && !(isAutoModel(current) && autoRow && autoRow.state !== "ready") ? <div role="status" className="flex items-center gap-2 border-t border-border px-4 py-2 text-sm text-muted-foreground">
        <span className="min-w-0 flex-1">{retainedCopy.detail}</span>
        {retained?.reason === "unavailable" && catalogState?.onRetry ? <Button size="sm" variant="outline" disabled={retryBusy || catalogState.refreshing} onClick={() => void retry()}>Refresh</Button> : null}
        {retained?.reason === "disabled" && onOpenProviderSettings ? <Button size="sm" variant="outline" onClick={onOpenProviderSettings}>AI providers</Button> : null}
      </div> : null}
      {autoRow && autoRow.state !== "ready" ? <AutoPickerRecovery state={autoRow.state} onRetry={onRetryAuto} onReload={onReloadWorkspace} hasAlternatives={Boolean(alternativeKey)} />
        : openWorkModelsSyncing ? <AutoPickerRecovery state="sync" onReload={onReloadWorkspace} /> : null}
      {focusAlternative && !alternativeKey && hasOptions && onConnectProvider ? <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-2 text-sm"><span className="text-muted-foreground">Nothing else is connected in this workspace.</span><Button size="sm" variant="outline" onClick={onConnectProvider}>Connect a provider</Button></div> : null}
      {footer}
    </Command>
  </div>;
}
