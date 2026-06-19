/** @jsxImportSource react */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ArrowRight, Check, ChevronDown, ChevronRight, Search, Sparkles, Star, X } from "lucide-react";
import { useNavigate } from "react-router-dom";

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
import { isRecommendedModel } from "../../../../app/defaults";
import { ProviderIcon } from "../../../design-system/provider-icon";
import { useDenAuth } from "../../cloud/den-auth-provider";
import { usePlatform } from "../../../kernel/platform";
import {
  getOpenWorkModelsActionUrl,
  hasOpenWorkModelsProvider,
  hideOpenWorkModelsPromo,
  isOpenWorkModelsPromoHidden,
  OPENWORK_MODELS_PROVIDER_ID,
  OPENWORK_MODELS_PROVIDER_NAME,
  openWorkModelsPromoChangedEvent,
} from "../../cloud/openwork-models-promo";

export type ModelPickerModalProps = {
  open: boolean;
  options: ModelOption[];
  disabledProviders?: string[];
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
  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set());
  const [promoHidden, setPromoHidden] = useState(isOpenWorkModelsPromoHidden);
  const denAuth = useDenAuth();
  const navigate = useNavigate();
  const platform = usePlatform();

  const disabledSet = useMemo(
    () => new Set(props.disabledProviders ?? []),
    [props.disabledProviders],
  );

  // Reset on open
  useEffect(() => {
    if (props.open) {
      props.setQuery("");
    }
  }, [props.open]);

  useEffect(() => {
    const handlePromoChanged = () => setPromoHidden(isOpenWorkModelsPromoHidden());
    window.addEventListener(openWorkModelsPromoChangedEvent, handlePromoChanged);
    return () => window.removeEventListener(openWorkModelsPromoChangedEvent, handlePromoChanged);
  }, []);

  // Focus search
  useEffect(() => {
    if (!props.open) return;
    const frame = requestAnimationFrame(() => searchInputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [props.open]);

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
    const groups = [...map.values()];
    for (const group of groups) {
      group.recommended.sort((a, b) => a.title.localeCompare(b.title));
      group.other.sort((a, b) => a.title.localeCompare(b.title));
    }
    return groups.sort((a, b) => {
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

  const showOpenWorkModelsPromo = useMemo(
    () => !promoHidden && !hasOpenWorkModelsProvider(props.options.map((option) => option.providerID)),
    [promoHidden, props.options],
  );

  const openOpenWorkModels = useCallback(() => {
    props.onClose();
    if (!denAuth.isSignedIn) {
      navigate("/settings/cloud-account");
    }
    window.setTimeout(() => {
      platform.openLink(getOpenWorkModelsActionUrl(denAuth.isSignedIn));
    }, 0);
  }, [denAuth.isSignedIn, navigate, platform, props.onClose]);

  const hideOpenWorkModels = useCallback(() => {
    hideOpenWorkModelsPromo();
    setPromoHidden(true);
  }, []);

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
            Select a model for this session.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col">
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

          {showOpenWorkModelsPromo ? (
            <div className="mb-3 flex shrink-0 items-center overflow-hidden rounded-2xl border border-blue-6/60 bg-blue-2/60 shadow-[0_12px_30px_-20px_rgba(var(--dls-accent-rgb),0.45)]">
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-blue-3/70"
                onClick={openOpenWorkModels}
              >
                <ProviderIcon providerId={OPENWORK_MODELS_PROVIDER_ID} providerName={OPENWORK_MODELS_PROVIDER_NAME} size={18} className="shrink-0 text-blue-11" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-[13px] font-medium text-dls-text">
                    <Sparkles className="size-3.5 text-blue-11" />
                    <span>{OPENWORK_MODELS_PROVIDER_NAME}</span>
                  </div>
                  <div className="truncate text-[11px] text-dls-secondary">
                    {denAuth.isSignedIn ? "Subscribe to use hosted frontier models in this workspace." : "Sign in to unlock hosted frontier models for your team."}
                  </div>
                </div>
                <span className="flex shrink-0 items-center gap-1 rounded-full border border-blue-6 bg-blue-3 px-2 py-0.5 text-[11px] font-medium text-blue-11">
                  {denAuth.isSignedIn ? "Subscribe" : "Sign in"}
                  <ArrowRight className="size-3" />
                </span>
              </button>
              <button
                type="button"
                className="flex size-9 shrink-0 items-center justify-center border-l border-blue-6/60 text-blue-11 transition-colors hover:bg-blue-3/70"
                onClick={hideOpenWorkModels}
                aria-label="Hide OpenWork Models"
              >
                <X className="size-3.5" />
              </button>
            </div>
          ) : null}

          {/* Content */}
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1 -mr-1">
            {providerGroups.length === 0 ? (
              <div className="space-y-3 rounded-2xl border border-dls-border bg-dls-hover/30 px-4 py-6 text-center">
                <div className="text-sm text-dls-secondary">
                  {props.query.trim() ? "No models match your search." : "No models available. Connect a provider to get started."}
                </div>
                {!props.query.trim() ? (
                  <Button variant="outline" onClick={props.onOpenSettings}>
                    Connect a provider
                  </Button>
                ) : null}
              </div>
            ) : (
              providerGroups.map((group) => (
                <ProviderAccordion
                  key={group.id}
                  group={group}
                  expanded={expandedProviders.has(group.id)}
                  current={props.current}
                  canToggleProvider={!!props.onToggleProvider}
                  onToggleExpand={() => toggleProvider(group.id)}
                  onToggleProvider={props.onToggleProvider}
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
/*  Provider accordion                                                 */
/* ------------------------------------------------------------------ */

function ProviderAccordion({
  group,
  expanded,
  current,
  canToggleProvider,
  onToggleExpand,
  onToggleProvider,
  onSelect,
}: {
  group: ProviderGroup;
  expanded: boolean;
  current: ModelRef;
  canToggleProvider: boolean;
  onToggleExpand: () => void;
  onToggleProvider?: (providerId: string, enabled: boolean) => void;
  onSelect: (opt: ModelOption) => void;
}) {
  const totalModels = group.recommended.length + group.other.length;
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
              {totalModels} model{totalModels === 1 ? "" : "s"}
            </span>
          </div>
          <span className="flex shrink-0 items-center gap-1.5">
            {group.isNew ? (
              <span className="rounded-md bg-blue-3 px-1.5 py-0.5 text-[10px] font-medium text-blue-11">New</span>
            ) : null}
            {group.isCloud ? (
              <span className="rounded-md bg-blue-3/50 px-1.5 py-0.5 text-[10px] font-medium text-blue-11/70">Cloud</span>
            ) : null}
            {group.hasCurrent ? (
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
          {group.recommended.length > 0 ? (
            <>
              <div className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-dls-secondary">
                Recommended
              </div>
              {group.recommended.map((opt) => (
                <DefaultModelRow key={opt.modelID} opt={opt} current={current} onSelect={onSelect} recommended />
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
                <DefaultModelRow key={opt.modelID} opt={opt} current={current} onSelect={onSelect} />
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
