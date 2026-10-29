"use client";

import {
  AUTO_ROUTER_DEFAULT_PROMPT,
  AUTO_ROUTER_MAX_ROUTES,
  AUTO_ROUTER_PROMPT_MAX_LENGTH,
  AUTO_ROUTER_THINKING_LABELS,
  AUTO_ROUTER_THINKING_LEVELS,
  type AutoRouterModelOption,
  type AutoRouterRoute,
  type AutoRouterRouteWrite,
  type AutoRouterThinkingLevel,
} from "@openwork/types/den/auto-router";
import Link from "next/link";
import { Lock, Pencil, Plus, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import { DenBrandMark } from "../../_components/ui/brand-mark";
import { DenButton, buttonVariants } from "../../_components/ui/button";
import { DenChip } from "../../_components/ui/chip";
import { DenCombobox, type DenComboboxOption } from "../../_components/ui/combobox";
import { DenNotice } from "../../_components/ui/notice";
import { DenSegmented } from "../../_components/ui/segmented";
import { DenSkeleton } from "../../_components/ui/skeleton";
import { DenTextarea } from "../../_components/ui/textarea";
import { getNewAiGatewayProviderRoute, permissionLockReason } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { useAutoRouterOptions, useAutoRouterSettings, useSaveAutoRouter } from "./auto-router-data";
import { AutoRouterSetupDialog } from "./auto-router-setup-dialog";
import { providerIconSlug } from "./library-models";

const VALUE_SEPARATOR = "::";
const LABEL = "w-24 shrink-0 text-[13px] text-gray-500";
const LOCK_REASON = permissionLockReason("gateway_providers.manage");

type ModelRef = { providerId: string; modelId: string };
/** "new" adds a route at the end; a number edits the route at that position. */
type EditorTarget = "new" | number;

function valueOf(ref: ModelRef): string {
  return `${ref.providerId}${VALUE_SEPARATOR}${ref.modelId}`;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function findOption(options: AutoRouterModelOption[], ref: ModelRef): AutoRouterModelOption | null {
  return options.find((option) => option.providerId === ref.providerId && option.modelId === ref.modelId) ?? null;
}

/** The first route is the default model: the server fixes its prompt, so it is never sent. */
function toWrite(route: AutoRouterRoute, isDefault: boolean): AutoRouterRouteWrite {
  const base = { providerId: route.providerId, modelId: route.modelId, thinkingLevel: route.thinkingLevel };
  return isDefault ? base : { ...base, prompt: route.prompt };
}

function sortLevels(levels: Iterable<AutoRouterThinkingLevel>): AutoRouterThinkingLevel[] {
  const chosen = new Set(levels);
  return AUTO_ROUTER_THINKING_LEVELS.filter((level) => chosen.has(level));
}

function countLabel(count: number): string {
  return count === 1 ? "1 model" : `${count} models`;
}

function ModelMark({ providerName, logoProviderId, small = false }: { providerName: string; logoProviderId: string; small?: boolean }) {
  return (
    <DenBrandMark
      name={providerName}
      simpleIconSlug={providerIconSlug(logoProviderId)}
      className={small ? "h-4 w-4 rounded-[4px] border-gray-200" : "h-5 w-5 rounded-[5px] border-gray-200"}
      imageClassName={small ? "h-3 w-3" : "h-3.5 w-3.5"}
    />
  );
}

function RouteEditor({ route, isDefault, saveLabel, options, saving, error, onCancel, onSave }: {
  route: AutoRouterRoute | null;
  /** The default model: its prompt is fixed and shown read only. */
  isDefault: boolean;
  saveLabel: string;
  options: AutoRouterModelOption[];
  saving: boolean;
  error: string | null;
  onCancel: () => void;
  onSave: (route: AutoRouterRouteWrite) => void;
}) {
  const modelLabelId = useId();
  const thinkingLabelId = useId();
  const promptId = useId();
  const initial = route ?? options[0] ?? null;
  const [model, setModel] = useState<ModelRef | null>(initial ? { providerId: initial.providerId, modelId: initial.modelId } : null);
  const [level, setLevel] = useState<AutoRouterThinkingLevel>(route?.thinkingLevel ?? "default");
  const [prompt, setPrompt] = useState(route?.prompt ?? "");

  const option = model ? findOption(options, model) : null;
  // A saved model the gateway no longer offers keeps its level so the form can still be read.
  const allowed = option?.thinkingLevels ?? sortLevels(["default", level]);
  const trimmed = prompt.trim();
  const promptValid = isDefault || (trimmed.length > 0 && trimmed.length <= AUTO_ROUTER_PROMPT_MAX_LENGTH);
  const canSave = Boolean(model && option && allowed.includes(level) && promptValid);

  const comboboxOptions: DenComboboxOption[] = options.map((entry) => ({
    value: valueOf(entry),
    label: entry.modelName,
    description: entry.providerName,
    keywords: [entry.providerName, entry.modelId],
    icon: <ModelMark providerName={entry.providerName} logoProviderId={entry.logoProviderId} />,
  }));
  if (route && !findOption(options, route)) {
    comboboxOptions.unshift({ value: valueOf(route), label: route.modelId, description: "No longer in the AI Gateway" });
  }

  function selectModel(value: string) {
    const next = options.find((entry) => valueOf(entry) === value);
    if (!next) return;
    setModel({ providerId: next.providerId, modelId: next.modelId });
    // Keep the chosen level when the new model allows it; otherwise fall back to the provider default.
    setLevel((current) => (next.thinkingLevels.includes(current) ? current : "default"));
  }

  function save() {
    if (!canSave || !model) return;
    const base = { providerId: model.providerId, modelId: model.modelId, thinkingLevel: level };
    onSave(isDefault ? base : { ...base, prompt: trimmed });
  }

  return (
    <div
      data-testid="auto-router-editor"
      data-default={isDefault ? "true" : undefined}
      className="flex flex-col gap-1 bg-gray-50 px-4 py-3"
    >
      <div className="flex flex-col gap-1.5 pb-1">
        <span className="flex min-h-5 items-center justify-between gap-3">
          {isDefault ? (
            <span id={promptId} className="text-[13px] text-gray-500">Use when</span>
          ) : (
            <label htmlFor={promptId} className="text-[13px] text-gray-500">Use when</label>
          )}
          {isDefault ? <DenChip size="xs">Default model</DenChip> : prompt.length > AUTO_ROUTER_PROMPT_MAX_LENGTH * 0.8 ? (
            <span className="text-[12px] text-gray-500">{`${prompt.length} of ${AUTO_ROUTER_PROMPT_MAX_LENGTH}`}</span>
          ) : null}
        </span>
        {isDefault ? (
          <p
            aria-labelledby={promptId}
            data-testid="auto-router-prompt"
            data-readonly="true"
            className="flex items-start gap-2 rounded-lg bg-gray-100 px-3 py-2 text-[13px] text-gray-700"
          >
            <Lock aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-gray-500" />
            <span>{AUTO_ROUTER_DEFAULT_PROMPT}</span>
          </p>
        ) : (
          <DenTextarea
            id={promptId}
            rows={3}
            value={prompt}
            maxLength={AUTO_ROUTER_PROMPT_MAX_LENGTH}
            disabled={saving}
            required
            placeholder="Quick questions, small edits and short answers"
            data-testid="auto-router-prompt"
            onChange={(event) => setPrompt(event.target.value)}
            className="text-[13px]"
          />
        )}
      </div>

      <div className="flex min-h-10 items-center gap-3">
        <span id={modelLabelId} className={LABEL}>Model</span>
        <div className="min-w-0 flex-1">
          <DenCombobox
            ariaLabel="Model"
            value={model ? valueOf(model) : ""}
            options={comboboxOptions}
            onChange={selectModel}
            disabled={saving}
            placeholder="Choose a model"
            searchPlaceholder="Search models"
            emptyLabel="No models match"
          />
        </div>
      </div>

      <div className="flex min-h-10 items-center gap-3">
        <span id={thinkingLabelId} className={LABEL}>Thinking</span>
        <DenSegmented
          aria-label="Thinking"
          className="flex-wrap"
          options={allowed.map((value) => ({ value, label: AUTO_ROUTER_THINKING_LABELS[value] }))}
          value={level}
          onChange={setLevel}
          optionTestId={(value) => `auto-router-thinking-${value}`}
        />
      </div>

      {error ? <p role="alert" className="pt-1 text-[13px] text-red-700">{error}</p> : null}

      <div className="flex items-center justify-end gap-2 pt-2">
        <DenButton variant="ghost" size="sm" disabled={saving} onClick={onCancel}>Cancel</DenButton>
        <DenButton size="sm" data-testid="auto-router-save-route" loading={saving} disabled={!canSave} onClick={save}>{saveLabel}</DenButton>
      </div>
    </div>
  );
}

function RouteRow({ route, isDefault, option, canEdit, busy, onEdit, onRemove }: {
  route: AutoRouterRoute;
  isDefault: boolean;
  option: AutoRouterModelOption | null;
  canEdit: boolean;
  busy: boolean;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const title = option?.modelName ?? route.modelId;
  const prompt = isDefault ? AUTO_ROUTER_DEFAULT_PROMPT : route.prompt;
  const thinking = `${AUTO_ROUTER_THINKING_LABELS[route.thinkingLevel]} thinking`;
  return (
    <li
      data-testid="auto-router-route"
      data-default={isDefault ? "true" : undefined}
      className="flex min-h-[56px] items-center gap-3 px-4 py-3"
    >
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex min-w-0 items-start gap-2">
          <span className="line-clamp-2 min-w-0 break-words text-[14px] font-medium leading-5 text-gray-900" title={prompt}>{prompt}</span>
          {isDefault ? <DenChip size="xs" className="mt-px shrink-0">Default</DenChip> : null}
        </span>
        <span className="flex min-w-0 items-center gap-2 text-[12px] text-gray-500">
          <span className={option ? "flex shrink-0" : "flex shrink-0 opacity-50"}>
            <ModelMark small providerName={option?.providerName ?? route.providerId} logoProviderId={option?.logoProviderId ?? route.providerId} />
          </span>
          <span className={`truncate font-medium ${option ? "text-gray-700" : "text-gray-500"}`}>{title}</span>
          {option ? <span className="shrink-0">{option.providerName}</span> : (
            <span className="flex shrink-0 items-center gap-1.5">
              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-amber-500" />
              No longer in the AI Gateway
            </span>
          )}
          <span aria-hidden="true" className="h-3 w-px shrink-0 bg-gray-200" />
          <span className="shrink-0 text-gray-600">{thinking}</span>
        </span>
      </span>
      {canEdit ? (
        <span className="flex shrink-0 items-center gap-1">
          <DenButton variant="ghost" size="xs" icon={Pencil} aria-label={isDefault ? "Edit default model" : `Edit route for ${title}`} disabled={busy} onClick={onEdit} />
          {isDefault ? (
            // Keeps the edit buttons of every row in one column.
            <span aria-hidden="true" className="invisible">
              <DenButton variant="ghost" size="xs" icon={Trash2} disabled tabIndex={-1} />
            </span>
          ) : (
            <DenButton variant="ghost" size="xs" icon={Trash2} aria-label={`Remove route for ${title}`} disabled={busy} onClick={onRemove} />
          )}
        </span>
      ) : null}
    </li>
  );
}

function EditorSkeleton() {
  return (
    <div className="flex flex-col gap-3 bg-gray-50 px-4 py-3" aria-hidden="true">
      <DenSkeleton className="h-16 w-full" />
      <div className="flex items-center gap-3">
        <DenSkeleton className="h-8 w-24 shrink-0" />
        <DenSkeleton className="h-8 flex-1" />
      </div>
    </div>
  );
}

/** AI Gateway › Auto Router: the default model, the other models "Auto" may pick, and when to use each. */
export function AutoRouterSection() {
  const { orgId: scopedOrgId, orgSlug } = useOrgDashboard();
  const orgId = scopedOrgId ?? "";
  const settings = useAutoRouterSettings(orgId);
  const options = useAutoRouterOptions(orgId);
  const save = useSaveAutoRouter(orgId);
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  /** Turning on with no routes yet: the default model is chosen first, then saved with `enabled: true`. */
  const [enabling, setEnabling] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [removed, setRemoved] = useState<{ route: AutoRouterRouteWrite; index: number; title: string } | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const missingKeyId = useId();

  async function store(input: { enabled: boolean; routes: AutoRouterRouteWrite[] }): Promise<boolean> {
    setSaveError(null);
    try {
      await save.mutateAsync(input);
      return true;
    } catch (error) {
      setSaveError(errorMessage(error, "Couldn't save the Auto Router. Try again."));
      return false;
    }
  }

  if (settings.isPending) {
    return (
      <section aria-label="Auto Router" aria-busy="true" data-testid="auto-router-section">
        <div className="flex items-center gap-4 rounded-[12px] border border-gray-100 bg-white px-4 py-3" aria-hidden="true">
          <DenSkeleton className="h-4 flex-1" />
          <DenSkeleton className="h-8 w-20 shrink-0 rounded-lg" />
        </div>
      </section>
    );
  }

  if (settings.isError) {
    return (
      <section aria-label="Auto Router" data-testid="auto-router-section">
        <DenNotice
          tone="error"
          message={errorMessage(settings.error, "Couldn't load the Auto Router.")}
          action={<DenButton variant="secondary" size="sm" loading={settings.isFetching} onClick={() => void settings.refetch()}>Try again</DenButton>}
        />
      </section>
    );
  }

  const { enabled, routes, canEdit, routing } = settings.data;
  // Without the gateway's routing key Auto is off: Enable explains how to add it instead.
  const missingKey = routing === "missing_key";
  const setupDialog = <AutoRouterSetupDialog open={setupOpen} onOpenChange={setSetupOpen} />;
  const modelOptions = options.data?.options ?? [];
  const noModels = options.data !== undefined && modelOptions.length === 0;
  const writes = routes.map((route, index) => toWrite(route, index === 0));
  const busy = save.isPending;
  const addProviderLink = (
    <Link href={getNewAiGatewayProviderRoute(orgSlug)} className={buttonVariants({ variant: "secondary", size: "sm" })}>
      Add a provider
    </Link>
  );
  const optionsError = options.isError ? (
    <DenNotice
      className="mb-3"
      tone="error"
      message={errorMessage(options.error, "Couldn't load your AI Gateway models.")}
      action={<DenButton variant="secondary" size="sm" loading={options.isFetching} onClick={() => void options.refetch()}>Try again</DenButton>}
    />
  ) : null;

  if (!enabled) {
    const turnOn = () => {
      // Routes saved before turning off keep their default model, so turning back on needs no choice.
      if (routes.length > 0) void store({ enabled: true, routes: writes });
      else { setSaveError(null); setEnabling(true); }
    };

    if (enabling && canEdit) {
      return (
        <section aria-label="Auto Router" data-testid="auto-router-section" data-state="off">
          {optionsError}
          <div className="overflow-hidden rounded-[12px] border border-gray-100 bg-white">
            {options.isPending ? <EditorSkeleton /> : (
              <RouteEditor
                route={null}
                isDefault
                saveLabel="Turn on"
                options={modelOptions}
                saving={busy}
                error={saveError}
                onCancel={() => { setEnabling(false); setSaveError(null); }}
                onSave={(route) => void store({ enabled: true, routes: [route] }).then((ok) => { if (ok) setEnabling(false); })}
              />
            )}
          </div>
          <p className="mt-2 px-1 text-[12px] text-gray-500">Auto uses the default model when no other prompt matches or it can&apos;t decide.</p>
        </section>
      );
    }

    return (
      <section aria-label="Auto Router" data-testid="auto-router-section" data-state="off">
        <div className="flex items-center gap-4 rounded-[12px] border border-gray-100 bg-white px-4 py-3">
          <p className="min-w-0 flex-1 text-[13px] text-gray-600">
            Sends each prompt to the model that fits it best, from the models you choose here. Members pick Auto in the desktop model picker.
          </p>
          {canEdit ? (
            noModels ? addProviderLink : (
              <DenButton
                size="sm"
                data-testid="auto-router-enable"
                // Muted and explained rather than inert: the click opens the setup steps.
                variant={missingKey ? "secondary" : undefined}
                data-blocked={missingKey ? "missing-key" : undefined}
                aria-describedby={missingKey ? missingKeyId : undefined}
                loading={busy}
                onClick={() => { if (missingKey) { setSetupOpen(true); return; } turnOn(); }}
              >
                Turn on
              </DenButton>
            )
          ) : <span className="shrink-0 text-[12px] text-gray-500">Off</span>}
        </div>
        {canEdit && noModels ? <p className="mt-2 px-1 text-[13px] text-gray-500">Add a provider and its models to the AI Gateway first.</p> : null}
        {canEdit && !noModels && missingKey ? (
          <p id={missingKeyId} data-testid="auto-router-missing-key" className="mt-2 px-1 text-[13px] text-gray-500">
            Needs a routing key on the AI Gateway before it can be turned on.
          </p>
        ) : null}
        {saveError ? <p role="alert" className="mt-2 px-1 text-[13px] text-red-700">{saveError}</p> : null}
        {canEdit ? null : (
          <p className="mt-3 flex items-center gap-2 px-1 text-[13px] text-gray-500">
            <Lock size={16} strokeWidth={1.5} aria-hidden="true" className="shrink-0" />
            {`An admin can turn on the Auto Router. ${LOCK_REASON}`}
          </p>
        )}
        {setupDialog}
      </section>
    );
  }

  async function saveRoute(target: EditorTarget, route: AutoRouterRouteWrite) {
    const next = target === "new" ? [...writes, route] : writes.map((entry, index) => (index === target ? route : entry));
    setRemoved(null);
    if (await store({ enabled: true, routes: next })) setEditor(null);
  }

  async function removeRoute(index: number) {
    const route = writes[index];
    // The default model stays while the Auto Router is on.
    if (!route || index === 0) return;
    const title = findOption(modelOptions, route)?.modelName ?? route.modelId;
    setRemoved(null);
    if (await store({ enabled: true, routes: writes.filter((_, at) => at !== index) })) setRemoved({ route, index, title });
  }

  async function undoRemove() {
    if (!removed) return;
    const next = [...writes];
    next.splice(Math.max(1, Math.min(removed.index, next.length)), 0, removed.route);
    if (await store({ enabled: true, routes: next })) setRemoved(null);
  }

  const atLimit = routes.length >= AUTO_ROUTER_MAX_ROUTES;
  const editorProps = {
    options: modelOptions,
    saving: busy,
    error: editor !== null ? saveError : null,
    onCancel: () => { setEditor(null); setSaveError(null); },
  };
  // Only an organization saved before default models existed can be on with no routes; its first route becomes the default.
  const newIsDefault = routes.length === 0;

  return (
    <section aria-label="Auto Router" data-testid="auto-router-section" data-state="on">
      {optionsError}
      {missingKey ? (
        <div data-testid="auto-router-paused">
          <DenNotice
            className="mb-3"
            tone="warning"
            message="Auto is paused: the AI Gateway is missing its routing key, so members don't see Auto. Routes can't be changed until it's added."
            action={canEdit ? <DenButton variant="secondary" size="sm" data-testid="auto-router-setup-open" onClick={() => setSetupOpen(true)}>How to fix</DenButton> : undefined}
          />
        </div>
      ) : null}

      <div className="flex min-h-9 items-center justify-between gap-3 pb-1.5">
        <span className="flex items-center gap-2">
          <h2 className="text-[14px] font-medium text-gray-900">Routes</h2>
          <span className="text-[12px] text-gray-500">{countLabel(routes.length)}</span>
          <DenChip size="xs">On</DenChip>
        </span>
        {canEdit ? (
          <span className="flex items-center gap-2">
            <DenButton
              variant="secondary"
              size="sm"
              data-testid="auto-router-disable"
              disabled={busy}
              onClick={() => { setEditor(null); setRemoved(null); void store({ enabled: false, routes: writes }); }}
            >
              Turn off
            </DenButton>
            {noModels ? null : (
              <DenButton
                size="sm"
                icon={Plus}
                data-testid="auto-router-add"
                disabled={busy || missingKey || editor === "new" || atLimit || options.isPending || options.isError}
                title={atLimit ? `Up to ${AUTO_ROUTER_MAX_ROUTES} models` : undefined}
                onClick={() => { setSaveError(null); setRemoved(null); setEditor("new"); }}
              >
                {newIsDefault ? "Choose default model" : "Add model"}
              </DenButton>
            )}
          </span>
        ) : null}
      </div>

      {canEdit && noModels ? (
        <DenNotice
          className="mb-3"
          tone="neutral"
          presentation="inline"
          message="Add a provider and its models to the AI Gateway first, then choose them here."
          action={addProviderLink}
        />
      ) : null}

      <ul aria-label="Routes" className="divide-y divide-gray-100 overflow-hidden rounded-[12px] border border-gray-100 bg-white">
        {routes.length === 0 && editor !== "new" ? (
          <li className="px-4 py-4 text-[13px] text-gray-500">
            {canEdit ? "No default model yet. Choose one so Auto always has a model to use." : "No default model yet."}
          </li>
        ) : null}
        {routes.map((route, index) => editor === index ? (
          <li key={route.id}>
            <RouteEditor route={route} isDefault={index === 0} saveLabel="Save route" {...editorProps} onSave={(next) => void saveRoute(index, next)} />
          </li>
        ) : (
          <RouteRow
            key={route.id}
            route={route}
            isDefault={index === 0}
            option={findOption(modelOptions, route)}
            canEdit={canEdit}
            busy={busy || missingKey || editor !== null}
            onEdit={() => { setSaveError(null); setRemoved(null); setEditor(index); }}
            onRemove={() => void removeRoute(index)}
          />
        ))}
        {editor === "new" ? (
          <li>
            {options.isPending ? <EditorSkeleton /> : (
              <RouteEditor route={null} isDefault={newIsDefault} saveLabel="Save route" {...editorProps} onSave={(next) => void saveRoute("new", next)} />
            )}
          </li>
        ) : null}
      </ul>

      {removed ? (
        <div role="status" className="mt-2 flex items-center justify-between gap-3 px-1 text-[13px] text-gray-600">
          <span className="min-w-0 truncate">{`Removed ${removed.title}.`}</span>
          <DenButton variant="ghost" size="xs" loading={busy} onClick={() => void undoRemove()}>Undo</DenButton>
        </div>
      ) : null}
      {saveError && editor === null ? <p role="alert" className="mt-2 px-1 text-[13px] text-red-700">{saveError}</p> : null}
      <p className="mt-2 px-1 text-[12px] text-gray-500">
        Auto uses the default model when no other prompt matches or it can&apos;t decide. You can change the default model, but it stays while the Auto Router is on.
      </p>
      {canEdit ? null : (
        <p className="mt-3 flex items-center gap-2 px-1 text-[13px] text-gray-500">
          <Lock size={16} strokeWidth={1.5} aria-hidden="true" className="shrink-0" />
          {`Read only. ${LOCK_REASON}`}
        </p>
      )}
      {setupDialog}
    </section>
  );
}
