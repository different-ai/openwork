/** @jsxImportSource react */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Check, ChevronDown, ChevronRight, Search, Star } from "lucide-react";

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { modelEquals, resolveProviderDisplayName } from "../../../../app/utils";
import type { ModelOption, ModelRef } from "../../../../app/types";
import { isDefaultVisibleModel, isRecommendedModel } from "../../../../app/defaults";
import { ProviderIcon } from "../../../design-system/provider-icon";
import { t } from "../../../../i18n";

const HIDDEN_MODELS_KEY = "openwork.hiddenModels";
const HIDDEN_MODELS_SEEDED_KEY = "openwork.hiddenModelsSeeded";

/**
 * Seed the hidden models set on first run. For providers with curated
 * default-visible lists (OpenAI, Anthropic), hide everything except
 * the top picks defined in app/defaults/models.ts.
 */
function seedHiddenModels(options: ModelOption[]): Set<string> {
  const hidden = new Set<string>();
  for (const opt of options) {
    if (!isDefaultVisibleModel(opt.providerID, opt.modelID)) {
      hidden.add(`${opt.providerID}/${opt.modelID}`);
    }
  }
  return hidden;
}

export function readHiddenModels(): Set<string> {
  try {
    const raw = window.localStorage.getItem(HIDDEN_MODELS_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}

function writeHiddenModels(hidden: Set<string>): void {
  try {
    window.localStorage.setItem(HIDDEN_MODELS_KEY, JSON.stringify([...hidden]));
  } catch {}
}

function hasSeededHiddenModels(): boolean {
  try {
    return window.localStorage.getItem(HIDDEN_MODELS_SEEDED_KEY) === "1";
  } catch {
    return false;
  }
}

function markSeededHiddenModels(): void {
  try {
    window.localStorage.setItem(HIDDEN_MODELS_SEEDED_KEY, "1");
  } catch {}
}

export type ModelPickerModalProps = {
  open: boolean;
  options: ModelOption[];
  disabledProviders?: string[];
  initialTab?: Tab;
  query: string;
  setQuery: (value: string) => void;
  target: "default" | "session";
  current: ModelRef;
  onSelect: (model: ModelRef) => void;
  onBehaviorChange: (model: ModelRef, value: string | null) => void;
  onToggleProvider?: (providerId: string, enabled: boolean) => void;
  onOpenSettings: () => void;
  onClose: (options?: { restorePromptFocus?: boolean }) => void;
};

type Tab = "default" | "available";

type ProviderGroup = {
  id: string;
  name: string;
  isNew: boolean;
  isCloud: boolean;
  isDisabled: boolean;
  hasCurrent: boolean;
  recommended: ModelOption[];
  other: ModelOption[];
};

export function ModelPickerModal(props: ModelPickerModalProps) {
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [tab, setTab] = useState<Tab>("default");
  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set());
  const [hiddenModels, setHiddenModels] = useState<Set<string>>(() => readHiddenModels());

  const disabledSet = useMemo(
    () => new Set(props.disabledProviders ?? []),
    [props.disabledProviders],
  );

  // Reset on open + seed defaults on first run
  useEffect(() => {
    if (props.open) {
      setTab(props.initialTab ?? "default");
      props.setQuery("");
      if (!hasSeededHiddenModels() && props.options.length > 0) {
        const seeded = seedHiddenModels(props.options);
        writeHiddenModels(seeded);
        markSeededHiddenModels();
        setHiddenModels(seeded);
      } else {
        setHiddenModels(readHiddenModels());
      }
    }
  }, [props.initialTab, props.open, props.options]);

  // Focus search
  useEffect(() => {
    if (!props.open) return;
    const frame = requestAnimationFrame(() => searchInputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [props.open, tab]);

  // Filter by search
  const filteredOptions = useMemo(() => {
    const q = props.query.trim().toLowerCase();
    if (!q) return props.options;
    return props.options.filter(
      (o) =>
        o.title.toLowerCase().includes(q) ||
        o.providerID.toLowerCase().includes(q) ||
        o.modelID.toLowerCase().includes(q) ||
        (o.description ?? "").toLowerCase().includes(q),
    );
  }, [props.options, props.query]);

  // Group by provider
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
          isDisabled: disabledSet.has(opt.providerID),
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
    return [...map.values()].sort((a, b) => {
      if (a.isDisabled !== b.isDisabled) return a.isDisabled ? 1 : -1;
      if (a.isNew !== b.isNew) return a.isNew ? -1 : 1;
      if (a.hasCurrent !== b.hasCurrent) return a.hasCurrent ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [filteredOptions, props.current, disabledSet]);

  // Auto-expand on search
  useEffect(() => {
    if (props.query.trim()) {
      setExpandedProviders(new Set(providerGroups.map((g) => g.id)));
    }
  }, [props.query, providerGroups]);

  // Expand current provider on open
  useEffect(() => {
    if (!props.open) return;
    const current = providerGroups.find((g) => g.hasCurrent);
    if (current) setExpandedProviders(new Set([current.id]));
  }, [props.open]);

  const toggleProvider = useCallback((id: string) => {
    setExpandedProviders((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const toggleModelVisible = useCallback((providerID: string, modelID: string) => {
    const key = `${providerID}/${modelID}`;
    setHiddenModels((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      writeHiddenModels(next);
      return next;
    });
  }, []);

  const batchToggleProvider = useCallback((providerID: string, showAll: boolean) => {
    setHiddenModels((prev) => {
      const next = new Set(prev);
      const models = filteredOptions.filter((o) => o.providerID === providerID);
      for (const m of models) {
        const key = `${m.providerID}/${m.modelID}`;
        if (showAll) {
          next.delete(key);
        } else {
          next.add(key);
        }
      }
      writeHiddenModels(next);
      return next;
    });
  }, [filteredOptions]);

  const handleSelect = useCallback(
    (opt: ModelOption) => props.onSelect({ providerID: opt.providerID, modelID: opt.modelID }),
    [props.onSelect],
  );

  // Escape
  useEffect(() => {
    if (!props.open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); props.onClose(); }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [props.open]);

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent className="flex max-h-[calc(100vh-2rem)] min-h-0 w-full max-w-lg flex-col overflow-hidden sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Models</DialogTitle>
          <DialogDescription>
            {tab === "default"
              ? t("model_picker.default_model_desc")
              : "Choose which models appear in the model selector."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col">
          {/* Tabs */}
          <div className="mb-4 flex shrink-0 gap-1 rounded-xl bg-dls-hover p-1">
            <TabButton active={tab === "default"} onClick={() => setTab("default")}>
              Default model
            </TabButton>
            <TabButton active={tab === "available"} onClick={() => setTab("available")}>
              Available models
            </TabButton>
          </div>

          {/* Search */}
          <div className="relative mb-4 shrink-0">
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

          {/* Content */}
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
                  tab={tab}
                  expanded={expandedProviders.has(group.id)}
                  current={props.current}
                  hiddenModels={hiddenModels}
                  canToggleProvider={!!props.onToggleProvider}
                  onToggleExpand={() => toggleProvider(group.id)}
                  onToggleProvider={props.onToggleProvider}
                  onToggleModelVisible={toggleModelVisible}
                  onBatchToggle={batchToggleProvider}
                  onSelect={handleSelect}
                />
              ))
            )}
          </div>
        </div>

        {/* Footer */}
        <DialogFooter className="shrink-0">
          <DialogClose render={<Button variant="outline" />}>
            Done
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/*  Tab button                                                         */
/* ------------------------------------------------------------------ */

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      className={[
        "flex-1 rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors",
        active
          ? "bg-dls-surface text-dls-text shadow-sm"
          : "text-dls-secondary hover:text-dls-text",
      ].join(" ")}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  Provider accordion                                                 */
/* ------------------------------------------------------------------ */

function ProviderAccordion({
  group,
  tab,
  expanded,
  current,
  hiddenModels,
  canToggleProvider,
  onToggleExpand,
  onToggleProvider,
  onToggleModelVisible,
  onBatchToggle,
  onSelect,
}: {
  group: ProviderGroup;
  tab: Tab;
  expanded: boolean;
  current: ModelRef;
  hiddenModels: Set<string>;
  canToggleProvider: boolean;
  onToggleExpand: () => void;
  onToggleProvider?: (providerId: string, enabled: boolean) => void;
  onToggleModelVisible: (providerID: string, modelID: string) => void;
  onBatchToggle: (providerID: string, showAll: boolean) => void;
  onSelect: (opt: ModelOption) => void;
}) {
  const totalModels = group.recommended.length + group.other.length;
  const visibleCount = [...group.recommended, ...group.other].filter(
    (m) => !hiddenModels.has(`${m.providerID}/${m.modelID}`),
  ).length;
  const Chevron = expanded ? ChevronDown : ChevronRight;

  return (
    <div className={group.isDisabled ? "opacity-50" : ""}>
      {/* Provider header */}
      <div className="flex items-center gap-1">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-dls-hover"
          onClick={onToggleExpand}
        >
          <Chevron size={14} className="shrink-0 text-dls-secondary" />
          <ProviderIcon providerId={group.id} size={18} className="shrink-0 text-dls-text" />
          <div className="min-w-0 flex-1">
            <span className="text-[13px] font-medium text-dls-text">{group.name}</span>
            <span className="ml-2 text-[11px] text-dls-secondary">
              {tab === "available" ? `${visibleCount}/${totalModels}` : `${totalModels}`} model{totalModels === 1 ? "" : "s"}
            </span>
          </div>
          <span className="flex shrink-0 items-center gap-1.5">
            {group.isNew ? (
              <span className="rounded-md bg-blue-3 px-1.5 py-0.5 text-[10px] font-medium text-blue-11">New</span>
            ) : null}
            {group.isCloud ? (
              <span className="rounded-md bg-blue-3/50 px-1.5 py-0.5 text-[10px] font-medium text-blue-11/70">Cloud</span>
            ) : null}
            {group.hasCurrent && tab === "default" ? (
              <span className="rounded-md bg-green-3 px-1.5 py-0.5 text-[10px] font-medium text-green-11">Current</span>
            ) : null}
          </span>
        </button>
        {canToggleProvider ? (
          <button
            type="button"
            className={[
              "mr-2 shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors",
              group.isDisabled
                ? "border border-dls-border text-dls-secondary hover:bg-dls-hover hover:text-dls-text"
                : "bg-green-3 text-green-11 hover:bg-green-4",
            ].join(" ")}
            onClick={(e) => { e.stopPropagation(); onToggleProvider?.(group.id, group.isDisabled); }}
            title={group.isDisabled ? "Enable this provider" : "Disable this provider"}
          >
            {group.isDisabled ? "Enable" : "Enabled"}
          </button>
        ) : null}
      </div>

      {/* Models */}
      {expanded && !group.isDisabled ? (
        <div className="ml-9 space-y-0.5 pb-2 pt-0.5">
          {/* Select all / none for Available tab */}
          {tab === "available" ? (
            <div className="flex gap-2 px-2 pb-1">
              <button
                type="button"
                className="text-[10px] font-medium text-dls-secondary underline-offset-2 hover:text-dls-text hover:underline"
                onClick={() => onBatchToggle(group.id, true)}
              >
                Select all
              </button>
              <span className="text-[10px] text-dls-secondary/40">|</span>
              <button
                type="button"
                className="text-[10px] font-medium text-dls-secondary underline-offset-2 hover:text-dls-text hover:underline"
                onClick={() => onBatchToggle(group.id, false)}
              >
                Unselect all
              </button>
            </div>
          ) : null}
          {group.recommended.length > 0 ? (
            <>
              <div className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-dls-secondary">
                Recommended
              </div>
              {group.recommended.map((opt) => (
                tab === "default" ? (
                  <DefaultModelRow key={opt.modelID} opt={opt} current={current} onSelect={onSelect} recommended />
                ) : (
                  <AvailableModelRow key={opt.modelID} opt={opt} hidden={hiddenModels.has(`${opt.providerID}/${opt.modelID}`)} onToggle={onToggleModelVisible} recommended />
                )
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
                tab === "default" ? (
                  <DefaultModelRow key={opt.modelID} opt={opt} current={current} onSelect={onSelect} />
                ) : (
                  <AvailableModelRow key={opt.modelID} opt={opt} hidden={hiddenModels.has(`${opt.providerID}/${opt.modelID}`)} onToggle={onToggleModelVisible} />
                )
              ))}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Default tab: model row (click to select as default)                */
/* ------------------------------------------------------------------ */

function DefaultModelRow({
  opt, current, onSelect, recommended,
}: {
  opt: ModelOption; current: ModelRef; onSelect: (opt: ModelOption) => void; recommended?: boolean;
}) {
  const active = modelEquals(current, { providerID: opt.providerID, modelID: opt.modelID });

  return (
    <button
      type="button"
      className={[
        "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors",
        active ? "bg-green-3/50" : "hover:bg-dls-hover",
      ].join(" ")}
      onClick={() => onSelect(opt)}
    >
      {recommended ? <Star size={12} className="shrink-0 text-amber-9" /> : <div className="w-3 shrink-0" />}
      <div className="min-w-0 flex-1">
        <span className={["text-[12px]", active ? "font-medium text-dls-text" : "text-dls-text"].join(" ")}>{opt.title}</span>
        <span className="ml-2 font-mono text-[10px] text-dls-secondary/60">{opt.modelID}</span>
      </div>
      {active ? <Check size={14} className="shrink-0 text-green-11" /> : null}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  Available tab: model row (checkbox to show/hide)                   */
/* ------------------------------------------------------------------ */

function AvailableModelRow({
  opt, hidden, onToggle, recommended,
}: {
  opt: ModelOption; hidden: boolean; onToggle: (providerID: string, modelID: string) => void; recommended?: boolean;
}) {
  return (
    <button
      type="button"
      className={[
        "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-dls-hover",
        hidden ? "opacity-50" : "",
      ].join(" ")}
      onClick={() => onToggle(opt.providerID, opt.modelID)}
    >
      {/* Checkbox */}
      <div className={[
        "flex size-4 shrink-0 items-center justify-center rounded border transition-colors",
        hidden ? "border-dls-border bg-transparent" : "border-dls-text bg-dls-text",
      ].join(" ")}>
        {!hidden ? <Check size={10} className="text-dls-surface" /> : null}
      </div>
      {recommended ? <Star size={12} className="shrink-0 text-amber-9" /> : null}
      <div className="min-w-0 flex-1">
        <span className="text-[12px] text-dls-text">{opt.title}</span>
        <span className="ml-2 font-mono text-[10px] text-dls-secondary/60">{opt.modelID}</span>
      </div>
    </button>
  );
}
