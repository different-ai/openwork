/** @jsxImportSource react */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ArrowLeft, Check, ChevronRight, Search, X } from "lucide-react";

import { modelEquals, resolveProviderDisplayName } from "../../../../app/utils";
import type { ModelOption, ModelRef } from "../../../../app/types";
import { ProviderIcon } from "../../../design-system/provider-icon";
import { t } from "../../../../i18n";

/**
 * Curated list of model IDs (substrings) that are considered
 * "recommended" and shown in a top section when browsing a provider's
 * models. Positional only — no quality-ranking API exists.
 */
const RECOMMENDED_MODEL_PATTERNS = [
  "claude-opus-4",
  "gpt-5.5",
  "kimi-k2.6",
];

function isRecommendedModel(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return RECOMMENDED_MODEL_PATTERNS.some((p) => lower.includes(p));
}

export type ModelPickerModalProps = {
  open: boolean;
  options: ModelOption[];
  query: string;
  setQuery: (value: string) => void;
  target: "default" | "session";
  current: ModelRef;
  onSelect: (model: ModelRef) => void;
  onBehaviorChange: (model: ModelRef, value: string | null) => void;
  onOpenSettings: () => void;
  onClose: (options?: { restorePromptFocus?: boolean }) => void;
};

type ProviderGroup = {
  id: string;
  name: string;
  isNew: boolean;
  isCloud: boolean;
  modelCount: number;
  hasCurrent: boolean;
};

export function ModelPickerModal(props: ModelPickerModalProps) {
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);

  // Reset view when modal opens/closes
  useEffect(() => {
    if (props.open) {
      setSelectedProvider(null);
      props.setQuery("");
    }
  }, [props.open]);

  // Focus search on open
  useEffect(() => {
    if (!props.open) return;
    const frame = requestAnimationFrame(() => searchInputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [props.open, selectedProvider]);

  // Filter by search query
  const filteredOptions = useMemo(() => {
    const q = props.query.trim().toLowerCase();
    if (!q) return props.options.filter((o) => o.isConnected);
    return props.options.filter(
      (o) =>
        o.isConnected &&
        (o.title.toLowerCase().includes(q) ||
          o.providerID.toLowerCase().includes(q) ||
          o.modelID.toLowerCase().includes(q) ||
          (o.description ?? "").toLowerCase().includes(q)),
    );
  }, [props.options, props.query]);

  // Group by provider
  const providerGroups = useMemo<ProviderGroup[]>(() => {
    const map = new Map<string, ProviderGroup>();
    for (const opt of filteredOptions) {
      const existing = map.get(opt.providerID);
      const isCurrent = modelEquals(props.current, {
        providerID: opt.providerID,
        modelID: opt.modelID,
      });
      if (existing) {
        existing.modelCount++;
        if (isCurrent) existing.hasCurrent = true;
      } else {
        map.set(opt.providerID, {
          id: opt.providerID,
          name: opt.description ?? resolveProviderDisplayName(opt.providerID),
          isNew: !!opt.isRecommended,
          isCloud: opt.source === "cloud",
          modelCount: 1,
          hasCurrent: isCurrent,
        });
      }
    }
    // Sort: new providers first, then alphabetical
    return [...map.values()].sort((a, b) => {
      if (a.isNew !== b.isNew) return a.isNew ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [filteredOptions, props.current]);

  // Models for the selected provider, split into recommended + other
  const selectedModels = useMemo(() => {
    if (!selectedProvider) return { recommended: [], other: [] };
    const models = filteredOptions.filter((o) => o.providerID === selectedProvider);
    const recommended = models.filter((m) => isRecommendedModel(m.modelID));
    const other = models.filter((m) => !isRecommendedModel(m.modelID));
    return { recommended, other };
  }, [filteredOptions, selectedProvider]);

  const handleSelectModel = useCallback(
    (opt: ModelOption) => {
      props.onSelect({ providerID: opt.providerID, modelID: opt.modelID });
    },
    [props.onSelect],
  );

  // Escape key: go back to provider list, or close modal
  useEffect(() => {
    if (!props.open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (selectedProvider) {
          setSelectedProvider(null);
          props.setQuery("");
        } else {
          props.onClose();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [props.open, selectedProvider]);

  if (!props.open) return null;

  const selectedProviderGroup = providerGroups.find((g) => g.id === selectedProvider);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-gray-1/60 p-4 backdrop-blur-sm">
      <div className="flex max-h-[calc(100vh-2rem)] w-full max-w-lg flex-col overflow-hidden rounded-[24px] border border-dls-border bg-dls-surface shadow-[var(--dls-shell-shadow)]">
        <div className="flex min-h-0 flex-col p-6">
          {/* Header */}
          <div className="mb-4 flex items-start justify-between">
            <div>
              {selectedProvider ? (
                <button
                  type="button"
                  className="mb-1 flex items-center gap-1 text-xs text-dls-secondary transition-colors hover:text-dls-text"
                  onClick={() => { setSelectedProvider(null); props.setQuery(""); }}
                >
                  <ArrowLeft size={12} />
                  All providers
                </button>
              ) : null}
              <h2 className="text-lg font-semibold text-dls-text">
                {selectedProvider
                  ? selectedProviderGroup?.name ?? selectedProvider
                  : props.target === "default"
                    ? t("model_picker.default_model")
                    : t("model_picker.session_model")}
              </h2>
              <p className="mt-0.5 text-[13px] text-dls-secondary">
                {selectedProvider
                  ? `${selectedModels.recommended.length + selectedModels.other.length} models available`
                  : props.target === "default"
                    ? t("model_picker.default_model_description")
                    : t("model_picker.session_model_description")}
              </p>
            </div>
            <button
              type="button"
              className="inline-flex size-9 items-center justify-center rounded-full text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
              onClick={() => props.onClose()}
              aria-label="Close"
            >
              <X size={18} />
            </button>
          </div>

          {/* Search */}
          <div className="relative mb-4">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-dls-secondary" />
            <input
              ref={searchInputRef}
              type="text"
              className="h-10 w-full rounded-xl border border-dls-border bg-dls-surface pl-9 pr-3 text-sm text-dls-text placeholder:text-dls-secondary focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.2)]"
              placeholder={selectedProvider ? "Search models..." : "Search providers..."}
              value={props.query}
              onChange={(e) => props.setQuery(e.target.value)}
            />
          </div>

          {/* Content */}
          <div className="min-h-0 flex-1 overflow-y-auto pr-1 -mr-1">
            {selectedProvider ? (
              <ModelList
                recommended={selectedModels.recommended}
                other={selectedModels.other}
                current={props.current}
                onSelect={handleSelectModel}
              />
            ) : (
              <ProviderList
                groups={providerGroups}
                onSelectProvider={setSelectedProvider}
              />
            )}
          </div>

          {/* Footer */}
          <div className="mt-5 flex shrink-0 justify-end">
            <button
              type="button"
              className="inline-flex items-center justify-center rounded-full border border-dls-border px-4 py-2 text-[13px] font-medium text-dls-text transition-colors hover:bg-dls-hover"
              onClick={() => props.onClose()}
            >
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Provider list                                                      */
/* ------------------------------------------------------------------ */

function ProviderList({
  groups,
  onSelectProvider,
}: {
  groups: ProviderGroup[];
  onSelectProvider: (id: string) => void;
}) {
  if (groups.length === 0) {
    return (
      <div className="rounded-2xl border border-dls-border bg-dls-hover/30 px-4 py-6 text-center text-sm text-dls-secondary">
        No providers found.
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {groups.map((group) => (
        <button
          key={group.id}
          type="button"
          className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-dls-hover"
          onClick={() => onSelectProvider(group.id)}
        >
          <ProviderIcon providerId={group.id} size={18} className="shrink-0 text-dls-text" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-[13px] font-medium text-dls-text">
              <span className="truncate">{group.name}</span>
              {group.isNew ? (
                <span className="shrink-0 rounded-md bg-blue-3 px-1.5 py-0.5 text-[10px] font-medium text-blue-11">
                  New
                </span>
              ) : null}
              {group.isCloud ? (
                <span className="shrink-0 rounded-md bg-blue-3/50 px-1.5 py-0.5 text-[10px] font-medium text-blue-11/70">
                  Cloud
                </span>
              ) : null}
              {group.hasCurrent ? (
                <span className="shrink-0 rounded-md bg-green-3 px-1.5 py-0.5 text-[10px] font-medium text-green-11">
                  Current
                </span>
              ) : null}
            </div>
            <div className="mt-0.5 text-[11px] text-dls-secondary">
              {group.modelCount} model{group.modelCount === 1 ? "" : "s"}
            </div>
          </div>
          <ChevronRight size={14} className="shrink-0 text-dls-secondary" />
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Model list (within a provider)                                     */
/* ------------------------------------------------------------------ */

function ModelList({
  recommended,
  other,
  current,
  onSelect,
}: {
  recommended: ModelOption[];
  other: ModelOption[];
  current: ModelRef;
  onSelect: (opt: ModelOption) => void;
}) {
  return (
    <div className="space-y-4">
      {recommended.length > 0 ? (
        <section className="space-y-1">
          <div className="px-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-dls-secondary">
            Recommended
          </div>
          {recommended.map((opt) => (
            <ModelRow key={`${opt.providerID}/${opt.modelID}`} opt={opt} current={current} onSelect={onSelect} />
          ))}
        </section>
      ) : null}
      {other.length > 0 ? (
        <section className="space-y-1">
          {recommended.length > 0 ? (
            <div className="px-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-dls-secondary">
              All models
            </div>
          ) : null}
          {other.map((opt) => (
            <ModelRow key={`${opt.providerID}/${opt.modelID}`} opt={opt} current={current} onSelect={onSelect} />
          ))}
        </section>
      ) : null}
      {recommended.length === 0 && other.length === 0 ? (
        <div className="rounded-2xl border border-dls-border bg-dls-hover/30 px-4 py-6 text-center text-sm text-dls-secondary">
          No models found.
        </div>
      ) : null}
    </div>
  );
}

function ModelRow({
  opt,
  current,
  onSelect,
}: {
  opt: ModelOption;
  current: ModelRef;
  onSelect: (opt: ModelOption) => void;
}) {
  const active = modelEquals(current, {
    providerID: opt.providerID,
    modelID: opt.modelID,
  });

  return (
    <button
      type="button"
      className={[
        "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors",
        active ? "bg-green-3/50" : "hover:bg-dls-hover",
      ].join(" ")}
      onClick={() => onSelect(opt)}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[13px] text-dls-text">
          <span className={active ? "font-medium" : ""}>{opt.title}</span>
          {active ? (
            <Check size={14} className="shrink-0 text-green-11" />
          ) : null}
        </div>
        <div className="mt-0.5 font-mono text-[11px] text-dls-secondary">
          {opt.modelID}
        </div>
      </div>
    </button>
  );
}
