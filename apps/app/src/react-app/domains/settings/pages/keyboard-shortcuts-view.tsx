/** @jsxImportSource react */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type * as React from "react";
import { ChevronDown, Lock, Pencil, Plus, RotateCcw, Trash2, X, Zap } from "lucide-react";
import { FAST_DEFAULT_VARIANT, FAST_VARIANT_PREFIX } from "@openwork/types/cloud-model-fast";

import type { Client, ModelOption, ModelRef } from "@/app/types";
import { isDesktopProviderBlocked } from "@/app/cloud/desktop-app-restrictions";
import { listCommands } from "@/app/lib/opencode-session";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { toast } from "@/components/ui/sonner";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { ProviderIcon } from "@/react-app/design-system/provider-icon";
import { useCheckDesktopRestriction } from "@/react-app/domains/cloud/desktop-config-provider";
import { modelRefKey, useModelCollectionsStore } from "@/react-app/domains/session/models/model-collections-store";
import { ModelPickerList } from "@/react-app/domains/models/model-picker-list";
import { runtimeModelOptions } from "@/react-app/domains/models/catalog";
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
  builtInChords,
  formatChord,
  nextFreeChord,
  resolveShortcutOs,
  type ShortcutOs,
} from "@/react-app/domains/shortcuts/shortcut-keys";
import { SHORTCUT_RECORDER_ATTRIBUTE } from "@/react-app/domains/shortcuts/use-model-shortcut-keys";
import {
  APP_ACTIONS,
  actionChordProblem,
  actionChordProblemMessage,
  actionKeys,
  createSkillShortcutId,
  useActionShortcutsStore,
  type AppActionDefinition,
  type AppActionId,
  type SkillShortcut,
} from "@/react-app/kernel/app-actions";
import { getConnectedProviderItems, useProviderListQuery } from "@/react-app/infra/provider-list-query";
import { usePlatform } from "@/react-app/kernel/platform";
import { favoriteModelShortcutLabel } from "@/react-app/shell/favorite-model-shortcut";
import { fastModeShortcutLabel } from "@/react-app/shell/fast-mode-shortcut";
import { resolveThinkingModeShortcutOs, thinkingModeShortcutLabel } from "@/react-app/shell/thinking-mode-shortcut";

import { LayoutSection, LayoutStack } from "../settings-layout";

type CatalogModel = ModelRef & {
  title: string;
  providerName: string;
  behaviorOptions: Array<{ value: string | null; label: string }>;
};

export type KeyboardShortcutsViewProps = {
  client: Client | null;
  pickerOptions?: readonly ModelOption[];
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
  pickerOptions: readonly ModelOption[];
  savedKeys: Set<string>;
  shortcuts: Shortcut[];
  actionChords: ReadonlyArray<{ chord: string; label: string }>;
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
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");

  const model = models.find((entry) => modelRefKey(entry) === modelKey) ?? null;
  const storedTitle = target.shortcut?.action.modelTitle ?? target.shortcut?.action.modelID ?? null;
  const efforts = standardEffortOptions(model);
  const fastOffered = offersFast(model);
  const conflict = keys
    ? props.shortcuts.find((entry) => entry.keys === keys && entry.id !== target.shortcut?.id
      && modelRefKey({ providerID: entry.action.providerID, modelID: entry.action.modelID }) !== modelKey) ?? null
    : null;
  const conflictTitle = conflict ? conflict.action.modelTitle ?? conflict.action.modelID : null;
  const modelRef = model ?? initialModel;
  const modelLabel = model?.title ?? (modelKey ? storedTitle ?? modelKey : null);

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
    const action = props.actionChords.find((entry) => entry.chord === chord);
    if (action) {
      setRecordError(`${formatChord(chord, os)} is used for ${action.label.toLowerCase()}.`);
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
        <Popover open={pickerOpen} onOpenChange={(open) => { setPickerOpen(open); if (!open) setPickerQuery(""); }}>
          <PopoverTrigger render={<Button variant="outline" className="min-w-0 flex-1 justify-between font-normal" aria-label="Model" />}>
            <span className="flex min-w-0 items-center gap-2">
              {modelRef ? <ProviderIcon providerId={modelRef.providerID} providerName={model?.providerName} size={16} /> : null}
              <span className={cn("truncate", !modelLabel && "text-dls-secondary")}>{modelLabel ?? "Choose a model"}</span>
            </span>
            <ChevronDown className="size-4 shrink-0 text-dls-secondary" />
          </PopoverTrigger>
          <PopoverContent align="start" data-testid="shortcut-model-picker"
            className="flex max-h-[min(var(--available-height),28rem)] w-90 max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-2xl p-0">
            <ModelPickerList options={props.pickerOptions} current={modelRef ?? { providerID: "", modelID: "" }}
              query={pickerQuery} onQueryChange={setPickerQuery}
              onSelect={(option) => { selectModel(modelRefKey(option)); setPickerOpen(false); setPickerQuery(""); }} />
          </PopoverContent>
        </Popover>
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

type TakenChord = { chord: string; label: string };

function KeyRecorder(props: {
  keys: string | null;
  os: ShortcutOs;
  label: string;
  autoRecord?: boolean;
  onRecord: (chord: string) => string | null;
  onCancel?: () => void;
}) {
  const [recording, setRecording] = useState(props.autoRecord ?? false);
  const [error, setError] = useState<string | null>(null);

  const stop = () => {
    setRecording(false);
    setError(null);
  };

  const handleKey = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!recording) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      stop();
      props.onCancel?.();
      return;
    }
    const chord = chordFromEvent(event.nativeEvent, props.os);
    if (!chord) return;
    const problem = props.onRecord(chord);
    if (problem) {
      setError(problem);
      return;
    }
    stop();
  };

  return (
    <span className="flex min-w-0 flex-1 items-center justify-end gap-2">
      <span role="status" className="min-w-0 truncate text-xs text-dls-secondary">{recording ? error ?? "" : ""}</span>
      <button
        type="button"
        autoFocus={props.autoRecord}
        {...{ [SHORTCUT_RECORDER_ATTRIBUTE]: recording ? "recording" : "idle" }}
        aria-label={recording ? `Press the new key for ${props.label}` : props.keys ? `${props.label}: ${formatChord(props.keys, props.os)}. Change key` : `Set a key for ${props.label}`}
        className={cn(
          "inline-flex h-7 min-w-20 shrink-0 items-center justify-center rounded-md border px-2 font-mono text-xs transition-colors",
          recording
            ? "border-dls-accent text-dls-secondary ring-2 ring-dls-accent/15"
            : props.keys
              ? "border-dls-border bg-dls-hover text-dls-text hover:bg-dls-surface"
              : "border-dashed border-dls-border text-dls-secondary hover:bg-dls-hover",
        )}
        onClick={() => { setRecording(true); setError(null); }}
        onKeyDown={handleKey}
        onBlur={() => {
          if (recording) props.onCancel?.();
          stop();
        }}
      >
        {recording ? "Press keys…" : props.keys ? formatChord(props.keys, props.os) : "Set key"}
      </button>
    </span>
  );
}

function SkillPicker(props: { client: Client | null; directory: string; taken: Set<string>; onPick: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const commandsQuery = useQuery({
    queryKey: ["shortcut-skill-commands", props.directory],
    queryFn: () => (props.client ? listCommands(props.client, props.directory || undefined) : Promise.resolve([])),
    enabled: open && Boolean(props.client),
  });
  const needle = query.trim().toLowerCase();
  const options = (commandsQuery.data ?? [])
    .filter((command) => command.name && command.source !== "mcp" && !props.taken.has(command.name))
    .filter((command) => !needle || command.name.toLowerCase().includes(needle) || command.description?.toLowerCase().includes(needle))
    .sort((a, b) => Number(b.source === "skill") - Number(a.source === "skill") || a.name.localeCompare(b.name));

  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (!next) setQuery(""); }}>
      <PopoverTrigger render={<Button size="sm" disabled={!props.client} />}>
        <Plus data-icon="inline-start" />
        Add skill shortcut
      </PopoverTrigger>
      <PopoverContent align="end" className="flex max-h-[min(var(--available-height),24rem)] w-80 flex-col gap-1 overflow-hidden rounded-xl p-1.5">
        <Input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search skills" aria-label="Search skills" className="h-8" />
        <ul aria-label="Skills" className="flex min-h-0 flex-col overflow-y-auto">
          {commandsQuery.isPending ? <li className="px-2 py-3 text-sm text-dls-secondary">Loading skills…</li> : null}
          {!commandsQuery.isPending && options.length === 0 ? (
            <li className="px-2 py-3 text-sm text-dls-secondary">{needle ? "No matching skills." : "No skills in this workspace yet."}</li>
          ) : null}
          {options.map((command) => (
            <li key={command.id}>
              <button
                type="button"
                className="flex w-full flex-col items-start rounded-md px-2 py-1.5 text-left hover:bg-dls-hover"
                onClick={() => { setOpen(false); setQuery(""); props.onPick(command.name); }}
              >
                <span className="text-sm text-dls-text">/{command.name}</span>
                {command.description ? <span className="line-clamp-1 text-xs text-dls-secondary">{command.description}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

function ActionShortcutsSection(props: {
  os: ShortcutOs;
  client: Client | null;
  directory: string;
  takenElsewhere: readonly TakenChord[];
}) {
  const { os } = props;
  const overrides = useActionShortcutsStore((state) => state.overrides);
  const skills = useActionShortcutsStore((state) => state.skills);
  const setActionKeys = useActionShortcutsStore((state) => state.setActionKeys);
  const resetAction = useActionShortcutsStore((state) => state.resetAction);
  const saveSkill = useActionShortcutsStore((state) => state.saveSkill);
  const removeSkill = useActionShortcutsStore((state) => state.removeSkill);
  const [pendingSkill, setPendingSkill] = useState<string | null>(null);
  const state = useMemo(() => ({ overrides, skills }), [overrides, skills]);

  const problemFor = (chord: string, ignore: { actionId?: AppActionId; skillId?: string }) => {
    const problem = actionChordProblem({ chord, state, takenElsewhere: props.takenElsewhere, ignore });
    return problem ? actionChordProblemMessage(problem, os) : null;
  };

  const clearAction = (definition: AppActionDefinition, previous: string) => {
    const wasOverridden = definition.id in overrides;
    setActionKeys(definition.id, null);
    toast(`Removed ${formatChord(previous, os)} from ${definition.label}`, {
      action: { label: "Undo", onClick: () => (wasOverridden ? setActionKeys(definition.id, previous) : resetAction(definition.id)) },
    });
  };

  const removeSkillShortcut = (skill: SkillShortcut) => {
    removeSkill(skill.id);
    toast(`Removed ${formatChord(skill.keys, os)} from /${skill.name}`, {
      action: { label: "Undo", onClick: () => saveSkill(skill) },
    });
  };

  return (
    <>
      <LayoutSection>
        <div className="flex flex-col">
          <h2 className="pb-1.5 text-sm font-semibold text-dls-text">Actions</h2>
          <ul aria-label="Action shortcuts" className="flex flex-col border-t border-dls-border">
            {APP_ACTIONS.map((definition) => {
              const keys = actionKeys(state, definition.id);
              const overridden = definition.id in overrides;
              return (
                <li key={definition.id} data-testid="action-shortcut-row" data-action={definition.id} className="flex min-h-11 items-center gap-3 border-b border-dls-border px-1">
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-sm text-dls-text">{definition.label}</span>
                    {overridden && definition.defaultKeys ? (
                      <span className="text-xs text-dls-secondary">Default {formatChord(definition.defaultKeys, os)}</span>
                    ) : null}
                  </span>
                  {definition.fixedKeys ? (
                    <span className="shrink-0 text-xs text-dls-secondary" title={`${definition.fixedKeys.source} key, always on`}>
                      {formatChord(definition.fixedKeys.chord, os)} · {definition.fixedKeys.source}
                    </span>
                  ) : null}
                  <KeyRecorder
                    keys={keys}
                    os={os}
                    label={definition.label}
                    onRecord={(chord) => {
                      const problem = problemFor(chord, { actionId: definition.id });
                      if (!problem) setActionKeys(definition.id, chord);
                      return problem;
                    }}
                  />
                  <span className="flex w-16 shrink-0 justify-end gap-1">
                    {overridden && definition.defaultKeys ? (
                      <Button variant="ghost" size="icon-xs" aria-label={`Reset ${definition.label} to ${formatChord(definition.defaultKeys, os)}`} title="Reset to default" onClick={() => resetAction(definition.id)}>
                        <RotateCcw />
                      </Button>
                    ) : null}
                    {keys ? (
                      <Button variant="ghost" size="icon-xs" aria-label={`Clear key for ${definition.label}`} title="Clear key" onClick={() => clearAction(definition, keys)}>
                        <X />
                      </Button>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      </LayoutSection>

      <LayoutSection>
        <div className="flex flex-col">
          <div className="flex min-h-9 items-center justify-between gap-3 pb-1.5">
            <div className="flex items-baseline gap-2">
              <h2 className="text-sm font-semibold text-dls-text">Skills</h2>
              <span className="text-xs text-dls-secondary">Puts the skill in the message box</span>
            </div>
            <SkillPicker
              client={props.client}
              directory={props.directory}
              taken={new Set(skills.map((skill) => skill.name))}
              onPick={setPendingSkill}
            />
          </div>
          <ul aria-label="Skill shortcuts" className="flex flex-col border-t border-dls-border">
            {skills.length === 0 && !pendingSkill ? (
              <li className="py-4 text-sm text-dls-secondary">No skill shortcuts yet. Add one to start a skill with a key.</li>
            ) : null}
            {skills.map((skill) => (
              <li key={skill.id} data-testid="skill-shortcut-row" className="flex min-h-11 items-center gap-3 border-b border-dls-border px-1">
                <span className="min-w-0 truncate text-sm text-dls-text">/{skill.name}</span>
                <KeyRecorder
                  keys={skill.keys}
                  os={os}
                  label={`/${skill.name}`}
                  onRecord={(chord) => {
                    const problem = problemFor(chord, { skillId: skill.id });
                    if (!problem) saveSkill({ ...skill, keys: chord });
                    return problem;
                  }}
                />
                <span className="flex w-16 shrink-0 justify-end">
                  <Button variant="ghost" size="icon-xs" aria-label={`Remove shortcut for /${skill.name}`} onClick={() => removeSkillShortcut(skill)}>
                    <Trash2 />
                  </Button>
                </span>
              </li>
            ))}
            {pendingSkill ? (
              <li data-testid="skill-shortcut-row" data-state="pending" className="flex min-h-11 items-center gap-3 border-b border-dls-border px-1">
                <span className="min-w-0 truncate text-sm text-dls-text">/{pendingSkill}</span>
                <KeyRecorder
                  keys={null}
                  os={os}
                  label={`/${pendingSkill}`}
                  autoRecord
                  onCancel={() => setPendingSkill(null)}
                  onRecord={(chord) => {
                    const problem = problemFor(chord, {});
                    if (problem) return problem;
                    saveSkill({ id: createSkillShortcutId(), name: pendingSkill, keys: chord });
                    setPendingSkill(null);
                    return null;
                  }}
                />
                <span className="flex w-16 shrink-0 justify-end">
                  <Button variant="ghost" size="icon-xs" aria-label="Cancel" onClick={() => setPendingSkill(null)}>
                    <X />
                  </Button>
                </span>
              </li>
            ) : null}
          </ul>
        </div>
      </LayoutSection>
    </>
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
  const actionOverrides = useActionShortcutsStore((state) => state.overrides);
  const skillShortcuts = useActionShortcutsStore((state) => state.skills);
  const actionChords = useMemo(() => {
    const state = { overrides: actionOverrides, skills: skillShortcuts };
    return [
      ...APP_ACTIONS.flatMap((definition) => {
        const keys = actionKeys(state, definition.id);
        return [
          ...(keys && keys !== definition.defaultKeys ? [{ chord: keys, label: definition.label }] : []),
          ...(definition.fixedKeys ? [{ chord: definition.fixedKeys.chord, label: definition.label }] : []),
        ];
      }),
      ...skillShortcuts.map((skill) => ({ chord: skill.keys, label: `/${skill.name}` })),
    ];
  }, [actionOverrides, skillShortcuts]);
  const actionDefaults = useMemo(() => new Set(APP_ACTIONS.flatMap((definition) => (definition.defaultKeys ? [definition.defaultKeys] : []))), []);
  const takenByOthers = useMemo(() => [
    ...builtInChords(os).filter((entry) => !actionDefaults.has(entry.chord)),
    ...shortcuts.map((shortcut) => ({ chord: shortcut.keys, label: shortcut.action.modelTitle ?? shortcut.action.modelID })),
  ], [actionDefaults, os, shortcuts]);
  const catalogQuery = useProviderListQuery({
    client: props.client,
    baseUrl: props.baseUrl,
    directory: props.directory || undefined,
    enabled: Boolean(props.client),
  });
  const catalog = catalogQuery.data;
  const rowCatalog = useMemo(() => (catalog ? { all: catalog.all ?? [], connected: getConnectedProviderItems(catalog) } : null), [catalog]);

  const runtimeOptions = useMemo(() => (catalog ? runtimeModelOptions(catalog) : []), [catalog]);
  const pickerOptions = props.pickerOptions?.length ? props.pickerOptions : runtimeOptions;
  const models = useMemo<CatalogModel[]>(() => pickerOptions.filter((option) => !option.disabled).map((option) => ({
    providerID: option.providerID,
    modelID: option.modelID,
    title: option.title,
    providerName: option.description ?? option.providerID,
    behaviorOptions: option.behaviorOptions ?? [],
  })).sort((a, b) => a.title.localeCompare(b.title)), [pickerOptions]);
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
    { label: "Next saved model", keys: os === "macos" ? "⌃⇧M" : favoriteModelShortcutLabel },
    { label: "Cycle reasoning", keys: thinkingModeShortcutLabel(thinkingOs) },
    { label: "Toggle Fast", keys: fastModeShortcutLabel(thinkingOs) },
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
              <ShortcutEditor target={editor} os={os} models={models} pickerOptions={pickerOptions} savedKeys={savedKeys} shortcuts={shortcuts} actionChords={actionChords} onCancel={() => setEditor(null)} onSave={handleSave} />
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
                    <ShortcutEditor target={editor} os={os} models={models} pickerOptions={pickerOptions} savedKeys={savedKeys} shortcuts={shortcuts} actionChords={actionChords} onCancel={() => setEditor(null)} onSave={handleSave} />
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
                    <ShortcutEditor target={editor} os={os} models={models} pickerOptions={pickerOptions} savedKeys={savedKeys} shortcuts={shortcuts} actionChords={actionChords} onCancel={() => setEditor(null)} onSave={handleSave} />
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

      <ActionShortcutsSection os={os} client={props.client} directory={props.directory} takenElsewhere={takenByOthers} />

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
