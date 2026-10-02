/** @jsxImportSource react */
// Settings › Keyboard shortcuts (ENG-398, ENG-401). The focal group is "Model
// shortcuts" (P7): each saved model gets one key. Rows are compact (S2), a
// model that can't run keeps its key and says why with the picker's own copy
// and one fix (P4, C5, C6), the pencil records a new key in place, and
// removing a key is undoable instead of confirmed (P8). Models come from the
// shared catalog, so this page lists exactly what the picker lists.
import { useEffect, useMemo, useRef, useState } from "react";
import type * as React from "react";
import { Check, CornerDownLeft, Lock, MoreHorizontal, Pencil, Plus, Zap } from "lucide-react";
import { FAST_DEFAULT_VARIANT, FAST_VARIANT_PREFIX } from "@openwork/types/cloud-model-fast";

import type { ModelRef } from "@/app/types";
import { Button } from "@/components/ui/button";
import { Command, CommandCollection, CommandGroup, CommandGroupLabel, CommandInput, CommandItem, CommandList, CommandPanel } from "@/components/ui/command";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent } from "@/components/ui/popover";
import { toast } from "@/components/ui/sonner";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { ProviderIcon } from "@/react-app/design-system/provider-icon";
import { useCheckDesktopRestriction } from "@/react-app/domains/cloud/desktop-config-provider";
import { useDenAuth } from "@/react-app/domains/cloud/den-auth-provider";
import { isAutoModel, modelTitle, type ModelCatalogOption } from "@/react-app/domains/models/model-catalog";
import { useModelCatalog, type UseModelCatalogInput } from "@/react-app/domains/models/use-model-catalog";
import { modelRefKey, useModelCollectionsStore } from "@/react-app/domains/session/models/model-collections-store";
import {
  createShortcutId,
  shortcutForModel,
  shortcutModelRef,
  useModelShortcutsStore,
  type Shortcut,
} from "@/react-app/domains/shortcuts/model-shortcuts-store";
import {
  chordFromEvent,
  chordProblem,
  formatChord,
  nextFreeChord,
  resolveShortcutOs,
  type ShortcutOs,
} from "@/react-app/domains/shortcuts/shortcut-keys";
import {
  resolveShortcutTarget,
  shortcutTargetCopy,
  shortcutTargetName,
  type ShortcutFix,
  type ShortcutTarget,
} from "@/react-app/domains/shortcuts/shortcut-target";
import { SHORTCUT_RECORDER_ATTRIBUTE } from "@/react-app/domains/shortcuts/use-model-shortcut-keys";
import { useProviderListQuery } from "@/react-app/infra/provider-list-query";
import { usePlatform } from "@/react-app/kernel/platform";
import { favoriteModelShortcutLabel } from "@/react-app/shell/favorite-model-shortcut";
import { fastModeShortcutLabel } from "@/react-app/shell/fast-mode-shortcut";
import { resolveThinkingModeShortcutOs, thinkingModeShortcutLabel } from "@/react-app/shell/thinking-mode-shortcut";

import { SettingsListSearchInput } from "../settings-list";
import { LayoutSection, LayoutStack } from "../settings-layout";

const MAX_MODEL_SHORTCUTS = 9;

export type KeyboardShortcutsViewProps = {
  /** The same inputs Settings gives the "All models" dialog. */
  catalog: Omit<UseModelCatalogInput, "enabled">;
  onOpenProviders: () => void;
  onReconnectProvider: (providerId: string) => void;
};

function Kbd({ children, muted }: { children: React.ReactNode; muted?: boolean }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-6 items-center rounded-md border border-dls-border bg-dls-hover px-1.5 font-mono text-xs leading-none",
        muted ? "text-dls-secondary" : "text-dls-text",
      )}
    >
      {children}
    </kbd>
  );
}

function ModelMark({ model, providerName, muted }: { model: ModelRef; providerName?: string; muted?: boolean }) {
  return (
    <span className={cn("flex size-6 shrink-0 items-center justify-center rounded-md bg-dls-hover", muted && "opacity-50")}>
      <ProviderIcon providerId={model.providerID} providerName={providerName} size={14} />
    </span>
  );
}

function standardEfforts(option: ModelCatalogOption | null) {
  return (option?.behaviorOptions ?? []).filter((entry) => entry.value === null || !entry.value.startsWith(FAST_VARIANT_PREFIX));
}

function offersFast(option: ModelCatalogOption | null) {
  return Boolean(option?.behaviorOptions?.some((entry) => entry.value === FAST_DEFAULT_VARIANT));
}

function effortLabel(option: ModelCatalogOption | null, effort: string | null) {
  if (effort === null) return null;
  return standardEfforts(option).find((entry) => entry.value === effort)?.label ?? effort;
}

function FastTag({ offered }: { offered: boolean }) {
  return (
    <span
      data-testid="fast-tag"
      data-offered={offered ? "true" : "false"}
      title={offered ? "Fast when switching" : "Fast isn’t offered for this model right now"}
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-0.5 rounded-full border border-dls-border px-1.5 text-[11px] font-medium",
        offered ? "text-dls-text" : "text-dls-secondary line-through",
      )}
    >
      <Zap className="size-3" fill="currentColor" aria-hidden />
      Fast
    </span>
  );
}

function RowState(props: { target: ShortcutTarget; model: string; provider: string | null; onFix: (fix: ShortcutFix) => void }) {
  if (props.target.kind === "pending" || props.target.kind === "available") return null;
  const copy = shortcutTargetCopy(props.target, { model: props.model, provider: props.provider });
  const fixLabel = copy.fix?.kind === "reconnect" ? "Reconnect" : copy.fix?.label;
  return (
    <span data-testid="model-shortcut-state" className="flex min-w-0 shrink items-center gap-1.5 text-xs text-dls-secondary">
      {copy.tone === "blocked"
        ? <Lock className="size-3 shrink-0" aria-hidden />
        : <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", copy.tone === "warning" && "bg-amber-9", copy.tone === "error" && "bg-red-9", copy.tone === "info" && "bg-gray-8")} />}
      <span className="truncate">{copy.reason}</span>
      {copy.fix && fixLabel ? (
        <button type="button" className="shrink-0 font-medium text-dls-text underline underline-offset-2" onClick={() => copy.fix && props.onFix(copy.fix.kind)}>
          {fixLabel}
        </button>
      ) : null}
    </span>
  );
}

/** Problems with a pressed chord, in the words the person needs. */
function chordError(chord: string, os: ShortcutOs) {
  const problem = chordProblem(chord, os);
  if (problem?.kind === "needs_modifier") return os === "macos" ? "Use ⌘ or ⌃ with ⌥ or ⇧, like ⌥⌘1" : "Use Ctrl with Alt or Shift, like Ctrl+Alt+1";
  if (problem?.kind === "built_in") return `${formatChord(chord, os)} is used for ${problem.label.toLowerCase()}`;
  return null;
}

/** Split "⌥⌘1" / "Ctrl+Alt+1" into the chips the recorder shows. */
function chordParts(chord: string, os: ShortcutOs) {
  const label = formatChord(chord, os);
  return os === "macos" ? [...label] : label.split("+");
}

/**
 * Listens for one chord while focused. Escape cancels; a chord the app already
 * uses, or one without enough modifiers, is refused with the reason.
 */
function KeyRecorder(props: {
  os: ShortcutOs;
  value: string | null;
  onRecord: (chord: string) => void;
  onError: (message: string | null) => void;
  onCancel: () => void;
  onConfirm: () => void;
  onBlur?: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <button
      ref={ref}
      type="button"
      {...{ [SHORTCUT_RECORDER_ATTRIBUTE]: "recording" }}
      aria-label={props.value ? `Key ${formatChord(props.value, props.os)}. Press a new key` : "Press the new key"}
      className="inline-flex h-9 min-w-24 items-center gap-1 rounded-xl border border-dls-text bg-dls-surface px-1.5 ring-3 ring-dls-text/10 outline-none"
      onBlur={props.onBlur}
      onKeyDown={(event) => {
        // Tab still moves focus; every other key is a candidate chord.
        if (event.key === "Tab" && !event.metaKey && !event.ctrlKey && !event.altKey) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "Escape") return props.onCancel();
        if (event.key === "Enter" && !event.metaKey && !event.ctrlKey && !event.altKey) return props.onConfirm();
        const chord = chordFromEvent(event.nativeEvent, props.os);
        if (!chord) return;
        const error = chordError(chord, props.os);
        props.onError(error);
        if (!error) props.onRecord(chord);
      }}
    >
      {props.value
        ? chordParts(props.value, props.os).map((part, index) => (
          <kbd key={`${part}-${index}`} className="inline-flex size-6 items-center justify-center rounded-md border border-dls-border bg-dls-surface font-mono text-xs text-dls-text shadow-xs">
            {part}
          </kbd>
        ))
        : <span className="px-1 text-xs text-dls-secondary">Press keys</span>}
      <span aria-hidden className="ml-0.5 h-4 w-px animate-pulse bg-dls-text" />
    </button>
  );
}

function ConfirmHint() {
  return <CornerDownLeft data-icon="inline-end" className="opacity-60" aria-hidden />;
}

type CatalogLookup = {
  options: ModelCatalogOption[];
  known: ModelCatalogOption[];
  byKey: Map<string, ModelCatalogOption>;
  target: (model: ModelRef) => ShortcutTarget;
  providerName: (model: ModelRef, saved?: string) => string | null;
};

function conflictFor(shortcuts: readonly Shortcut[], keys: string | null, own: { id?: string; model: ModelRef | null }) {
  if (!keys) return null;
  return shortcuts.find((entry) => entry.keys === keys && entry.id !== own.id
    && (!own.model || modelRefKey(shortcutModelRef(entry)) !== modelRefKey(own.model))) ?? null;
}

function shortcutName(shortcut: Shortcut, lookup: CatalogLookup) {
  const ref = shortcutModelRef(shortcut);
  return shortcutTargetName(ref, lookup.byKey.get(modelRefKey(ref)), shortcut.action.modelTitle);
}

/** Record a key for one row in place: the row is the editor (mockup: "Assign a key"). */
function InlineKeyEditor(props: {
  os: ShortcutOs;
  model: ModelRef;
  title: string;
  providerName?: string;
  detail: React.ReactNode;
  shortcut: Shortcut | null;
  shortcuts: Shortcut[];
  lookup: CatalogLookup;
  onCancel: () => void;
  onSave: (keys: string) => void;
}) {
  const taken = new Set(props.shortcuts.filter((entry) => entry.id !== props.shortcut?.id).map((entry) => entry.keys));
  const [keys, setKeys] = useState<string | null>(props.shortcut?.keys ?? nextFreeChord(taken));
  const [error, setError] = useState<string | null>(null);
  const conflict = conflictFor(props.shortcuts, keys, { id: props.shortcut?.id, model: props.model });
  const save = () => { if (keys && !error) props.onSave(keys); };
  const status = error ?? (conflict && keys ? `${formatChord(keys, props.os)} opens ${shortcutName(conflict, props.lookup)}` : null);
  return (
    <li data-testid="model-shortcut-key-editor" className="-mx-3 flex flex-col gap-2 border-b border-dls-border bg-dls-hover/40 px-4 py-3">
      <div className="flex min-h-9 items-center gap-3">
        <ModelMark model={props.model} providerName={props.providerName} />
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate text-sm font-medium text-dls-text">{props.title}</span>
          {props.detail}
        </span>
        <KeyRecorder os={props.os} value={keys} onRecord={setKeys} onError={setError} onCancel={props.onCancel} onConfirm={save} />
        <span className="w-16 shrink-0" />
      </div>
      <div className="flex items-center gap-2 pl-9">
        <span role="status" className={cn("min-w-0 flex-1 truncate text-xs", error ? "text-dls-text" : "text-dls-secondary")}>{status}</span>
        <Button variant="ghost" size="sm" onClick={props.onCancel}>Cancel</Button>
        <Button size="sm" disabled={!keys || Boolean(error)} onClick={save}>
          {conflict ? "Reassign" : "Save"}
          <ConfirmHint />
        </Button>
      </div>
    </li>
  );
}

type EditorTarget = { shortcut: Shortcut | null; model: ModelRef | null; anchor: Element | null };

/** Choose model, reasoning, Fast and key (mockup: "Add model shortcut"). */
function ShortcutEditor(props: {
  target: EditorTarget;
  os: ShortcutOs;
  lookup: CatalogLookup;
  savedKeys: Set<string>;
  shortcuts: Shortcut[];
  onCancel: () => void;
  onSave: (shortcut: Shortcut) => void;
}) {
  const { target, os, lookup } = props;
  const firstUnbound = lookup.options.find((option) => props.savedKeys.has(modelRefKey(option)) && !shortcutForModel(props.shortcuts, option));
  const initialModel = target.shortcut ? shortcutModelRef(target.shortcut) : target.model ?? firstUnbound ?? null;
  // "Choose a replacement" starts with no model so the person picks one; the key is kept.
  const replacing = Boolean(target.shortcut && lookup.target(shortcutModelRef(target.shortcut)).kind !== "available");
  const [modelKey, setModelKey] = useState(initialModel && !replacing ? modelRefKey(initialModel) : "");
  const [query, setQuery] = useState("");
  const [effort, setEffort] = useState<string | null>(target.shortcut?.action.effort ?? null);
  const [fast, setFast] = useState(target.shortcut?.action.fast ?? false);
  const taken = new Set(props.shortcuts.filter((entry) => entry.id !== target.shortcut?.id).map((entry) => entry.keys));
  const [keys, setKeys] = useState<string | null>(target.shortcut?.keys ?? nextFreeChord(taken));
  const [recording, setRecording] = useState(false);
  const [recordError, setRecordError] = useState<string | null>(null);

  const option = lookup.byKey.get(modelKey) ?? null;
  const model = option ?? (modelKey && initialModel && modelRefKey(initialModel) === modelKey ? initialModel : null);
  const efforts = standardEfforts(option);
  const fastOffered = offersFast(option);
  const conflict = conflictFor(props.shortcuts, keys, { id: target.shortcut?.id, model });
  const needle = query.trim().toLowerCase();
  const matches = (entry: ModelCatalogOption) => !needle || `${modelTitle(entry)} ${entry.description ?? ""}`.toLowerCase().includes(needle);
  // Saved models first, then everything else the picker lists; rows the picker
  // shows as disabled stay visible with the reason (P4) but can't be chosen.
  const listed = [...lookup.options, ...lookup.known.filter((entry) => entry.disabled && !lookup.byKey.has(modelRefKey(entry)))].filter(matches);
  const groups = [
    { value: "Saved", items: listed.filter((entry) => props.savedKeys.has(modelRefKey(entry))) },
    { value: "All models", items: listed.filter((entry) => !props.savedKeys.has(modelRefKey(entry))) },
  ].filter((group) => group.items.length > 0);

  const choose = (entry: ModelCatalogOption) => {
    if (entry.disabled) return;
    const key = modelRefKey(entry);
    setModelKey(key);
    if (!standardEfforts(entry).some((candidate) => candidate.value === effort)) setEffort(null);
    const existing = shortcutForModel(props.shortcuts, entry);
    if (existing && existing.id !== target.shortcut?.id) {
      setEffort(existing.action.effort);
      setFast(existing.action.fast);
      setKeys(existing.keys);
    }
  };

  const canSave = Boolean(model && keys && !recording);
  const save = () => {
    if (!keys || !model) return;
    props.onSave({
      id: target.shortcut?.id ?? createShortcutId(),
      keys,
      action: {
        type: "model.switch",
        providerID: model.providerID,
        modelID: model.modelID,
        effort,
        fast,
        modelTitle: option ? modelTitle(option) : target.shortcut?.action.modelTitle,
        providerName: option?.description ?? target.shortcut?.action.providerName,
      },
    });
  };

  return (
    <div
      data-testid="model-shortcut-editor"
      className="flex flex-col"
      onKeyDown={(event) => {
        const inSearch = event.target instanceof HTMLInputElement;
        if (event.key === "Enter" && !recording && canSave && (!inSearch || event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          save();
        }
      }}
    >
      <Command items={groups} filter={null} value={query} onValueChange={setQuery}>
        <div className="border-b border-dls-border px-1 py-1">
          <CommandInput aria-label="Search models" placeholder="Search models" className="h-9 text-sm" />
        </div>
        <CommandPanel className="max-h-64 overflow-y-auto overscroll-y-contain">
          {groups.length === 0 ? <p role="status" className="px-4 py-6 text-center text-sm text-dls-secondary">No models match “{query.trim()}”</p> : null}
          <CommandList aria-label="Model">
            {(group: { value: string; items: ModelCatalogOption[] }) => (
              <CommandGroup key={group.value} items={group.items}>
                <CommandGroupLabel className="flex min-h-7 items-center px-2 text-xs text-dls-secondary">{group.value}</CommandGroupLabel>
                <CommandCollection>{(entry: ModelCatalogOption) => {
                  const key = modelRefKey(entry);
                  const selected = key === modelKey;
                  const state = entry.disabled ? lookup.target(entry) : null;
                  const reason = state && state.kind !== "available" && state.kind !== "pending"
                    ? shortcutTargetCopy(state, { model: modelTitle(entry), provider: entry.description ?? null }).reason
                    : null;
                  const bound = shortcutForModel(props.shortcuts, entry);
                  return (
                    <CommandItem
                      key={key}
                      value={key}
                      disabled={entry.disabled}
                      aria-label={`${modelTitle(entry)}${reason ? `, ${reason}` : ""}`}
                      data-checked={selected}
                      className="min-h-10 gap-2.5 rounded-lg px-2 text-sm data-disabled:opacity-55"
                      onClick={() => choose(entry)}
                      onKeyDown={(event) => { if (event.key === "Enter" && event.target === event.currentTarget) { event.preventDefault(); choose(entry); } }}
                    >
                      <ModelMark model={entry} providerName={entry.description} />
                      <span className={cn("min-w-0 flex-1 truncate", selected && "font-medium")}>{modelTitle(entry)}</span>
                      {reason ? <span className="shrink-0 text-xs text-dls-secondary">{reason}</span> : null}
                      {bound && bound.id !== target.shortcut?.id ? <Kbd muted>{formatChord(bound.keys, os)}</Kbd> : null}
                      <span className="flex size-4 shrink-0 items-center justify-center">{selected ? <Check className="size-4" aria-hidden /> : null}</span>
                    </CommandItem>
                  );
                }}</CommandCollection>
              </CommandGroup>
            )}
          </CommandList>
        </CommandPanel>
      </Command>

      <div className="flex flex-col border-t border-dls-border px-4 py-2">
        <div className="flex min-h-11 items-center gap-3">
          <span className="flex-1 text-sm text-dls-secondary">Reasoning</span>
          {efforts.length > 1 ? (
            <ToggleGroup
              aria-label="Reasoning"
              variant="segmented"
              size="xs"
              spacing={0.5}
              value={[effort ?? "default"]}
              onValueChange={(values) => {
                const next = values[0];
                if (typeof next === "string") setEffort(next === "default" ? null : next);
              }}
            >
              {efforts.map((entry) => (
                <ToggleGroupItem key={entry.value ?? "default"} value={entry.value ?? "default"} aria-label={entry.label}>
                  {entry.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          ) : (
            <span className="text-xs text-dls-secondary">{model ? "Default" : "Choose a model"}</span>
          )}
        </div>

        <div className="flex min-h-11 items-center gap-3">
          <label htmlFor="model-shortcut-fast" className="text-sm text-dls-secondary">Fast</label>
          <span className="flex-1 text-right text-xs text-dls-secondary">
            {!model ? null : fastOffered ? "Higher pricing" : "Not offered for this model"}
          </span>
          <Switch
            id="model-shortcut-fast"
            aria-label="Fast"
            size="sm"
            checked={fastOffered && fast}
            disabled={!fastOffered}
            onCheckedChange={(checked) => setFast(checked)}
          />
        </div>

        <div className="flex min-h-11 items-center gap-2">
          <span className="flex-1 text-sm text-dls-secondary">Key</span>
          {recording ? (
            <KeyRecorder
              os={os}
              value={keys}
              onRecord={(chord) => { setKeys(chord); setRecording(false); }}
              onError={setRecordError}
              onCancel={() => { setRecording(false); setRecordError(null); }}
              onConfirm={() => setRecording(false)}
              onBlur={() => setRecording(false)}
            />
          ) : (
            <>
              {keys ? <Kbd>{formatChord(keys, os)}</Kbd> : <span className="text-xs text-dls-secondary">No key</span>}
              <Button variant="ghost" size="icon-xs" aria-label={keys ? `Key ${formatChord(keys, os)}. Change key` : "Record a key"} onClick={() => { setRecording(true); setRecordError(null); }}>
                <Pencil />
              </Button>
            </>
          )}
        </div>
        <p role="status" className="min-h-4 text-right text-xs text-dls-secondary">
          {recordError ?? (conflict && keys ? `${formatChord(keys, os)} opens ${shortcutName(conflict, lookup)}` : "")}
        </p>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-dls-border px-3 py-2.5">
        <Button variant="ghost" size="sm" onClick={props.onCancel}>Cancel</Button>
        <Button size="sm" disabled={!canSave} onClick={save}>
          {conflict ? "Reassign" : "Save shortcut"}
          <ConfirmHint />
        </Button>
      </div>
    </div>
  );
}

export function KeyboardShortcutsView(props: KeyboardShortcutsViewProps) {
  const platform = usePlatform();
  const navigatorPlatform = typeof navigator === "undefined" ? "" : navigator.platform;
  const os = resolveShortcutOs(platform.os, navigatorPlatform);
  const thinkingOs = resolveThinkingModeShortcutOs(platform.os, navigatorPlatform);
  const checkRestriction = useCheckDesktopRestriction();
  const auth = useDenAuth();
  const shortcuts = useModelShortcutsStore((state) => state.shortcuts);
  const saveShortcut = useModelShortcutsStore((state) => state.save);
  const removeShortcut = useModelShortcutsStore((state) => state.remove);
  const editRequest = useModelShortcutsStore((state) => state.editRequest);
  const requestEdit = useModelShortcutsStore((state) => state.requestEdit);
  const favorites = useModelCollectionsStore((state) => state.favorites);
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const [keyEditor, setKeyEditor] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const addButton = useRef<HTMLButtonElement>(null);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());

  const catalog = useModelCatalog({ ...props.catalog, enabled: Boolean(props.catalog.client) });
  const providers = useProviderListQuery({
    client: props.catalog.client,
    baseUrl: props.catalog.baseUrl,
    directory: props.catalog.directory || undefined,
    enabled: Boolean(props.catalog.client),
    showSavedWhileLoading: true,
  });
  const providerList = providers.data;
  const signedIn = props.catalog.cloudProvidersEnabled ?? auth.isSignedIn;
  const lookup = useMemo<CatalogLookup>(() => {
    const connected = new Set(providerList?.connected ?? []);
    const disconnected = new Set((providerList?.all ?? []).map((provider) => provider.id).filter((id) => !connected.has(id)));
    const byKey = new Map(catalog.actionOptions.map((option) => [modelRefKey(option), option]));
    return {
      options: [...catalog.actionOptions].sort((a, b) => Number(isAutoModel(b)) - Number(isAutoModel(a)) || modelTitle(a).localeCompare(modelTitle(b))),
      known: catalog.knownOptions,
      byKey,
      target: (model) => resolveShortcutTarget({
        model,
        actionOptions: catalog.actionOptions,
        knownOptions: catalog.knownOptions,
        catalogState: catalog.catalogState.state,
        signedIn,
        restrictToCloud: catalog.restrictToCloud,
        checkRestriction,
        disconnectedProviderIds: disconnected,
      }),
      providerName: (model, saved) => providerList?.all?.find((provider) => provider.id === model.providerID)?.name
        ?? catalog.knownOptions.find((option) => modelRefKey(option) === modelRefKey(model))?.description
        ?? saved ?? null,
    };
  }, [catalog.actionOptions, catalog.knownOptions, catalog.catalogState.state, catalog.restrictToCloud, checkRestriction, providerList, signedIn]);
  const savedKeys = useMemo(() => new Set(favorites.map(modelRefKey)), [favorites]);
  const unassigned = favorites.filter((favorite) => !shortcutForModel(shortcuts, favorite) && lookup.byKey.has(modelRefKey(favorite)));

  // "Choose a replacement" from the composer notice opens that shortcut here.
  // The request stays until that editor closes, so a remount while Settings
  // opens still lands on it.
  const requestedShortcut = editRequest ? shortcuts.find((entry) => entry.id === editRequest) ?? null : null;
  useEffect(() => {
    if (!editRequest) return;
    if (!requestedShortcut) {
      requestEdit(null);
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      setEditor((current) => current?.shortcut?.id === requestedShortcut.id ? current
        : { shortcut: requestedShortcut, model: shortcutModelRef(requestedShortcut), anchor: rowRefs.current.get(requestedShortcut.id) ?? null });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [editRequest, requestEdit, requestedShortcut]);
  const closeEditor = () => {
    setEditor(null);
    if (useModelShortcutsStore.getState().editRequest) requestEdit(null);
  };

  const handleSave = (shortcut: Shortcut) => {
    saveShortcut(shortcut);
    closeEditor();
    setKeyEditor(null);
  };
  const handleRemove = (shortcut: Shortcut) => {
    removeShortcut(shortcut.id);
    toast(`Removed ${formatChord(shortcut.keys, os)}`, {
      action: { label: "Undo", onClick: () => saveShortcut(shortcut) },
    });
  };
  const handleFix = (shortcut: Shortcut, fix: ShortcutFix) => {
    if (fix === "reconnect") props.onReconnectProvider(shortcut.action.providerID);
    else if (fix === "providers") props.onOpenProviders();
    else setEditor({ shortcut, model: shortcutModelRef(shortcut), anchor: rowRefs.current.get(shortcut.id) ?? null });
  };

  const needle = search.trim().toLowerCase();
  const visible = (...texts: Array<string | null | undefined>) => !needle || texts.some((text) => text?.toLowerCase().includes(needle));
  const chatShortcuts = [
    { label: "New chat", keys: formatChord("Mod+N", os) },
    { label: "Command palette", keys: formatChord("Mod+K", os) },
    { label: "Next saved model", keys: os === "macos" ? "⌃⇧M" : favoriteModelShortcutLabel },
    { label: "Cycle reasoning", keys: thinkingModeShortcutLabel(thinkingOs) },
    { label: "Toggle Fast", keys: fastModeShortcutLabel(thinkingOs) },
  ].filter((entry) => visible(entry.label, entry.keys));
  const editorOpen = editor !== null;
  const full = shortcuts.length >= MAX_MODEL_SHORTCUTS;

  const shortcutRows = shortcuts.map((shortcut) => {
    const ref = shortcutModelRef(shortcut);
    const option = lookup.byKey.get(modelRefKey(ref)) ?? null;
    const title = shortcutName(shortcut, lookup);
    const providerName = lookup.providerName(ref, shortcut.action.providerName);
    const target = lookup.target(ref);
    const effort = effortLabel(option, shortcut.action.effort);
    return { shortcut, ref, option, title, providerName, target, effort };
  }).filter((row) => visible(row.title, row.providerName, formatChord(row.shortcut.keys, os), row.effort));
  const unassignedRows = unassigned.map((favorite) => {
    const option = lookup.byKey.get(modelRefKey(favorite)) ?? null;
    return { favorite, option, title: shortcutTargetName(favorite, option) };
  }).filter((row) => visible(row.title, "Unassigned"));

  return (
    <LayoutStack>
      <SettingsListSearchInput
        aria-label="Search shortcuts"
        placeholder="Search shortcuts"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />

      <LayoutSection>
        <div className="flex flex-col">
          <div className="flex min-h-10 items-center justify-between gap-3 pb-2">
            <div className="flex items-baseline gap-2">
              <h2 className="text-sm font-semibold text-dls-text">Model shortcuts</h2>
              <span className="text-xs text-dls-secondary">{shortcuts.length} of {MAX_MODEL_SHORTCUTS} keys set</span>
            </div>
            <Button
              ref={addButton}
              size="sm"
              disabled={full}
              title={full ? "All nine keys are set. Remove one to add another." : undefined}
              aria-expanded={editorOpen && editor?.shortcut === null}
              onClick={() => setEditor({ shortcut: null, model: null, anchor: addButton.current })}
            >
              <Plus data-icon="inline-start" />
              Add model shortcut
            </Button>
          </div>

          <ul aria-label="Model shortcuts" className="flex flex-col border-t border-dls-border">
            {shortcuts.length === 0 && unassigned.length === 0 ? (
              <li className="py-4 text-sm text-dls-secondary">No model shortcuts yet. Add one to switch models with a key.</li>
            ) : null}
            {shortcuts.length + unassigned.length > 0 && shortcutRows.length + unassignedRows.length === 0 ? (
              <li className="py-4 text-sm text-dls-secondary">No model shortcuts match “{search.trim()}”</li>
            ) : null}
            {shortcutRows.map(({ shortcut, ref, option, title, providerName, target, effort }) => {
              const ready = target.kind === "available" || target.kind === "pending";
              const detail = (
                <>
                  <span className="shrink-0 text-xs text-dls-secondary">{effort ? `${effort} reasoning` : "Default"}</span>
                  {shortcut.action.fast ? <FastTag offered={!option || offersFast(option)} /> : null}
                </>
              );
              if (keyEditor === shortcut.id) {
                return (
                  <InlineKeyEditor
                    key={shortcut.id}
                    os={os}
                    model={ref}
                    title={title}
                    providerName={providerName ?? undefined}
                    detail={detail}
                    shortcut={shortcut}
                    shortcuts={shortcuts}
                    lookup={lookup}
                    onCancel={() => setKeyEditor(null)}
                    onSave={(keys) => handleSave({ ...shortcut, keys })}
                  />
                );
              }
              return (
                <li
                  key={shortcut.id}
                  ref={(element) => { if (element) rowRefs.current.set(shortcut.id, element); else rowRefs.current.delete(shortcut.id); }}
                  data-testid="model-shortcut-row"
                  data-state={target.kind === "retained" ? target.reason : target.kind}
                  className={cn("flex min-h-12 items-center gap-3 border-b border-dls-border px-1", editor?.shortcut?.id === shortcut.id && "bg-dls-hover/50")}
                >
                  <ModelMark model={ref} providerName={providerName ?? undefined} muted={!ready} />
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    <span className={cn("truncate text-sm font-medium", ready ? "text-dls-text" : "text-dls-secondary")}>{title}</span>
                    {detail}
                  </span>
                  <RowState target={target} model={title} provider={providerName} onFix={(fix) => handleFix(shortcut, fix)} />
                  <span className="flex w-20 shrink-0 justify-start">
                    <Kbd muted={!ready}>{formatChord(shortcut.keys, os)}</Kbd>
                  </span>
                  <span className="flex w-16 shrink-0 justify-end gap-0.5">
                    <Button variant="ghost" size="icon-xs" aria-label={`Change key for ${title}`} onClick={() => { setEditor(null); setKeyEditor(shortcut.id); }}>
                      <Pencil />
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label={`More for ${title}`}><MoreHorizontal /></Button>} />
                      <DropdownMenuContent align="end" className="w-52">
                        <DropdownMenuItem onClick={() => setEditor({ shortcut, model: ref, anchor: rowRefs.current.get(shortcut.id) ?? null })}>
                          {ready ? "Edit model and reasoning" : "Choose a replacement"}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => handleRemove(shortcut)}>Remove shortcut</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </span>
                </li>
              );
            })}
            {unassignedRows.map(({ favorite, option, title }) => {
              const key = modelRefKey(favorite);
              const detail = <span className="shrink-0 text-xs text-dls-secondary">Default</span>;
              if (keyEditor === key) {
                return (
                  <InlineKeyEditor
                    key={key}
                    os={os}
                    model={favorite}
                    title={title}
                    providerName={option?.description}
                    detail={detail}
                    shortcut={null}
                    shortcuts={shortcuts}
                    lookup={lookup}
                    onCancel={() => setKeyEditor(null)}
                    onSave={(keys) => handleSave({
                      id: createShortcutId(),
                      keys,
                      action: {
                        type: "model.switch", providerID: favorite.providerID, modelID: favorite.modelID, effort: null, fast: false,
                        modelTitle: title, providerName: option?.description,
                      },
                    })}
                  />
                );
              }
              return (
                <li key={key} data-testid="model-shortcut-row" data-state="unassigned" className="flex min-h-12 items-center gap-3 border-b border-dls-border px-1">
                  <ModelMark model={favorite} providerName={option?.description} />
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    <span className="truncate text-sm font-medium text-dls-text">{title}</span>
                    {detail}
                  </span>
                  <span className="flex w-20 shrink-0 text-xs text-dls-secondary">Unassigned</span>
                  <span className="flex w-16 shrink-0 justify-end">
                    <Button variant="ghost" size="icon-xs" disabled={full} aria-label={`Set a key for ${title}`} onClick={() => { setEditor(null); setKeyEditor(key); }}>
                      <Pencil />
                    </Button>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      </LayoutSection>

      {chatShortcuts.length > 0 ? (
        <LayoutSection>
          <div className="flex flex-col">
            <h2 className="pb-2 text-sm font-semibold text-dls-text">Chat</h2>
            <ul aria-label="Chat shortcuts" className="flex flex-col border-t border-dls-border">
              {chatShortcuts.map((entry) => (
                <li key={entry.label} className="flex min-h-11 items-center gap-3 border-b border-dls-border px-1">
                  <span className="flex-1 text-sm text-dls-text">{entry.label}</span>
                  <span className="flex w-20 shrink-0"><Kbd>{entry.keys}</Kbd></span>
                  <span className="w-16 shrink-0" />
                </li>
              ))}
            </ul>
          </div>
        </LayoutSection>
      ) : null}

      <Popover open={editorOpen} onOpenChange={(open) => { if (!open) closeEditor(); }}>
        {editor ? (
          <PopoverContent anchor={editor.anchor} align="end" side="bottom" sideOffset={6} className="w-[min(440px,calc(100vw-32px))] gap-0 overflow-hidden rounded-2xl p-0">
            <ShortcutEditor
              key={editor.shortcut?.id ?? "new"}
              target={editor}
              os={os}
              lookup={lookup}
              savedKeys={savedKeys}
              shortcuts={shortcuts}
              onCancel={closeEditor}
              onSave={handleSave}
            />
          </PopoverContent>
        ) : null}
      </Popover>
    </LayoutStack>
  );
}
