/** @jsxImportSource react */
// Settings › Keyboard shortcuts (ENG-398). The focal group is "Model
// shortcuts": each saved model gets one key. Rows are compact (DESIGN.md S2),
// unavailable models keep their key and say why (P4, C5), and removing a key
// is undoable instead of confirmed (P8).
import { useMemo, useState } from "react";
import type * as React from "react";
import { Lock, Pencil, Plus, Trash2, Zap } from "lucide-react";
import { FAST_DEFAULT_VARIANT, FAST_VARIANT_PREFIX } from "@openwork/types/cloud-model-fast";

import type { Client, ModelRef } from "@/app/types";
import { getModelBehaviorSummary } from "@/app/lib/model-behavior";
import { isDesktopProviderBlocked } from "@/app/cloud/desktop-app-restrictions";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/sonner";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { ProviderIcon } from "@/react-app/design-system/provider-icon";
import { useCheckDesktopRestriction } from "@/react-app/domains/cloud/desktop-config-provider";
import { modelRefKey, useModelCollectionsStore } from "@/react-app/domains/session/models/model-collections-store";
import {
  createShortcutId,
  shortcutForModel,
  useModelShortcutsStore,
  type Shortcut,
} from "@/react-app/domains/shortcuts/model-shortcuts-store";
import { shortcutRowState, type ShortcutRowState } from "@/react-app/domains/shortcuts/shortcut-row-state";
import {
  chordFromEvent,
  chordProblem,
  formatChord,
  nextFreeChord,
  resolveShortcutOs,
  type ShortcutOs,
} from "@/react-app/domains/shortcuts/shortcut-keys";
import { SHORTCUT_RECORDER_ATTRIBUTE } from "@/react-app/domains/shortcuts/use-model-shortcut-keys";
import { getConnectedProviderItems, useProviderListQuery } from "@/react-app/infra/provider-list-query";
import { usePlatform } from "@/react-app/kernel/platform";
import { favoriteModelShortcutLabel } from "@/react-app/shell/favorite-model-shortcut";
import { resolveThinkingModeShortcutOs, thinkingModeShortcutLabel } from "@/react-app/shell/thinking-mode-shortcut";

import { LayoutSection, LayoutStack } from "../settings-layout";

type CatalogModel = ModelRef & {
  title: string;
  providerName: string;
  behaviorOptions: Array<{ value: string | null; label: string }>;
};

export type KeyboardShortcutsViewProps = {
  client: Client | null;
  baseUrl: string;
  directory: string;
  onOpenProviders: () => void;
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

function standardEffortOptions(model: CatalogModel | null) {
  return (model?.behaviorOptions ?? []).filter((option) => option.value === null || !option.value.startsWith(FAST_VARIANT_PREFIX));
}

function offersFast(model: CatalogModel | null) {
  return Boolean(model?.behaviorOptions.some((option) => option.value === FAST_DEFAULT_VARIANT));
}

function effortLabel(model: CatalogModel | null, effort: string | null) {
  if (effort === null) return null;
  return standardEffortOptions(model).find((option) => option.value === effort)?.label ?? effort;
}

function FastTag({ offered }: { offered: boolean }) {
  return (
    <span
      data-testid="fast-tag"
      data-offered={offered ? "true" : "false"}
      title={offered ? "Fast when switching" : "Fast isn't offered for this model right now"}
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-0.5 rounded-full border px-1.5 text-[11px] font-medium",
        offered ? "border-dls-border text-dls-text" : "border-dls-border text-dls-secondary line-through",
      )}
    >
      <Zap className="size-3" fill="currentColor" aria-hidden />
      Fast
    </span>
  );
}

function RowState({ state, onOpenProviders }: { state: ShortcutRowState; onOpenProviders: () => void }) {
  switch (state.kind) {
    case "blocked":
      return (
        <span className="flex items-center gap-1.5 text-xs text-dls-secondary">
          <Lock className="size-3" aria-hidden />
          Blocked by your organization
        </span>
      );
    case "provider_disconnected":
      return (
        <span className="flex items-center gap-1.5 text-xs text-dls-secondary">
          <span aria-hidden className="size-1.5 rounded-full bg-amber-9" />
          {state.providerName ?? "Provider"} disconnected
          <button type="button" className="font-medium text-dls-text underline underline-offset-2" onClick={onOpenProviders}>
            Reconnect
          </button>
        </span>
      );
    case "model_missing":
      return (
        <span className="flex items-center gap-1.5 text-xs text-dls-secondary">
          <span aria-hidden className="size-1.5 rounded-full bg-red-9" />
          No longer offered
        </span>
      );
    default:
      return null;
  }
}

type EditorTarget = { shortcut: Shortcut | null; model: ModelRef | null };

function ShortcutEditor(props: {
  target: EditorTarget;
  os: ShortcutOs;
  models: CatalogModel[];
  savedKeys: Set<string>;
  shortcuts: Shortcut[];
  onCancel: () => void;
  onSave: (shortcut: Shortcut) => void;
}) {
  const { target, os, models } = props;
  const initialModel = target.shortcut
    ? { providerID: target.shortcut.action.providerID, modelID: target.shortcut.action.modelID }
    : target.model ?? (models.find((model) => props.savedKeys.has(modelRefKey(model)) && !shortcutForModel(props.shortcuts, model)) ?? models[0] ?? null);
  const [modelKey, setModelKey] = useState(initialModel ? modelRefKey(initialModel) : "");
  const [effort, setEffort] = useState<string | null>(target.shortcut?.action.effort ?? null);
  const [fast, setFast] = useState(target.shortcut?.action.fast ?? false);
  const takenKeys = new Set(props.shortcuts.filter((entry) => entry.id !== target.shortcut?.id).map((entry) => entry.keys));
  const [keys, setKeys] = useState<string | null>(target.shortcut?.keys ?? nextFreeChord(takenKeys));
  const [recording, setRecording] = useState(false);
  const [recordError, setRecordError] = useState<string | null>(null);

  const model = models.find((entry) => modelRefKey(entry) === modelKey) ?? null;
  const storedTitle = target.shortcut?.action.modelTitle ?? target.shortcut?.action.modelID ?? null;
  const efforts = standardEffortOptions(model);
  const fastOffered = offersFast(model);
  const conflict = keys
    ? props.shortcuts.find((entry) => entry.keys === keys && entry.id !== target.shortcut?.id
      && modelRefKey({ providerID: entry.action.providerID, modelID: entry.action.modelID }) !== modelKey) ?? null
    : null;
  const conflictTitle = conflict ? conflict.action.modelTitle ?? conflict.action.modelID : null;
  const saved = models.filter((entry) => props.savedKeys.has(modelRefKey(entry)));
  const others = models.filter((entry) => !props.savedKeys.has(modelRefKey(entry)));
  const selectItems = Object.fromEntries([
    ...models.map((entry) => [modelRefKey(entry), entry.title] as const),
    ...(model || !modelKey ? [] : [[modelKey, storedTitle ?? modelKey] as const]),
  ]);

  const selectModel = (value: string) => {
    setModelKey(value);
    const next = models.find((entry) => modelRefKey(entry) === value) ?? null;
    if (!standardEffortOptions(next).some((option) => option.value === effort)) setEffort(null);
    const existing = next ? shortcutForModel(props.shortcuts, next) : null;
    if (existing && existing.id !== target.shortcut?.id) {
      setEffort(existing.action.effort);
      setFast(existing.action.fast);
    }
  };

  const handleRecordKey = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!recording) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      setRecording(false);
      setRecordError(null);
      return;
    }
    const chord = chordFromEvent(event.nativeEvent, os);
    if (!chord) return;
    const problem = chordProblem(chord, os);
    if (problem?.kind === "needs_modifier") {
      setRecordError(os === "macos" ? "Use ⌘ or ⌃ with ⌥ or ⇧, like ⌥⌘1." : "Use Ctrl with Alt or Shift, like Ctrl+Alt+1.");
      return;
    }
    if (problem?.kind === "built_in") {
      setRecordError(`${formatChord(chord, os)} is used for ${problem.label.toLowerCase()}.`);
      return;
    }
    setKeys(chord);
    setRecordError(null);
    setRecording(false);
  };

  const canSave = Boolean(modelKey && keys && !recording);
  const save = () => {
    if (!keys || !modelKey) return;
    const ref = model ?? initialModel;
    if (!ref) return;
    props.onSave({
      id: target.shortcut?.id ?? createShortcutId(),
      keys,
      action: {
        type: "model.switch",
        providerID: ref.providerID,
        modelID: ref.modelID,
        effort,
        fast,
        modelTitle: model?.title ?? target.shortcut?.action.modelTitle,
        providerName: model?.providerName ?? target.shortcut?.action.providerName,
      },
    });
  };

  return (
    <div
      data-testid="model-shortcut-editor"
      className="flex flex-col gap-1 rounded-xl border border-dls-border bg-dls-surface p-3"
      onKeyDown={(event) => {
        if (event.key === "Enter" && !recording && canSave && event.target === event.currentTarget) save();
      }}
    >
      <div className="flex min-h-10 items-center gap-3">
        <span className="w-24 shrink-0 text-sm text-dls-secondary">Model</span>
        <Select value={modelKey} items={selectItems} onValueChange={(value) => { if (typeof value === "string") selectModel(value); }}>
          <SelectTrigger className="min-w-0 flex-1" aria-label="Model">
            <SelectValue placeholder="Choose a model" />
          </SelectTrigger>
          <SelectContent>
            {saved.length > 0 ? (
              <SelectGroup>
                <SelectLabel>Saved</SelectLabel>
                {saved.map((entry) => (
                  <SelectItem key={modelRefKey(entry)} value={modelRefKey(entry)}>{entry.title}</SelectItem>
                ))}
              </SelectGroup>
            ) : null}
            <SelectGroup>
              <SelectLabel>All models</SelectLabel>
              {others.map((entry) => (
                <SelectItem key={modelRefKey(entry)} value={modelRefKey(entry)}>{entry.title}</SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>

      <div className="flex min-h-10 items-center gap-3">
        <span className="w-24 shrink-0 text-sm text-dls-secondary">Reasoning</span>
        {efforts.length > 1 ? (
          <div role="group" aria-label="Reasoning" className="flex flex-wrap gap-0.5 rounded-lg bg-dls-hover p-0.5">
            {efforts.map((option) => (
              <button
                key={option.value ?? "default"}
                type="button"
                aria-pressed={option.value === effort}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs transition-colors",
                  option.value === effort ? "bg-dls-surface font-medium text-dls-text shadow-sm" : "text-dls-secondary hover:text-dls-text",
                )}
                onClick={() => setEffort(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        ) : (
          <span className="text-xs text-dls-secondary">Default</span>
        )}
      </div>

      <div className="flex min-h-10 items-center gap-3">
        <label htmlFor="model-shortcut-fast" className="w-24 shrink-0 text-sm text-dls-secondary">Fast</label>
        <span className="flex-1 text-xs text-dls-secondary">
          {fastOffered ? "Higher pricing" : "Not offered for this model"}
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

      <div className="flex min-h-10 items-center gap-3">
        <span className="w-24 shrink-0 text-sm text-dls-secondary">Key</span>
        <button
          type="button"
          {...{ [SHORTCUT_RECORDER_ATTRIBUTE]: recording ? "recording" : "idle" }}
          aria-label={recording ? "Press the new key" : keys ? `Key ${formatChord(keys, os)}. Change key` : "Record a key"}
          className={cn(
            "inline-flex h-8 min-w-24 items-center justify-center gap-1 rounded-lg border px-2 font-mono text-xs transition-colors",
            recording ? "border-dls-accent ring-2 ring-dls-accent/15 text-dls-secondary" : "border-dls-border text-dls-text hover:bg-dls-hover",
          )}
          onClick={() => { setRecording(true); setRecordError(null); }}
          onKeyDown={handleRecordKey}
          onBlur={() => setRecording(false)}
        >
          {recording ? "Press keys…" : keys ? formatChord(keys, os) : "Record key"}
        </button>
        <span role="status" className="min-w-0 flex-1 truncate text-xs text-dls-secondary">
          {recordError ?? (conflictTitle && keys ? `${formatChord(keys, os)} opens ${conflictTitle}` : "")}
        </span>
      </div>

      <div className="flex items-center justify-end gap-2 pt-1">
        <Button variant="ghost" size="sm" onClick={props.onCancel}>Cancel</Button>
        <Button size="sm" disabled={!canSave} onClick={save}>
          {conflict ? "Reassign" : "Save shortcut"}
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
  const shortcuts = useModelShortcutsStore((state) => state.shortcuts);
  const saveShortcut = useModelShortcutsStore((state) => state.save);
  const removeShortcut = useModelShortcutsStore((state) => state.remove);
  const favorites = useModelCollectionsStore((state) => state.favorites);
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const catalogQuery = useProviderListQuery({
    client: props.client,
    baseUrl: props.baseUrl,
    directory: props.directory || undefined,
    enabled: Boolean(props.client),
  });
  const catalog = catalogQuery.data;
  const rowCatalog = useMemo(() => (catalog ? { all: catalog.all ?? [], connected: getConnectedProviderItems(catalog) } : null), [catalog]);

  const models = useMemo<CatalogModel[]>(() => getConnectedProviderItems(catalog).flatMap((provider) =>
    Object.entries(provider.models).map(([modelID, model]) => ({
      providerID: provider.id,
      modelID,
      title: model.name || modelID,
      providerName: provider.name,
      behaviorOptions: getModelBehaviorSummary(provider.id, model, null, provider.name).options,
    }))).sort((a, b) => a.title.localeCompare(b.title)), [catalog]);
  const modelsByKey = useMemo(() => new Map(models.map((model) => [modelRefKey(model), model])), [models]);
  const savedKeys = useMemo(() => new Set(favorites.map(modelRefKey)), [favorites]);
  const unassigned = favorites.filter((favorite) => !shortcutForModel(shortcuts, favorite) && modelsByKey.has(modelRefKey(favorite)));

  const handleSave = (shortcut: Shortcut) => {
    saveShortcut(shortcut);
    setEditor(null);
  };
  const handleRemove = (shortcut: Shortcut) => {
    removeShortcut(shortcut.id);
    toast(`Removed ${formatChord(shortcut.keys, os)}`, {
      action: { label: "Undo", onClick: () => saveShortcut(shortcut) },
    });
  };

  const chatShortcuts = [
    { label: "New chat", keys: formatChord("Mod+N", os) },
    { label: "Command palette", keys: formatChord("Mod+K", os) },
    { label: "Next saved model", keys: os === "macos" ? "⌃⇧M" : favoriteModelShortcutLabel },
    { label: "Cycle reasoning", keys: thinkingModeShortcutLabel(thinkingOs) },
  ];

  return (
    <LayoutStack>
      <LayoutSection>
        <div className="flex flex-col">
          <div className="flex min-h-9 items-center justify-between gap-3 pb-1.5">
            <div className="flex items-baseline gap-2">
              <h2 className="text-sm font-semibold text-dls-text">Model shortcuts</h2>
              <span className="text-xs text-dls-secondary">{shortcuts.length} of 9 keys set</span>
            </div>
            <Button size="sm" onClick={() => setEditor({ shortcut: null, model: null })} disabled={editor !== null && editor.shortcut === null && editor.model === null}>
              <Plus data-icon="inline-start" />
              Add model shortcut
            </Button>
          </div>

          {editor && editor.shortcut === null && editor.model === null ? (
            <div className="pb-3">
              <ShortcutEditor target={editor} os={os} models={models} savedKeys={savedKeys} shortcuts={shortcuts} onCancel={() => setEditor(null)} onSave={handleSave} />
            </div>
          ) : null}

          <ul aria-label="Model shortcuts" className="flex flex-col border-t border-dls-border">
            {shortcuts.length === 0 && unassigned.length === 0 ? (
              <li className="py-4 text-sm text-dls-secondary">
                No model shortcuts yet. Add one to switch models with a key.
              </li>
            ) : null}
            {shortcuts.map((shortcut) => {
              const ref = { providerID: shortcut.action.providerID, modelID: shortcut.action.modelID };
              const model = modelsByKey.get(modelRefKey(ref)) ?? null;
              const title = model?.title ?? shortcut.action.modelTitle ?? shortcut.action.modelID;
              const state = shortcutRowState({
                ...ref,
                providerName: shortcut.action.providerName,
                blocked: isDesktopProviderBlocked({ providerId: ref.providerID, checkRestriction }),
                catalog: rowCatalog,
              });
              const available = state.kind === "available" || state.kind === "pending";
              const effort = effortLabel(model, shortcut.action.effort);
              if (editor?.shortcut?.id === shortcut.id) {
                return (
                  <li key={shortcut.id} className="border-b border-dls-border py-2">
                    <ShortcutEditor target={editor} os={os} models={models} savedKeys={savedKeys} shortcuts={shortcuts} onCancel={() => setEditor(null)} onSave={handleSave} />
                  </li>
                );
              }
              return (
                <li
                  key={shortcut.id}
                  data-testid="model-shortcut-row"
                  data-state={state.kind}
                  className="flex min-h-[52px] items-center gap-3 border-b border-dls-border px-1"
                >
                  <span className={cn("flex w-6 shrink-0 justify-center", !available && "opacity-50")}>
                    <ProviderIcon providerId={ref.providerID} providerName={model?.providerName ?? shortcut.action.providerName} size={16} />
                  </span>
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    <span className={cn("truncate text-sm font-medium", available ? "text-dls-text" : "text-dls-secondary")}>{title}</span>
                    <span className="shrink-0 text-xs text-dls-secondary">{effort ? `${effort} reasoning` : "Default"}</span>
                    {shortcut.action.fast ? <FastTag offered={!model || offersFast(model)} /> : null}
                  </span>
                  <RowState state={state} onOpenProviders={props.onOpenProviders} />
                  <span className="flex w-24 shrink-0 justify-start">
                    <Kbd muted={!available}>{formatChord(shortcut.keys, os)}</Kbd>
                  </span>
                  <span className="flex w-16 shrink-0 justify-end gap-1">
                    <Button variant="ghost" size="icon-xs" aria-label={`Edit shortcut for ${title}`} onClick={() => setEditor({ shortcut, model: ref })}>
                      <Pencil />
                    </Button>
                    <Button variant="ghost" size="icon-xs" aria-label={`Remove shortcut for ${title}`} onClick={() => handleRemove(shortcut)}>
                      <Trash2 />
                    </Button>
                  </span>
                </li>
              );
            })}
            {unassigned.map((favorite) => {
              const model = modelsByKey.get(modelRefKey(favorite)) ?? null;
              const title = model?.title ?? favorite.modelID;
              if (editor && !editor.shortcut && editor.model && modelRefKey(editor.model) === modelRefKey(favorite)) {
                return (
                  <li key={modelRefKey(favorite)} className="border-b border-dls-border py-2">
                    <ShortcutEditor target={editor} os={os} models={models} savedKeys={savedKeys} shortcuts={shortcuts} onCancel={() => setEditor(null)} onSave={handleSave} />
                  </li>
                );
              }
              return (
                <li key={modelRefKey(favorite)} data-testid="model-shortcut-row" data-state="unassigned" className="flex min-h-[52px] items-center gap-3 border-b border-dls-border px-1">
                  <span className="flex w-6 shrink-0 justify-center">
                    <ProviderIcon providerId={favorite.providerID} providerName={model?.providerName} size={16} />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-dls-text">{title}</span>
                  <span className="flex w-24 shrink-0 text-xs text-dls-secondary">Unassigned</span>
                  <span className="flex w-16 shrink-0 justify-end">
                    <Button variant="ghost" size="icon-xs" aria-label={`Set a key for ${title}`} onClick={() => setEditor({ shortcut: null, model: favorite })}>
                      <Pencil />
                    </Button>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      </LayoutSection>

      <LayoutSection>
        <div className="flex flex-col">
          <h2 className="pb-1.5 text-sm font-semibold text-dls-text">Chat</h2>
          <ul aria-label="Chat shortcuts" className="flex flex-col border-t border-dls-border">
            {chatShortcuts.map((entry) => (
              <li key={entry.label} className="flex min-h-11 items-center gap-3 border-b border-dls-border px-1">
                <span className="flex-1 text-sm text-dls-text">{entry.label}</span>
                <span className="flex w-24 shrink-0"><Kbd>{entry.keys}</Kbd></span>
                <span className="w-16 shrink-0" />
              </li>
            ))}
          </ul>
        </div>
      </LayoutSection>
    </LayoutStack>
  );
}
