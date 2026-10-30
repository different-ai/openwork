import { useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import { Building, Check, Cloud, Laptop, Lock, Pin, PinOff, Sparkles } from "lucide-react";
import type { ModelOption, ModelRef } from "@/app/types";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ActionContextMenu } from "@/components/ui/action-context-menu";
import { OpenWorkMark, ProviderIcon } from "@/react-app/design-system/provider-icon";
import { AutoPickerRecovery, useObservedAutoAccessSnapshot } from "@/react-app/domains/cloud/auto-access-ui";
import { autoNotOffered, autoPickerCopy, autoQuietlyUnavailable, freeAutoSwitchedOff, type AutoPickerState } from "@/app/lib/inference-access";
import type { MenuAction } from "@/components/ui/action-menu-model";
import { Command, CommandCollection, CommandGroup, CommandGroupLabel, CommandHeader, CommandInput, CommandItem, CommandList, CommandPanel } from "@/components/ui/command";
import { AUTO_ROUTER_GROUP, fixedModelTitle, immutableModelPin, isAutoModel, isAutoRouterModel, isPinModelShortcut, markExplicitModelChoice, modelGroups, modelMakerId, modelSource, modelStateLabel, modelSubtitle, modelTitle, orderedModelPins, retainedModelCopy, withAutoDefaultPin, MODEL_SOURCE_LABELS, type ModelGroup, type ModelPickerCatalogState, type RetainedModelSelection } from "./model-catalog";
import { modelRefKey, useModelCollectionsStore } from "@/react-app/domains/session/models/model-collections-store";
import { PickerNotice } from "./picker-notice";
import { resolveSearchIntent, searchIntentSummary, searchIntentTag, searchModels } from "./model-search";
import { useModelShortcutsStore } from "@/react-app/domains/shortcuts/model-shortcuts-store";
import { formatChord, resolveShortcutOs } from "@/react-app/domains/shortcuts/shortcut-keys";

export function ModelSourceIcon({ model }: { model: ModelRef & { source?: ModelOption["source"] } }) {
  const source = modelSource(model);
  const Icon = source === "gateway" ? Cloud : source === "organization" ? Building : Laptop;
  return <Icon role="img" aria-label={MODEL_SOURCE_LABELS[source]} className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />;
}

function ProviderMark({ model, description, retained = false }: { model: ModelRef & { title?: string }; description?: string; retained?: boolean }) {
  // The maker's logo when the name says who made it; the provider is named in text beside it.
  const maker = retained ? null : modelMakerId(model);
  return <div data-slot="model-provider-mark" className="flex size-4 shrink-0 items-center justify-center">
    {isAutoModel(model) ? <OpenWorkMark className="size-4 text-dls-accent dark:text-foreground" />
      : isAutoRouterModel(model) ? <Sparkles aria-hidden="true" strokeWidth={1.5} className="size-4 text-dls-accent dark:text-foreground" />
      : <ProviderIcon providerId={maker ?? (retained ? undefined : model.providerID)} providerName={maker ? undefined : description} size={16} />}
  </div>;
}

/** Search results, ranked in one unlabeled list. */
const SEARCH_GROUP = "Search results";
/** Groups shown without a label: search results, and Smart Routers, which name themselves. */
const UNLABELED_GROUPS = new Set([SEARCH_GROUP, AUTO_ROUTER_GROUP]);
/** Groups that list several providers' models together; rows there name their provider. */
const MIXED_GROUPS = new Set(["Pinned", "Recent", "OpenWork Models", SEARCH_GROUP]);

function ModelLoadingRows({ rows = 3, label = "Loading models", still = false }: { rows?: number; label?: string; still?: boolean }) {
  // `still`: the rest of the list did not load; placeholders hold its place without suggesting it is loading.
  return <div role="status" aria-label={label} data-testid={still ? "model-catalog-unloaded" : "model-catalog-loading"} className={still ? "px-2 pb-2 [&_[data-slot=skeleton]]:animate-none [&_[data-slot=skeleton]]:bg-gray-4" : "px-2 pb-2"}>
    {Array.from({ length: rows }, (_, index) => index).map((index) => <div key={index} className="flex h-9 items-center gap-2.5 px-2"><Skeleton className="size-4 rounded" /><Skeleton className={`h-2.5 rounded ${index % 2 ? "w-28" : "w-36"}`} /></div>)}
  </div>;
}

export type ModelPickerListProps = {
  options: readonly ModelOption[];
  current: ModelRef;
  query: string;
  onQueryChange: (value: string) => void;
  /** `behavior.variant` is set when the search named options such as "fast" or "high" that this model offers. */
  onSelect: (option: ModelOption, behavior?: { variant: string | null }) => void;
  focusAlternative?: boolean;
  footer?: ReactNode;
  /** Shown before the search field, e.g. the command palette's back button. */
  leading?: ReactNode;
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

type AutoRowState = { model: ModelRef; state: AutoPickerState; code?: string | null; resetsAt?: string | null };
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
  const state: AutoPickerState = props.openWorkModelsSyncing ? "sync" : snapshot?.status === "error" ? "unavailable" : matches ? (autoQuietlyUnavailable(status) ? "ready" : autoNotOffered(status) ? "not_offered" : status.state) : "ready";
  const switchedOff = freeAutoSwitchedOff(status);
  const blockedByPolicy = props.retainedSelection !== undefined && props.retainedSelection.reason !== "unavailable" && isAutoModel(props.current);
  return <ModelPickerRows {...props} retainedSelection={switchedOff && isAutoModel(props.current) ? undefined : props.retainedSelection} options={withAutoDefaultPin(switchedOff ? props.options.filter((option) => !isAutoModel(option)) : props.options, status)} openWorkModelsSyncing={!switchedOff && !blockedByPolicy && props.openWorkModelsSyncing} autoRow={!switchedOff && !blockedByPolicy && auto ? { model: auto, state, code: status?.code, resetsAt: status?.allowance?.resetsAt } : undefined} />;
}

/** Context-menu rows show the chord that triggers the same command (DESIGN S6). */
function menuChord(label: string, chord: string) {
  return <><span className="min-w-0 flex-1">{label}</span><kbd className="ml-4 font-sans text-xs text-muted-foreground">{chord}</kbd></>;
}

function ModelPickerRows({ options, current, query, onQueryChange, onSelect, focusAlternative = false, footer, leading, searchInputRef, autoFocusSearch = true,
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
  // Searching ranks every model in one list (best first); browsing keeps the groups.
  const searching = query.trim().length > 0;
  const search = useMemo(() => searching ? searchModels(options, query) : null, [searching, options, query]);
  const groups: ModelGroup[] = search
    ? search.matches.length ? [{ value: SEARCH_GROUP, items: search.matches.map((match) => match.option) }] : []
    : modelGroups(options, favorites, recent, query);
  const providerMiss = search?.provider && !search.provider.found ? search.provider : undefined;
  const pins = orderedModelPins(options, favorites);
  const pinned = new Set(pins.map(modelRefKey));
  const root = useRef<HTMLDivElement>(null);
  const [highlighted, setHighlighted] = useState<ModelOption | null>(null);
  const [retryBusy, setRetryBusy] = useState(false);
  const [retryFailed, setRetryFailed] = useState(false);
  const blockedAuto = (option: ModelRef) => autoRow?.state !== undefined && autoRow.state !== "ready" && modelRefKey(option) === modelRefKey(autoRow.model);
  const canSelect = (option: ModelOption) => !option.disabled && !blockedAuto(option) && options.some((item) => modelRefKey(item) === modelRefKey(option) && !item.disabled);
  // Options typed in the search ("fast", "high") come along; a model that lacks one is still chosen.
  const select = (option: ModelOption) => {
    if (!canSelect(option)) return;
    const variant = search ? resolveSearchIntent(option, search.intent).variant : undefined;
    onSelect(option, variant === undefined ? undefined : { variant });
  };
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
  const empty = !loading && !hasOptions && !query.trim() && !failed;
  const retained = retainedSelection && modelRefKey(retainedSelection.model) === modelRefKey(current)
    && !options.some((option) => modelRefKey(option) === modelRefKey(current) && !option.disabled) ? retainedSelection : undefined;
  const retainedCopy = retained ? retainedModelCopy(retained.reason) : null;
  const retainedName = retained ? (fixedModelTitle(retained.model) ?? (retained.title ? modelTitle({ ...retained.model, title: retained.title, description: retained.description }) : "Saved model")) : "";
  const retainedVisible = retained && (!query.trim() || `${retainedName} ${retained.description ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()));
  const retainedState = retained && isAutoModel(retained.model) && autoRow && autoRow.state !== "ready" ? autoPickerCopy(autoRow.state, false, undefined, autoRow.code, autoRow.resetsAt).subtitle : retainedCopy?.subtitle;
  const retainedSubtitle = [retained && !isAutoModel(retained.model) ? retained.description?.trim() : null, retainedState].filter(Boolean).join(" · ");
  // A saved model that was pinned stays where the person pinned it, at the top of Pinned.
  const retainedPinned = Boolean(retained && favorites.some((favorite) => modelRefKey(favorite) === modelRefKey(retained.model)));
  const retainedLabel = retainedPinned ? "Pinned" : "Saved selection";
  const mergedLabel = retainedVisible && retainedPinned && groups[0]?.value === "Pinned" ? "Pinned" : null;
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
      <CommandHeader className={leading ? "flex items-center gap-0" : undefined}>{leading}<CommandInput ref={searchInputRef} autoFocus={autoFocusSearch} aria-label="Search all models" placeholder="Search models…" className="h-8 text-base sm:text-base md:text-base lg:text-sm" /></CommandHeader>
      {/* The list sizes to its rows so placeholders after it stay in view; this panel does the scrolling. */}
      <CommandPanel className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain [scrollbar-width:thin] [&>[data-slot=scroll-area]]:h-auto">
        {retainedVisible ? <div data-testid="retained-selected-model" aria-disabled="true" aria-label={`${retainedName}, current model, ${retainedSubtitle}`} className="px-2 pt-2">
          <p className="flex h-7 items-center px-2 text-xs text-muted-foreground">{retainedLabel}</p>
          <div className="flex min-h-11 items-center gap-2 rounded-md px-2 py-1 text-sm opacity-55">
            <ProviderMark model={retained.model} description={retained.description} retained />
            <span className="min-w-0 flex-1 leading-[18px]"><span className="block truncate font-medium">{retainedName}</span><span className="block text-muted-foreground">{retainedSubtitle}</span></span>
            <span className="flex size-4 shrink-0 items-center justify-center">{retained.reason === "policy" ? <Lock aria-label="Blocked" strokeWidth={1.5} className="size-4" /> : <Check aria-hidden="true" className="size-4" />}</span>
          </div>
        </div> : null}
        {loading && !hasOptions ? <ModelLoadingRows /> : null}
        {search && groups.length > 0 && (providerMiss || searchIntentSummary(search.intent)) ? <p role="status" data-testid="model-search-provider-miss" className="px-4 pb-1 pt-3 text-xs text-muted-foreground">
          {[providerMiss ? (search.modelWords.length ? `No “${search.modelWords.join(" ")}” on ${providerMiss.label}. Showing other providers.` : `${providerMiss.label} has no models here.`) : null,
            searchIntentSummary(search.intent)].filter(Boolean).join(" ")}
        </p> : null}
        {!loading && groups.length === 0 && query.trim() ? <div role="status" className="flex flex-col items-center gap-1 px-4 py-7 text-center text-sm">
          <p>No models match “{query.trim()}”</p><p className="text-muted-foreground">{providerMiss ? `${providerMiss.label} isn't connected in this workspace.` : "Try a shorter name, or search by provider."}</p>
          <Button size="sm" variant="outline" className="mt-2" onClick={clearSearch}>Clear search</Button>
        </div> : null}
        {empty ? <div role="status" className="flex flex-col items-center gap-1 px-4 py-7 text-center text-sm" data-testid="model-catalog-empty">
          <p>No models yet</p><p className="text-muted-foreground">{onConnectProvider ? <>Connect a provider, or turn OpenWork Free back on in {onOpenProviderSettings ? <button type="button" className="text-foreground underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none" onClick={onOpenProviderSettings}>AI providers</button> : "AI providers"}.</> : "Your organization manages model access. Ask your workspace owner or admin."}</p>
        </div> : null}
        <CommandList>
          {(group: ModelGroup) => <CommandGroup key={group.value} items={group.items}>
            {group.value === mergedLabel || UNLABELED_GROUPS.has(group.value) ? null : <CommandGroupLabel className="flex min-h-7 items-center">{group.value}</CommandGroupLabel>}
            <CommandCollection>{(option: ModelOption) => {
              const key = modelRefKey(option);
              const name = modelTitle(option);
              const fixed = immutableModelPin(option);
              const active = modelRefKey(current) === key;
              const autoState = autoRow && modelRefKey(autoRow.model) === key ? autoRow.state : undefined;
              const blocked = !canSelect(option);
              const subtitle = autoState ? autoPickerCopy(autoState, false, undefined, autoRow?.code, autoRow?.resetsAt).subtitle : active && failed ? `${modelSubtitle(option)}${modelSubtitle(option) ? " · " : ""}availability not verified` : modelSubtitle(option);
              // The name always wins the row. One quiet line under it carries where the model
              // comes from (only where a group mixes providers) and what is true about it now.
              const meta = autoState || isAutoModel(option) || isAutoRouterModel(option) ? subtitle
                : [MIXED_GROUPS.has(group.value) ? option.description?.trim() : null, modelStateLabel(option),
                  active && failed ? "Availability not verified" : null].filter(Boolean).join(" · ");
              // Options typed in the search show only where they apply; the line above the list says the rest.
              const applies = search ? searchIntentTag(option, search.intent) : null;
              const pinLabel = pinned.has(key) ? "Unpin" : "Pin to top";
              const actions: MenuAction[] = [
                { type: "item", id: "pin", label: fixed ? "Pinned by your org" : pinLabel, webContent: fixed ? undefined : menuChord(pinLabel, "⇧P"), disabled: fixed || blocked, onSelect: () => toggle(option) },
                { type: "item", id: "default", label: "Set as workspace default", disabled: !onSetWorkspaceDefault || blocked, onSelect: async () => { if (canSelect(option) && onSetWorkspaceDefault) { const saved = await onSetWorkspaceDefault(option, active ? currentBehaviorValue ?? null : null); if (saved !== false) markExplicitModelChoice(); } } },
                { type: "item", id: "select", label: "Switch to this model", webContent: menuChord("Switch to this model", "⏎"), disabled: blocked, onSelect: () => select(option) },
                { type: "item", id: "copy", label: "Copy model ID", onSelect: () => navigator.clipboard.writeText(`${option.providerID}/${option.modelID}`) },
              ];
              return <ActionContextMenu key={key} actions={actions} render={<CommandItem
                value={`${group.value}:${key} ${name} ${subtitle}`} disabled={blocked}
                data-model-key={key} data-checked={active} data-testid={`model-option-${option.providerID}-${option.modelID}`}
                aria-label={`${name}, ${subtitle}, ${MODEL_SOURCE_LABELS[modelSource(option)]}${active ? ", current model" : ""}`}
                tabIndex={blocked ? -1 : 0} className="group/model min-h-9 gap-2.5 rounded-lg px-2 py-1.5 text-sm data-disabled:opacity-55"
                onFocus={() => setHighlighted(option)} onClick={() => select(option)}
                onKeyDown={(event) => { if (event.key === "Enter" && event.target === event.currentTarget) { event.preventDefault(); select(option); } }}
              />}>
                <ProviderMark model={option} description={option.description} />
                <span data-slot="model-label" className="min-w-0 flex-1 leading-5">
                  <span className={`block truncate${active ? " font-medium" : ""}`} title={name}>{name}</span>
                  {meta ? <span className="block truncate text-xs text-muted-foreground" title={meta}>{meta}</span> : null}
                </span>
                {applies ? <span data-testid="model-search-applies" className="shrink-0 text-xs text-muted-foreground">{applies}</span> : null}
                {shortcutLabels.get(key) ? <kbd data-testid="model-shortcut-key" className="shrink-0 rounded border border-border/70 bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] leading-none text-muted-foreground">{shortcutLabels.get(key)}</kbd> : null}
                {/* Fixed trailing slots keep checks aligned; pin shows on pointer or focus (keyboard: ⇧P). */}
                <span className="flex size-6 shrink-0 items-center justify-center">{!fixed && !blocked ? <Button type="button" variant="ghost" size="icon-sm" aria-label={`${pinLabel}: ${name}`} title={pinLabel}
                  className="size-6 text-muted-foreground opacity-0 transition-opacity duration-150 hover:text-foreground focus:opacity-100 group-hover/model:opacity-100 group-focus-within/model:opacity-100"
                  onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); }} onKeyDown={(event) => event.stopPropagation()}
                  onClick={(event) => { event.preventDefault(); event.stopPropagation(); toggle(option); }}>
                  {pinned.has(key) ? <PinOff aria-hidden="true" strokeWidth={1.5} className="size-3.5" /> : <Pin aria-hidden="true" strokeWidth={1.5} className="size-3.5" />}
                </Button> : null}</span>
                <span data-slot="model-selection" className="flex size-4 shrink-0 items-center justify-center">{active ? <Check aria-hidden="true" className="size-4 text-foreground" /> : null}</span>
              </ActionContextMenu>;
            }}</CommandCollection>
          </CommandGroup>}
        </CommandList>
        {loading && hasOptions ? <ModelLoadingRows /> : null}
        {failed && !verified && hasOptions && !query.trim() ? <ModelLoadingRows rows={2} label="Other models not loaded" still /> : null}
      </CommandPanel>
      {failed ? <PickerNotice tone={verified ? "neutral" : "error"} role="alert" testId="model-catalog-error" action={<Button size="sm" variant="outline" disabled={!catalogState?.onRetry || retryBusy || catalogState.refreshing} onClick={() => void retry()}>Retry</Button>}>
        {verified ? <>Showing models from <time dateTime={verified.toISOString()}>{verified.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</time>. Couldn’t refresh just now.</> : hasOptions ? "Couldn’t load the rest of your models. Pinned models still work." : "Couldn’t load your models. Try again."}
      </PickerNotice> : null}
      {retainedCopy && !query.trim() && !(isAutoModel(current) && autoRow && autoRow.state !== "ready") ? <PickerNotice action={<>
        {retained?.reason === "unavailable" && catalogState?.onRetry ? <Button size="sm" variant="outline" disabled={retryBusy || catalogState.refreshing} onClick={() => void retry()}>Refresh</Button> : null}
        {retained?.reason === "disabled" && onOpenProviderSettings ? <Button size="sm" variant="outline" onClick={onOpenProviderSettings}>AI providers</Button> : null}
      </>}>{retainedCopy.detail}</PickerNotice> : null}
      {autoRow && autoRow.state !== "ready" ? <AutoPickerRecovery state={autoRow.state} code={autoRow.code} resetsAt={autoRow.resetsAt} onRetry={onRetryAuto} onReload={onReloadWorkspace} hasAlternatives={Boolean(alternativeKey)} />
        : openWorkModelsSyncing ? <AutoPickerRecovery state="sync" onReload={onReloadWorkspace} /> : null}
      {empty ? <PickerNotice action={onConnectProvider ? <Button size="sm" onClick={onConnectProvider}>Connect a provider</Button> : null}>Nothing is connected in this workspace.</PickerNotice> : null}
      {focusAlternative && !alternativeKey && hasOptions && onConnectProvider ? <PickerNotice action={<Button size="sm" variant="outline" onClick={onConnectProvider}>Connect a provider</Button>}>Nothing else is connected in this workspace.</PickerNotice> : null}
      {footer}
    </Command>
  </div>;
}
