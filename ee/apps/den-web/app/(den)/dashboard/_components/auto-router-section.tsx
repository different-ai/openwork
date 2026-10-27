"use client";

import {
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
import { useId, useState, type ReactNode } from "react";
import { DenBrandMark } from "../../_components/ui/brand-mark";
import { DenButton, buttonVariants } from "../../_components/ui/button";
import { DenChip } from "../../_components/ui/chip";
import { DenCombobox, type DenComboboxOption } from "../../_components/ui/combobox";
import { DenNotice } from "../../_components/ui/notice";
import { DenSkeleton } from "../../_components/ui/skeleton";
import { DenTextarea } from "../../_components/ui/textarea";
import { getNewAiGatewayProviderRoute, permissionLockReason } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { useAutoRouterOptions, useAutoRouterSettings, useSaveAutoRouter } from "./auto-router-data";
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

function toWrite(route: AutoRouterRoute): AutoRouterRouteWrite {
  return { providerId: route.providerId, modelId: route.modelId, prompt: route.prompt, thinkingLevels: route.thinkingLevels };
}

function sortLevels(levels: Iterable<AutoRouterThinkingLevel>): AutoRouterThinkingLevel[] {
  const chosen = new Set(levels);
  return AUTO_ROUTER_THINKING_LEVELS.filter((level) => chosen.has(level));
}

function levelsLabel(levels: AutoRouterThinkingLevel[]): string {
  return sortLevels(levels).map((level) => AUTO_ROUTER_THINKING_LABELS[level]).join(", ");
}

function countLabel(count: number): string {
  return count === 1 ? "1 model" : `${count} models`;
}

function ModelMark({ providerName, logoProviderId }: { providerName: string; logoProviderId: string }) {
  return (
    <DenBrandMark
      name={providerName}
      simpleIconSlug={providerIconSlug(logoProviderId)}
      className="h-5 w-5 rounded-[5px] border-gray-200"
      imageClassName="h-3.5 w-3.5"
    />
  );
}

function ThinkingToggles({ allowed, selected, onToggle, labelId }: {
  allowed: AutoRouterThinkingLevel[];
  selected: Set<AutoRouterThinkingLevel>;
  onToggle: (level: AutoRouterThinkingLevel) => void;
  labelId: string;
}) {
  return (
    <div role="group" aria-labelledby={labelId} className="inline-flex flex-wrap items-center gap-0.5 rounded-lg bg-gray-100 p-0.5">
      {allowed.map((level) => {
        const pressed = selected.has(level);
        return (
          <button
            key={level}
            type="button"
            aria-pressed={pressed}
            data-testid={`auto-router-thinking-${level}`}
            onClick={() => onToggle(level)}
            className={[
              "rounded-md px-3 py-1 text-[12px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-gray-400",
              pressed ? "bg-white text-gray-900 shadow-[0_1px_2px_0_rgba(15,23,42,0.06)]" : "text-gray-500 hover:text-gray-900",
            ].join(" ")}
          >
            {AUTO_ROUTER_THINKING_LABELS[level]}
          </button>
        );
      })}
    </div>
  );
}

function RouteEditor({ route, options, saving, error, onCancel, onSave }: {
  route: AutoRouterRoute | null;
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
  const [levels, setLevels] = useState<Set<AutoRouterThinkingLevel>>(new Set(route?.thinkingLevels ?? ["default"]));
  const [prompt, setPrompt] = useState(route?.prompt ?? "");

  const option = model ? findOption(options, model) : null;
  // A saved model the gateway no longer offers keeps its levels so the row can still be read.
  const allowed = option?.thinkingLevels ?? (route ? sortLevels(route.thinkingLevels) : ["default"]);
  const chosen = sortLevels([...levels].filter((level) => allowed.includes(level)));
  const trimmed = prompt.trim();
  const canSave = Boolean(model && option && chosen.length > 0 && trimmed.length > 0 && trimmed.length <= AUTO_ROUTER_PROMPT_MAX_LENGTH);

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
    const kept = [...levels].filter((level) => next.thinkingLevels.includes(level));
    setLevels(new Set(kept.length > 0 ? kept : ["default"]));
  }

  function toggle(level: AutoRouterThinkingLevel) {
    setLevels((current) => {
      const next = new Set(current);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });
  }

  function save() {
    if (!canSave || !model) return;
    onSave({ providerId: model.providerId, modelId: model.modelId, prompt: trimmed, thinkingLevels: chosen });
  }

  return (
    <div data-testid="auto-router-editor" className="flex flex-col gap-1 bg-gray-50 px-4 py-3">
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
        <ThinkingToggles allowed={allowed} selected={new Set(chosen)} onToggle={toggle} labelId={thinkingLabelId} />
        {chosen.length === 0 ? <span role="status" className="text-[12px] text-gray-500">Choose at least one</span> : null}
      </div>

      <div className="flex flex-col gap-1.5 pt-1">
        <span className="flex items-center justify-between gap-3">
          <label htmlFor={promptId} className="text-[13px] text-gray-500">Use when</label>
          {prompt.length > AUTO_ROUTER_PROMPT_MAX_LENGTH * 0.8 ? (
            <span className="text-[12px] text-gray-500">{`${prompt.length} of ${AUTO_ROUTER_PROMPT_MAX_LENGTH}`}</span>
          ) : null}
        </span>
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
      </div>

      {error ? <p role="alert" className="pt-1 text-[13px] text-red-700">{error}</p> : null}

      <div className="flex items-center justify-end gap-2 pt-2">
        <DenButton variant="ghost" size="sm" disabled={saving} onClick={onCancel}>Cancel</DenButton>
        <DenButton size="sm" data-testid="auto-router-save-route" loading={saving} disabled={!canSave} onClick={save}>Save route</DenButton>
      </div>
    </div>
  );
}

function RouteRow({ route, option, canEdit, busy, onEdit, onRemove }: {
  route: AutoRouterRoute;
  option: AutoRouterModelOption | null;
  canEdit: boolean;
  busy: boolean;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const title = option?.modelName ?? route.modelId;
  return (
    <li data-testid="auto-router-route" className="flex min-h-[52px] items-center gap-3 px-4 py-2.5">
      <span className={option ? "" : "opacity-50"}>
        <ModelMark providerName={option?.providerName ?? route.providerId} logoProviderId={option?.logoProviderId ?? route.providerId} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className={`truncate text-[13px] font-medium ${option ? "text-gray-900" : "text-gray-500"}`}>{title}</span>
          {option ? <span className="shrink-0 text-[12px] text-gray-500">{option.providerName}</span> : (
            <span className="flex shrink-0 items-center gap-1.5 text-[12px] text-gray-500">
              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-amber-500" />
              No longer in the AI Gateway
            </span>
          )}
        </span>
        <span className="block truncate text-[12px] text-gray-500" title={route.prompt}>{route.prompt}</span>
      </span>
      <span className="hidden w-40 shrink-0 truncate text-[12px] text-gray-600 md:block" aria-label={`Thinking: ${levelsLabel(route.thinkingLevels)}`}>
        {levelsLabel(route.thinkingLevels)}
      </span>
      {canEdit ? (
        <span className="flex shrink-0 items-center gap-1">
          <DenButton variant="ghost" size="xs" icon={Pencil} aria-label={`Edit route for ${title}`} disabled={busy} onClick={onEdit} />
          <DenButton variant="ghost" size="xs" icon={Trash2} aria-label={`Remove route for ${title}`} disabled={busy} onClick={onRemove} />
        </span>
      ) : null}
    </li>
  );
}

function SectionHeading({ id, children }: { id: string; children?: ReactNode }) {
  return (
    <div className="mb-3 flex min-h-8 items-center justify-between gap-4">
      <h2 id={id} className="text-[14px] font-medium text-gray-900">Auto Router</h2>
      {children}
    </div>
  );
}

/** AI Gateway › AI Providers › Auto Router: the models "Auto" may pick, and when to use each. */
export function AutoRouterSection() {
  const { orgId: scopedOrgId, orgSlug } = useOrgDashboard();
  const orgId = scopedOrgId ?? "";
  const headingId = useId();
  const settings = useAutoRouterSettings(orgId);
  const options = useAutoRouterOptions(orgId);
  const save = useSaveAutoRouter(orgId);
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [removed, setRemoved] = useState<{ route: AutoRouterRouteWrite; index: number; title: string } | null>(null);

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
      <section aria-labelledby={headingId} aria-busy="true" className="mb-8" data-testid="auto-router-section">
        <SectionHeading id={headingId} />
        <div className="flex items-center gap-4 rounded-[12px] border border-gray-100 bg-white px-4 py-3" aria-hidden="true">
          <DenSkeleton className="h-4 flex-1" />
          <DenSkeleton className="h-8 w-20 shrink-0 rounded-lg" />
        </div>
      </section>
    );
  }

  if (settings.isError) {
    return (
      <section aria-labelledby={headingId} className="mb-8" data-testid="auto-router-section">
        <SectionHeading id={headingId} />
        <DenNotice
          tone="error"
          message={errorMessage(settings.error, "Couldn't load the Auto Router.")}
          action={<DenButton variant="secondary" size="sm" loading={settings.isFetching} onClick={() => void settings.refetch()}>Try again</DenButton>}
        />
      </section>
    );
  }

  const { enabled, routes, canEdit } = settings.data;
  const modelOptions = options.data?.options ?? [];
  const noModels = options.data !== undefined && modelOptions.length === 0;
  const writes = routes.map(toWrite);
  const busy = save.isPending;
  const lockLine = canEdit ? null : (
    <p className="mt-3 flex items-center gap-2 px-1 text-[13px] text-gray-500">
      <Lock size={16} strokeWidth={1.5} aria-hidden="true" className="shrink-0" />
      {`Read only. ${LOCK_REASON}`}
    </p>
  );
  const addProviderLink = (
    <Link href={getNewAiGatewayProviderRoute(orgSlug)} className={buttonVariants({ variant: "secondary", size: "sm" })}>
      Add a provider
    </Link>
  );

  if (!enabled) {
    return (
      <section aria-labelledby={headingId} className="mb-8" data-testid="auto-router-section" data-state="off">
        <SectionHeading id={headingId} />
        <div className="flex items-center gap-4 rounded-[12px] border border-gray-100 bg-white px-4 py-3">
          <p className="min-w-0 flex-1 text-[13px] text-gray-600">
            Sends each prompt to the model that fits it best, from the models you choose here. Members pick Auto in the desktop model picker.
          </p>
          {canEdit ? (
            noModels ? addProviderLink : (
              <DenButton
                size="sm"
                data-testid="auto-router-enable"
                loading={busy}
                onClick={() => void store({ enabled: true, routes: writes }).then((ok) => { if (ok && routes.length === 0) setEditor("new"); })}
              >
                Enable
              </DenButton>
            )
          ) : <span className="shrink-0 text-[12px] text-gray-500">Off</span>}
        </div>
        {canEdit && noModels ? <p className="mt-2 px-1 text-[13px] text-gray-500">Add a provider and its models to the AI Gateway first.</p> : null}
        {saveError ? <p role="alert" className="mt-2 px-1 text-[13px] text-red-700">{saveError}</p> : null}
        {canEdit ? null : (
          <p className="mt-3 flex items-center gap-2 px-1 text-[13px] text-gray-500">
            <Lock size={16} strokeWidth={1.5} aria-hidden="true" className="shrink-0" />
            {`An admin can turn on the Auto Router. ${LOCK_REASON}`}
          </p>
        )}
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
    if (!route) return;
    const title = findOption(modelOptions, route)?.modelName ?? route.modelId;
    setRemoved(null);
    if (await store({ enabled: true, routes: writes.filter((_, at) => at !== index) })) setRemoved({ route, index, title });
  }

  async function undoRemove() {
    if (!removed) return;
    const next = [...writes];
    next.splice(Math.min(removed.index, next.length), 0, removed.route);
    if (await store({ enabled: true, routes: next })) setRemoved(null);
  }

  const atLimit = routes.length >= AUTO_ROUTER_MAX_ROUTES;
  const editorError = editor !== null ? saveError : null;
  const editorProps = {
    options: modelOptions,
    saving: busy,
    error: editorError,
    onCancel: () => { setEditor(null); setSaveError(null); },
  };

  return (
    <section aria-labelledby={headingId} className="mb-8" data-testid="auto-router-section" data-state="on">
      <SectionHeading id={headingId}>
        <span className="flex items-center gap-2">
          <DenChip size="xs">On</DenChip>
          {canEdit ? (
            <DenButton
              variant="secondary"
              size="sm"
              data-testid="auto-router-disable"
              disabled={busy}
              onClick={() => { setEditor(null); setRemoved(null); void store({ enabled: false, routes: writes }); }}
            >
              Turn off
            </DenButton>
          ) : null}
        </span>
      </SectionHeading>

      {options.isError ? (
        <DenNotice
          className="mb-3"
          tone="error"
          message={errorMessage(options.error, "Couldn't load your AI Gateway models.")}
          action={<DenButton variant="secondary" size="sm" loading={options.isFetching} onClick={() => void options.refetch()}>Try again</DenButton>}
        />
      ) : null}

      <div className="flex min-h-9 items-center justify-between gap-3 pb-1.5">
        <span className="flex items-baseline gap-2">
          <h3 className="text-[13px] font-medium text-gray-900">Routes</h3>
          <span className="text-[12px] text-gray-500">{countLabel(routes.length)}</span>
        </span>
        {canEdit && !noModels ? (
          <DenButton
            size="sm"
            icon={Plus}
            data-testid="auto-router-add"
            disabled={busy || editor === "new" || atLimit || options.isPending || options.isError}
            title={atLimit ? `Up to ${AUTO_ROUTER_MAX_ROUTES} models` : undefined}
            onClick={() => { setSaveError(null); setRemoved(null); setEditor("new"); }}
          >
            Add model
          </DenButton>
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
            {canEdit ? "No models yet. Add one so Auto has a model to pick." : "No models yet."}
          </li>
        ) : null}
        {routes.map((route, index) => editor === index ? (
          <li key={route.id}>
            <RouteEditor route={route} {...editorProps} onSave={(next) => void saveRoute(index, next)} />
          </li>
        ) : (
          <RouteRow
            key={route.id}
            route={route}
            option={findOption(modelOptions, route)}
            canEdit={canEdit}
            busy={busy || editor !== null}
            onEdit={() => { setSaveError(null); setRemoved(null); setEditor(index); }}
            onRemove={() => void removeRoute(index)}
          />
        ))}
        {editor === "new" ? (
          <li>
            {options.isPending ? (
              <div className="flex items-center gap-3 px-4 py-3" aria-hidden="true">
                <DenSkeleton className="h-8 w-24 shrink-0" />
                <DenSkeleton className="h-8 flex-1" />
              </div>
            ) : <RouteEditor route={null} {...editorProps} onSave={(next) => void saveRoute("new", next)} />}
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
      <p className="mt-2 px-1 text-[12px] text-gray-500">When Auto can&apos;t decide, it uses the first model that allows High thinking.</p>
      {lockLine}
    </section>
  );
}
