/** @jsxImportSource react */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Check, ChevronDown, ChevronRight, Search, Star, X } from "lucide-react";

import { modelEquals, resolveProviderDisplayName } from "../../../../app/utils";
import type { ModelOption, ModelRef } from "../../../../app/types";
import { ProviderIcon } from "../../../design-system/provider-icon";
import { t } from "../../../../i18n";

/**
 * Curated list of model ID substrings considered "recommended".
 * Shown with a star icon and sorted to the top within each provider.
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
  hasCurrent: boolean;
  recommended: ModelOption[];
  other: ModelOption[];
};

export function ModelPickerModal(props: ModelPickerModalProps) {
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set());

  // Reset when modal opens
  useEffect(() => {
    if (props.open) {
      props.setQuery("");
    }
  }, [props.open]);

  // Focus search on open
  useEffect(() => {
    if (!props.open) return;
    const frame = requestAnimationFrame(() => searchInputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [props.open]);

  // Filter by search query (searches providers AND models)
  const filteredOptions = useMemo(() => {
    const connected = props.options.filter((o) => o.isConnected);
    const q = props.query.trim().toLowerCase();
    if (!q) return connected;
    return connected.filter(
      (o) =>
        o.title.toLowerCase().includes(q) ||
        o.providerID.toLowerCase().includes(q) ||
        o.modelID.toLowerCase().includes(q) ||
        (o.description ?? "").toLowerCase().includes(q),
    );
  }, [props.options, props.query]);

  // Group by provider with recommended models first
  const providerGroups = useMemo<ProviderGroup[]>(() => {
    const map = new Map<string, ProviderGroup>();
    for (const opt of filteredOptions) {
      let group = map.get(opt.providerID);
      if (!group) {
        group = {
          id: opt.providerID,
          name: opt.description ?? resolveProviderDisplayName(opt.providerID),
          isNew: !!opt.isRecommended,
          isCloud: opt.source === "cloud",
          hasCurrent: false,
          recommended: [],
          other: [],
        };
        map.set(opt.providerID, group);
      }
      if (isRecommendedModel(opt.modelID)) {
        group.recommended.push(opt);
      } else {
        group.other.push(opt);
      }
      if (modelEquals(props.current, { providerID: opt.providerID, modelID: opt.modelID })) {
        group.hasCurrent = true;
      }
    }
    // Sort: new providers first, then providers with current default, then alpha
    return [...map.values()].sort((a, b) => {
      if (a.isNew !== b.isNew) return a.isNew ? -1 : 1;
      if (a.hasCurrent !== b.hasCurrent) return a.hasCurrent ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [filteredOptions, props.current]);

  // When searching, auto-expand all providers that have matching models
  useEffect(() => {
    if (props.query.trim()) {
      setExpandedProviders(new Set(providerGroups.map((g) => g.id)));
    }
  }, [props.query, providerGroups]);

  // On first open, expand the provider that has the current default
  useEffect(() => {
    if (!props.open) return;
    const currentProvider = providerGroups.find((g) => g.hasCurrent);
    if (currentProvider) {
      setExpandedProviders(new Set([currentProvider.id]));
    }
  }, [props.open]);

  const toggleProvider = useCallback((id: string) => {
    setExpandedProviders((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleSelectModel = useCallback(
    (opt: ModelOption) => {
      props.onSelect({ providerID: opt.providerID, modelID: opt.modelID });
    },
    [props.onSelect],
  );

  // Escape to close
  useEffect(() => {
    if (!props.open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        props.onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [props.open]);

  if (!props.open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-gray-1/60 p-4 backdrop-blur-sm">
      <div className="flex max-h-[calc(100vh-2rem)] w-full max-w-lg flex-col overflow-hidden rounded-[24px] border border-dls-border bg-dls-surface shadow-[var(--dls-shell-shadow)]">
        <div className="flex min-h-0 flex-col p-6">
          {/* Header */}
          <div className="mb-4 flex items-start justify-between">
            <div>
              <h2 className="text-lg font-semibold text-dls-text">
                {props.target === "default"
                  ? t("model_picker.default_model")
                  : t("model_picker.session_model")}
              </h2>
              <p className="mt-0.5 text-[13px] text-dls-secondary">
                {props.target === "default"
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
              placeholder="Search providers and models..."
              value={props.query}
              onChange={(e) => props.setQuery(e.target.value)}
            />
          </div>

          {/* Provider accordion list */}
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1 -mr-1">
            {providerGroups.length === 0 ? (
              <div className="rounded-2xl border border-dls-border bg-dls-hover/30 px-4 py-6 text-center text-sm text-dls-secondary">
                No providers found.
              </div>
            ) : (
              providerGroups.map((group) => (
                <ProviderAccordion
                  key={group.id}
                  group={group}
                  expanded={expandedProviders.has(group.id)}
                  current={props.current}
                  onToggle={() => toggleProvider(group.id)}
                  onSelect={handleSelectModel}
                />
              ))
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
/*  Provider accordion                                                 */
/* ------------------------------------------------------------------ */

function ProviderAccordion({
  group,
  expanded,
  current,
  onToggle,
  onSelect,
}: {
  group: ProviderGroup;
  expanded: boolean;
  current: ModelRef;
  onToggle: () => void;
  onSelect: (opt: ModelOption) => void;
}) {
  const totalModels = group.recommended.length + group.other.length;
  const Chevron = expanded ? ChevronDown : ChevronRight;

  return (
    <div>
      {/* Provider header */}
      <button
        type="button"
        className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-dls-hover"
        onClick={onToggle}
      >
        <Chevron size={14} className="shrink-0 text-dls-secondary" />
        <ProviderIcon providerId={group.id} size={18} className="shrink-0 text-dls-text" />
        <div className="min-w-0 flex-1">
          <span className="text-[13px] font-medium text-dls-text">{group.name}</span>
          <span className="ml-2 text-[11px] text-dls-secondary">
            {totalModels} model{totalModels === 1 ? "" : "s"}
          </span>
        </div>
        <span className="flex shrink-0 items-center gap-1.5">
          {group.isNew ? (
            <span className="rounded-md bg-blue-3 px-1.5 py-0.5 text-[10px] font-medium text-blue-11">
              New
            </span>
          ) : null}
          {group.isCloud ? (
            <span className="rounded-md bg-blue-3/50 px-1.5 py-0.5 text-[10px] font-medium text-blue-11/70">
              Cloud
            </span>
          ) : null}
          {group.hasCurrent ? (
            <span className="rounded-md bg-green-3 px-1.5 py-0.5 text-[10px] font-medium text-green-11">
              Current
            </span>
          ) : null}
        </span>
      </button>

      {/* Models (expanded) */}
      {expanded ? (
        <div className="ml-9 space-y-0.5 pb-2 pt-0.5">
          {group.recommended.length > 0 ? (
            <>
              <div className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-dls-secondary">
                Recommended
              </div>
              {group.recommended.map((opt) => (
                <ModelRow key={opt.modelID} opt={opt} current={current} onSelect={onSelect} recommended />
              ))}
            </>
          ) : null}
          {group.other.length > 0 ? (
            <>
              {group.recommended.length > 0 ? (
                <div className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-dls-secondary">
                  All models
                </div>
              ) : null}
              {group.other.map((opt) => (
                <ModelRow key={opt.modelID} opt={opt} current={current} onSelect={onSelect} />
              ))}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Model row                                                          */
/* ------------------------------------------------------------------ */

function ModelRow({
  opt,
  current,
  onSelect,
  recommended,
}: {
  opt: ModelOption;
  current: ModelRef;
  onSelect: (opt: ModelOption) => void;
  recommended?: boolean;
}) {
  const active = modelEquals(current, {
    providerID: opt.providerID,
    modelID: opt.modelID,
  });

  return (
    <button
      type="button"
      className={[
        "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors",
        active ? "bg-green-3/50" : "hover:bg-dls-hover",
      ].join(" ")}
      onClick={() => onSelect(opt)}
    >
      {recommended ? (
        <Star size={12} className="shrink-0 text-amber-9" />
      ) : (
        <div className="w-3 shrink-0" />
      )}
      <div className="min-w-0 flex-1">
        <span className={["text-[12px]", active ? "font-medium text-dls-text" : "text-dls-text"].join(" ")}>
          {opt.title}
        </span>
        <span className="ml-2 font-mono text-[10px] text-dls-secondary/60">
          {opt.modelID}
        </span>
      </div>
      {active ? (
        <Check size={14} className="shrink-0 text-green-11" />
      ) : null}
    </button>
  );
}
