/** @jsxImportSource react */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Check, ChevronDown, ChevronRight, RefreshCw, Search, Star } from "lucide-react";
import { inferenceModelCapabilities } from "@openwork/types/den/inference";

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
import { t } from "@/i18n";
import { readDenSettings } from "@/app/lib/den";
import { modelEquals, resolveProviderDisplayName } from "../../../../app/utils";
import type { ModelOption, ModelRef } from "../../../../app/types";
import { isRecommendedModel } from "../../../../app/defaults";
import { ProviderIcon } from "../../../design-system/provider-icon";
import { useDenAuth } from "../../cloud/den-auth-provider";
import { usePlatform } from "../../../kernel/platform";
import {
  OPENWORK_MODELS_PROVIDER_ID,
  OPENWORK_MODELS_PROVIDER_NAME,
} from "../../cloud/openwork-models-promo";

export const MODEL_PICKER_DEFAULT_SUBTITLE = "Select a model for this session.";
export const MODEL_PICKER_UNAVAILABLE_SUBTITLE = "The model you were using is no longer available, please select a different model for this session.";

export function resolveModelPickerSubtitle(subtitle: string | undefined) {
  return subtitle ?? MODEL_PICKER_DEFAULT_SUBTITLE;
}

export type ModelPickerModalProps = {
  open: boolean;
  options: ModelOption[];
  disabledProviders?: string[];
  organizationModelsEmpty?: boolean;
  organizationModelsSettingsUrl?: string;
  query: string;
  setQuery: (value: string) => void;
  subtitle?: string;
  target: "default" | "session";
  current: ModelRef;
  onSelect: (model: ModelRef) => void;
  onBehaviorChange: (model: ModelRef, value: string | null) => void;
  onToggleProvider?: (providerId: string, enabled: boolean) => void;
  onOpenSettings: () => void;
  onClose: (options?: { restorePromptFocus?: boolean }) => void;
  /** Den entitlement present. Picker no longer upsells here; callers still pass it. */
  openWorkModelsEntitled?: boolean;
  /** The server is waiting to reload this workspace with OpenWork Models. */
  openWorkModelsSyncing?: boolean;
  onRefreshOrganizationModels?: () => void | Promise<void>;
  restrictToCloud?: boolean;
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

export type ModelPickerEmptyState = {
  messageKey: string;
  showConnectProvider: boolean;
  showRefreshOrganizationModels: boolean;
  showOrganizationModelsSettings: boolean;
};

export function resolveModelPickerEmptyState(input: {
  providerGroupCount: number;
  query: string;
  organizationModelsEmpty: boolean;
  restrictToCloud: boolean;
  organizationModelsSettingsUrl?: string;
}): ModelPickerEmptyState | null {
  if (input.providerGroupCount > 0) return null;
  if (input.query.trim()) {
    return {
      messageKey: "models.no_models_match_search",
      showConnectProvider: false,
      showRefreshOrganizationModels: false,
      showOrganizationModelsSettings: false,
    };
  }
  if (input.organizationModelsEmpty) {
    return {
      messageKey: "models.organization_models_empty",
      showConnectProvider: false,
      showRefreshOrganizationModels: true,
      showOrganizationModelsSettings: Boolean(input.organizationModelsSettingsUrl),
    };
  }
  return {
    messageKey: "models.no_models_available",
    showConnectProvider: !input.restrictToCloud,
    showRefreshOrganizationModels: false,
    showOrganizationModelsSettings: false,
  };
}

export function ModelPickerModal(props: ModelPickerModalProps) {
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set());
  const [refreshingOrganizationModels, setRefreshingOrganizationModels] = useState(false);
  const denAuth = useDenAuth();
  const platform = usePlatform();
  const organizationModelsSettingsUrl = props.organizationModelsSettingsUrl;
  const organizationProviderLabel = useMemo(
    () => readDenSettings().activeOrgName?.trim() || t("settings.provider_source_organization"),
    [denAuth.status],
  );

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

  // Expand current, organization-provided, and OpenWork groups once they appear
  // (options often load async).
  const autoExpandedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!props.open) {
      autoExpandedRef.current = new Set();
      return;
    }
    const toExpand: string[] = [];
    const queueExpand = (id: string) => {
      if (!autoExpandedRef.current.has(id) && !toExpand.includes(id)) toExpand.push(id);
    };
    const current = providerGroups.find((group) => group.hasCurrent);
    if (current) queueExpand(current.id);
    for (const group of providerGroups) {
      if (group.isCloud) queueExpand(group.id);
    }
    const openwork = providerGroups.find((group) => group.id === OPENWORK_MODELS_PROVIDER_ID);
    if (openwork) queueExpand(openwork.id);
    if (toExpand.length === 0) return;
    for (const id of toExpand) autoExpandedRef.current.add(id);
    setExpandedProviders((prev) => {
      const next = new Set(prev);
      for (const id of toExpand) next.add(id);
      return next;
    });
  }, [props.open, providerGroups]);

  const toggleProvider = useCallback((id: string) => {
    setExpandedProviders((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const handleSelect = useCallback(
    (opt: ModelOption) => props.onSelect({ providerID: opt.providerID, modelID: opt.modelID }),
    [props.onSelect],
  );

  const handleRefreshOrganizationModels = useCallback(async () => {
    if (!props.onRefreshOrganizationModels || refreshingOrganizationModels) return;
    setRefreshingOrganizationModels(true);
    try {
      await props.onRefreshOrganizationModels();
    } finally {
      setRefreshingOrganizationModels(false);
    }
  }, [props.onRefreshOrganizationModels, refreshingOrganizationModels]);

  const emptyState = resolveModelPickerEmptyState({
    providerGroupCount: providerGroups.length,
    query: props.query,
    organizationModelsEmpty: Boolean(props.organizationModelsEmpty),
    restrictToCloud: Boolean(props.restrictToCloud),
    organizationModelsSettingsUrl,
  });

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
          <DialogTitle>{t("models.title")}</DialogTitle>
          <DialogDescription>
            {resolveModelPickerSubtitle(props.subtitle)}
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
              placeholder={t("models.search_placeholder")}
              value={props.query}
              onChange={(e) => props.setQuery(e.target.value)}
            />
          </div>

          {props.openWorkModelsSyncing ? (
            <div className="mb-3 flex shrink-0 items-center overflow-hidden rounded-2xl border border-amber-6/60 bg-amber-2/40">
              <div className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5">
                <ProviderIcon providerId={OPENWORK_MODELS_PROVIDER_ID} providerName={OPENWORK_MODELS_PROVIDER_NAME} size={18} className="shrink-0 text-amber-11" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-[13px] font-medium text-dls-text">
                    <span>{OPENWORK_MODELS_PROVIDER_NAME}</span>
                  </div>
                  <div className="truncate text-[11px] text-dls-secondary">
                    Included on your plan — pending workspace reload.
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          {/* Content */}
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1 -mr-1">
            {emptyState ? (
              <div className="space-y-3 rounded-2xl border border-dls-border bg-dls-hover/30 px-4 py-6 text-center">
                <div className="text-sm text-dls-secondary">
                  {t(emptyState.messageKey)}
                </div>
                {emptyState.showRefreshOrganizationModels ? (
                  <Button variant="outline" onClick={() => void handleRefreshOrganizationModels()} disabled={refreshingOrganizationModels}>
                    <RefreshCw className={`mr-1 size-3 ${refreshingOrganizationModels ? "animate-spin" : ""}`} />
                    {refreshingOrganizationModels ? t("models.refreshing_organization_models") : t("models.refresh_organization_models")}
                  </Button>
                ) : null}
                {emptyState.showOrganizationModelsSettings && organizationModelsSettingsUrl ? (
                  <Button variant="ghost" onClick={() => platform.openLink(organizationModelsSettingsUrl)}>
                    {t("models.manage_organization_models")}
                  </Button>
                ) : null}
                {emptyState.showConnectProvider ? (
                  <Button variant="outline" onClick={props.onOpenSettings}>
                    {t("models.connect_provider")}
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
                  organizationProviderLabel={organizationProviderLabel}
                />
              ))
            )}
          </div>
        </div>

        {/* Footer */}
        <DialogFooter className="shrink-0">
          <DialogClose render={<Button variant="outline" />}>
            {t("models.done")}
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
  organizationProviderLabel,
}: {
  group: ProviderGroup;
  expanded: boolean;
  current: ModelRef;
  canToggleProvider: boolean;
  onToggleExpand: () => void;
  onToggleProvider?: (providerId: string, enabled: boolean) => void;
  onSelect: (opt: ModelOption) => void;
  organizationProviderLabel: string;
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
            {" "}
            <span className="ml-2 text-[11px] text-dls-secondary">
              {totalModels} model{totalModels === 1 ? "" : "s"}
            </span>
          </div>
          {" "}
          <span className="flex shrink-0 items-center gap-1.5">
            {group.isNew ? (
              <span className="rounded-md bg-blue-3 px-1.5 py-0.5 text-[10px] font-medium text-blue-11">New</span>
            ) : null}
            {group.isCloud ? (
              <span className="rounded-md bg-blue-3/50 px-1.5 py-0.5 text-[10px] font-medium text-blue-11/70">{organizationProviderLabel}</span>
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
  const capabilities = opt.providerID === "openwork" ? inferenceModelCapabilities(opt.modelID) : null;
  const tokens = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

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
        {capabilities ? (
          <div className="mt-1 text-[11px] text-dls-secondary" title={`Maximum context: ${capabilities.contextTokens.toLocaleString()} tokens. Maximum output: ${capabilities.outputTokens.toLocaleString()} tokens, including reasoning. Actual capacity depends on the conversation and provider.`}>
            {capabilities.inputModalities.includes("image") ? "Text and images" : "Text only"}
            {capabilities.supportedParameters.includes("tools") ? " · Tool support" : ""}
            {` · Up to ${tokens.format(capabilities.contextTokens)} context / ${tokens.format(capabilities.outputTokens)} output tokens`}
          </div>
        ) : null}
      </div>
      {active ? <Check size={14} className="shrink-0 text-green-11" /> : null}
    </button>
  );
}
