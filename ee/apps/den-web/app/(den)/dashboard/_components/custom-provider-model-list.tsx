"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { ChevronRight, Plus, Search, Trash2 } from "lucide-react";
import { GATEWAY_CUSTOM_MATCH_PROVIDER_ID } from "@openwork/types/den/gateway-custom-providers";
import { DenButton } from "../../_components/ui/button";
import { DenCheckbox } from "../../_components/ui/checkbox";
import { DenChip } from "../../_components/ui/chip";
import { DenCombobox } from "../../_components/ui/combobox";
import { DenInput } from "../../_components/ui/input";
import { DenNotice } from "../../_components/ui/notice";
import { DenSkeleton } from "../../_components/ui/skeleton";
import { DenSwitch } from "../../_components/ui/switch";
import { CUSTOM_MODALITIES, originLabel, settingsFromCatalogModel, type ModelDraft, type ModelSettingsDraft, type ModelSettingsField } from "./custom-provider-models";
import { requestLlmProviderCatalogDetail } from "./llm-provider-data";
import { sortModelsNewestFirst } from "./gateway-provider-models";

export type ModelTemplate = { id: string; name: string; settings: ModelSettingsDraft };

/** models.dev's OpenRouter list, offered as settings templates. */
export function useModelTemplates(orgId: string | null) {
  const [templates, setTemplates] = useState<ModelTemplate[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!orgId) { setBusy(false); return; }
    let cancelled = false;
    setBusy(true);
    setError(null);
    void requestLlmProviderCatalogDetail(orgId, GATEWAY_CUSTOM_MATCH_PROVIDER_ID)
      .then((detail) => { if (!cancelled) setTemplates(sortModelsNewestFirst(detail.models).map((model) => ({ id: model.id, name: model.name, settings: settingsFromCatalogModel(model) }))); })
      .catch(() => { if (!cancelled) setError("Could not load the list of known models. You can still set models up yourself."); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [orgId, attempt]);
  return { templates, busy, error, retry: () => setAttempt((current) => current + 1) };
}

export type ModelListHighlight = { key: string; field: ModelSettingsField | null; message: string | null } | null;

const FIELD = "mt-3 block text-[12px] font-medium text-gray-700";
const INVALID = "border-red-300 ring-2 ring-red-100";

function TemplatePicker({ templates, busy, ariaLabel, placeholder, onPick, testId, disabled }: {
  templates: readonly ModelTemplate[]; busy: boolean; ariaLabel: string; placeholder: string; testId: string; disabled?: boolean;
  onPick: (template: ModelTemplate) => void;
}) {
  const options = useMemo(() => templates.map((template) => ({ value: template.id, label: template.name, description: template.id })), [templates]);
  return (
    <div className="w-[300px] max-w-full" data-testid={testId}>
      <DenCombobox ariaLabel={ariaLabel} value="" options={options} disabled={disabled || busy} placeholder={busy ? "Loading known models…" : placeholder}
        searchPlaceholder="Search models" emptyLabel="No models match. Try another name."
        onChange={(id) => { const template = templates.find((entry) => entry.id === id); if (template) onPick(template); }} />
    </div>
  );
}

function ToggleRow({ label, checked, onChange, testId, disabled }: { label: string; checked: boolean; onChange: (value: boolean) => void; testId: string; disabled?: boolean }) {
  return (
    <div className="flex min-h-10 items-center gap-3 text-[13px] text-gray-900">
      <span className="min-w-0 flex-1">{label}</span>
      <DenSwitch size="sm" checked={checked} onChange={onChange} aria-label={label} testId={testId} disabled={disabled} />
    </div>
  );
}

function ModalityPicker({ label, value, onChange, invalid, testId, disabled }: {
  label: string; value: readonly ModelSettingsDraft["input"][number][]; invalid: boolean; testId: string; disabled?: boolean;
  onChange: (value: ModelSettingsDraft["input"]) => void;
}) {
  return (
    <fieldset className="mt-3" data-testid={testId}>
      <legend className="text-[12px] font-medium text-gray-700">{label}</legend>
      <div className={`mt-1.5 flex flex-wrap gap-x-4 gap-y-2 rounded-lg ${invalid ? INVALID : ""}`}>
        {CUSTOM_MODALITIES.map((modality) => (
          <label key={modality} className="flex items-center gap-2 text-[13px] text-gray-900">
            <DenCheckbox checked={value.includes(modality)} disabled={disabled} data-testid={`${testId}-${modality}`}
              onCheckedChange={(checked) => onChange(checked ? CUSTOM_MODALITIES.filter((entry) => entry === modality || value.includes(entry)) : value.filter((entry) => entry !== modality))} />
            {modality === "pdf" ? "PDF" : modality.charAt(0).toUpperCase() + modality.slice(1)}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Every setting of one model. */
export function ModelSettingsForm({ settings, onChange, invalidField, disabled }: {
  settings: ModelSettingsDraft; onChange: (patch: Partial<ModelSettingsDraft>) => void; invalidField: ModelSettingsField | null; disabled?: boolean;
}) {
  const formId = useId();
  const invalid = (field: ModelSettingsField) => invalidField === field;
  const text = (field: ModelSettingsField, label: string, options: { placeholder?: string; mono?: boolean; inputMode?: "numeric" | "decimal" } = {}) => {
    const value = settings[field];
    return (
      <label className={FIELD} htmlFor={`${formId}-${field}`}>
        {label}
        <DenInput id={`${formId}-${field}`} className={`mt-1.5 h-9 text-[13px] ${options.mono ? "font-mono text-[12px]" : ""} ${invalid(field) ? INVALID : ""}`} value={typeof value === "string" ? value : ""}
          placeholder={options.placeholder} inputMode={options.inputMode} autoComplete="off" disabled={disabled} aria-invalid={invalid(field)} data-testid={`custom-model-field-${field}`}
          onChange={(event) => onChange({ [field]: event.target.value })} />
      </label>
    );
  };
  return (
    <div className="px-2 pb-3" data-testid="custom-model-settings">
      <div className="grid gap-x-4 sm:grid-cols-2">
        {text("id", "Model ID", { mono: true, placeholder: "vendor/model-name" })}
        {text("name", "Name people see (optional)", { placeholder: settings.id || "Same as the ID" })}
        {text("context", "Context window (tokens)", { placeholder: "128000", inputMode: "numeric" })}
        {text("outputLimit", "Longest answer (tokens)", { placeholder: "16000", inputMode: "numeric" })}
      </div>
      <div className="mt-3 divide-y divide-gray-100 border-y border-gray-100">
        <ToggleRow label="Reads attachments" checked={settings.attachment} disabled={disabled} testId="custom-model-attachment" onChange={(attachment) => onChange({ attachment })} />
        <ToggleRow label="Uses tools" checked={settings.toolCall} disabled={disabled} testId="custom-model-tool-call" onChange={(toolCall) => onChange({ toolCall })} />
        <ToggleRow label="Structured output" checked={settings.structuredOutput} disabled={disabled} testId="custom-model-structured-output" onChange={(structuredOutput) => onChange({ structuredOutput })} />
        <ToggleRow label="Accepts temperature" checked={settings.temperature} disabled={disabled} testId="custom-model-temperature" onChange={(temperature) => onChange({ temperature })} />
        <ToggleRow label="Reasoning" checked={settings.reasoning} disabled={disabled} testId="custom-model-reasoning" onChange={(reasoning) => onChange({ reasoning })} />
        {settings.reasoning ? (
          <div className="pb-3 pl-4">
            <ToggleRow label="People can turn reasoning off" checked={settings.reasoningToggle} disabled={disabled} testId="custom-model-reasoning-toggle" onChange={(reasoningToggle) => onChange({ reasoningToggle })} />
            {text("reasoningEfforts", "Effort levels (optional, comma separated)", { placeholder: "low, medium, high" })}
          </div>
        ) : null}
      </div>
      <div className="grid gap-x-4 sm:grid-cols-2">
        <ModalityPicker label="Accepts" value={settings.input} invalid={invalid("input")} disabled={disabled} testId="custom-model-input" onChange={(input) => onChange({ input })} />
        <ModalityPicker label="Produces" value={settings.output} invalid={invalid("output")} disabled={disabled} testId="custom-model-output" onChange={(output) => onChange({ output })} />
      </div>
      <details className="group mt-3" open={["costInput", "costOutput", "costCacheRead", "costCacheWrite"].some((field) => field === invalidField) || undefined}>
        <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[12px] font-medium text-gray-700">
          <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" aria-hidden="true" strokeWidth={1.5} />
          Price per million tokens, in US dollars (optional)
        </summary>
        <div className="grid gap-x-4 sm:grid-cols-4">
          {text("costInput", "Input", { placeholder: "0.50", inputMode: "decimal" })}
          {text("costOutput", "Output", { placeholder: "1.50", inputMode: "decimal" })}
          {text("costCacheRead", "Cache read", { inputMode: "decimal" })}
          {text("costCacheWrite", "Cache write", { inputMode: "decimal" })}
        </div>
      </details>
    </div>
  );
}

export type ModelListProps = {
  drafts: readonly ModelDraft[];
  expandedKey: string | null;
  highlight: ModelListHighlight;
  templates: ReturnType<typeof useModelTemplates>;
  disabled?: boolean;
  onToggle: (key: string) => void;
  onSetAll: (selected: boolean) => void;
  onUpdate: (key: string, patch: Partial<ModelSettingsDraft>) => void;
  onApplyTemplate: (key: string, template: ModelTemplate) => void;
  onSetUpManually: (key: string) => void;
  onAddTemplate: (template: ModelTemplate) => void;
  onAddCustom: () => void;
  onRemove: (key: string) => void;
  onExpand: (key: string | null) => void;
};

/** The provider's models: tick to include, open a row to edit every setting. */
export function CustomProviderModelList(props: ModelListProps) {
  const { drafts, expandedKey, highlight, templates, disabled } = props;
  const [query, setQuery] = useState("");
  const normalized = query.trim().toLowerCase();
  const visible = normalized ? drafts.filter((draft) => draft.settings.id.toLowerCase().includes(normalized) || draft.settings.name.toLowerCase().includes(normalized)) : drafts;
  const selectedCount = drafts.filter((draft) => draft.selected).length;

  return (
    <div data-testid="custom-model-list">
      {templates.error ? <DenNotice className="mt-3" tone="neutral" presentation="inline" message={templates.error} action={<DenButton size="sm" variant="secondary" onClick={templates.retry}>Retry</DenButton>} /> : null}
      {drafts.length ? (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {drafts.length > 8 ? <div className="w-[200px]"><DenInput type="search" icon={Search} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter models" aria-label="Filter models" className="h-8 text-[12px]" data-testid="custom-model-filter" /></div> : null}
          <span className="text-[12px] text-gray-500" data-testid="custom-model-count">{selectedCount} of {drafts.length} selected</span>
          <span className="ml-auto flex items-center gap-3 text-[12px]">
            <button type="button" disabled={disabled} className="font-medium text-gray-700 hover:text-gray-900 disabled:opacity-50" data-testid="custom-model-select-all" onClick={() => props.onSetAll(true)}>Select all</button>
            <button type="button" disabled={disabled} className="font-medium text-gray-700 hover:text-gray-900 disabled:opacity-50" data-testid="custom-model-clear" onClick={() => props.onSetAll(false)}>Clear</button>
          </span>
        </div>
      ) : null}
      <ul className="mt-2 divide-y divide-gray-100 border-y border-gray-100">
        {visible.map((draft) => {
          const open = expandedKey === draft.key;
          const highlighted = highlight?.key === draft.key;
          const label = draft.settings.name.trim() || draft.settings.id.trim() || "New model";
          const origin = originLabel(draft.origin);
          const removable = draft.origin.kind === "template" || draft.origin.kind === "custom";
          return (
            <li key={draft.key} className={highlighted ? "bg-red-50/40" : undefined} data-testid="custom-model-row" data-model-id={draft.settings.id} data-selected={draft.selected} data-highlighted={highlighted || undefined}>
              <div className="flex min-h-11 items-center gap-3 px-2 py-1.5">
                <DenCheckbox checked={draft.selected} disabled={disabled} aria-label={`Include ${label}`} data-testid="custom-model-select" onCheckedChange={() => props.onToggle(draft.key)} />
                <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" aria-expanded={open} data-testid="custom-model-expand" onClick={() => props.onExpand(open ? null : draft.key)}>
                  <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-gray-400 transition-transform ${open ? "rotate-90" : ""}`} aria-hidden="true" strokeWidth={1.5} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-gray-900">{label}</span>
                    <span className="block truncate font-mono text-[11px] text-gray-500">{draft.settings.id && label !== draft.settings.id ? draft.settings.id : origin ?? ""}</span>
                  </span>
                </button>
                {draft.missing ? <DenChip tone="warning" data-testid="custom-model-missing">No longer listed</DenChip> : null}
                {!draft.configured ? <DenChip data-testid="custom-model-needs-settings">Needs settings</DenChip>
                  : draft.origin.kind === "matched" ? <DenChip tone="success" title={origin ?? undefined} data-testid="custom-model-matched">Matched</DenChip>
                  : null}
                {removable ? <DenButton size="xs" variant="ghost" icon={Trash2} disabled={disabled} aria-label={`Remove ${label}`} data-testid="custom-model-remove" onClick={() => props.onRemove(draft.key)} /> : null}
              </div>
              {highlighted && highlight?.message ? <p className="px-9 pb-2 text-[12px] text-red-700" role="alert" data-testid="custom-model-error">{highlight.message}</p> : null}
              {!draft.configured ? (
                <div className="flex flex-wrap items-center gap-2 px-9 pb-3">
                  <TemplatePicker templates={templates.templates} busy={templates.busy} disabled={disabled} ariaLabel={`Copy settings for ${label} from a known model`} placeholder="Copy settings from a known model…" testId="custom-model-template"
                    onPick={(template) => props.onApplyTemplate(draft.key, template)} />
                  <DenButton size="sm" variant="secondary" disabled={disabled} data-testid="custom-model-manual" onClick={() => props.onSetUpManually(draft.key)}>Set up yourself</DenButton>
                </div>
              ) : null}
              {open && draft.configured ? (
                <div className="pl-7">
                  {origin && draft.origin.kind !== "custom" ? <p className="px-2 text-[12px] text-gray-500">{origin}</p> : null}
                  <div className="flex flex-wrap items-center gap-2 px-2 pt-2">
                    <TemplatePicker templates={templates.templates} busy={templates.busy} disabled={disabled} ariaLabel={`Replace settings for ${label} with a known model's`} placeholder="Copy settings from a known model…" testId="custom-model-retemplate"
                      onPick={(template) => props.onApplyTemplate(draft.key, template)} />
                  </div>
                  <ModelSettingsForm settings={draft.settings} disabled={disabled} invalidField={highlighted ? highlight?.field ?? null : null} onChange={(patch) => props.onUpdate(draft.key, patch)} />
                </div>
              ) : null}
            </li>
          );
        })}
        {!drafts.length ? <li className="px-2 py-3 text-[13px] text-gray-500" data-testid="custom-model-empty">No models yet. Add one from the list of known models, or set one up yourself.</li> : null}
        {drafts.length > 0 && !visible.length ? <li className="px-2 py-3 text-[12px] text-gray-500">No models match that filter.</li> : null}
      </ul>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {templates.busy && !templates.templates.length ? <DenSkeleton className="h-9 w-[300px]" /> : (
          <TemplatePicker templates={templates.templates} busy={templates.busy} disabled={disabled} ariaLabel="Add a known model" placeholder="Add a known model…" testId="custom-model-add-template" onPick={props.onAddTemplate} />
        )}
        <DenButton size="sm" variant="secondary" icon={Plus} disabled={disabled} data-testid="custom-model-add-custom" onClick={props.onAddCustom}>Add a custom model</DenButton>
      </div>
    </div>
  );
}
