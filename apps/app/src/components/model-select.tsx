"use client";

import * as React from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, Settings2, Star } from "lucide-react";

import type { ModelBehaviorOption, ModelOption, ModelRef } from "@/app/types";
import { getModelBehaviorSummary } from "@/app/lib/model-behavior";
import { ProviderIcon } from "@/react-app/design-system/provider-icon";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useWorkspace } from "@/react-app/shell/workspace-provider";
import { useCheckDesktopRestriction } from "@/react-app/domains/cloud/desktop-config-provider";
import { useDenAuth } from "@/react-app/domains/cloud/den-auth-provider";
import { InferenceAllowanceSummary, OwnProviderAction, useInferenceAccess } from "@/react-app/domains/cloud/inference-access-provider";
import { managedModelAccessLabel, managedModelRecommendation, managedModelRecommendations, markExplicitModelChoice, modelPickerView, modelSelectionUpgradeReason } from "@/app/lib/inference-access";
import {
  OPENWORK_MODELS_PROVIDER_ID,
  OPENWORK_MODELS_PROVIDER_NAME,
} from "@/react-app/domains/cloud/openwork-models-promo";
import { getConnectedProviderItems, useProviderListQuery } from "@/react-app/infra/provider-list-query";
import { filterEntitledModelOptions } from "@/react-app/domains/connections/provider-auth/provider-policy";
import {
  filterCloudManagedModelOptions,
  mergeModelOptions,
} from "@/react-app/domains/connections/provider-auth/assigned-model-options";
import { isCloudManagedProviderKey } from "@/react-app/domains/connections/provider-auth/cloud-provider-config";
import {
  Command,
  CommandCollection,
  CommandEmpty,
  CommandGroup,
  CommandGroupLabel,
  CommandHeader,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
} from "@/components/ui/command";
import { openModelPickerEvent } from "@/react-app/shell/new-providers-listener";
import { newProvidersEvent } from "@/app/lib/provider-events";
import { usePlatform } from "@/react-app/kernel/platform";
import {
  resolveThinkingModeShortcutOs,
  thinkingModeShortcutLabel,
} from "@/react-app/shell/thinking-mode-shortcut";
import {
  modelRefKey,
  nextFavoriteModel,
  useModelCollectionsStore,
} from "@/react-app/domains/session/models/model-collections-store";
import { favoriteModelShortcutLabel, isFavoriteModelShortcut } from "@/react-app/shell/favorite-model-shortcut";

function getProviderDisplayName(providerId: string) {
  return providerId
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function useModelOptions(
  open: boolean,
  fallbackOptions: readonly ModelOption[],
  cloudProvidersEnabled: boolean,
) {
  const { client, opencodeBaseUrl, selectedWorkspaceRoot } = useWorkspace();
  const checkDesktopRestriction = useCheckDesktopRestriction();

  const { data, refetch } = useProviderListQuery({
    client,
    baseUrl: opencodeBaseUrl,
    directory: selectedWorkspaceRoot,
    enabled: Boolean(client),
  });

  React.useEffect(() => {
    if (!open || !client) return;
    void refetch();
  }, [client, open, refetch]);

  React.useEffect(() => {
    if (!client) return;
    const handler = () => {
      void refetch();
    };
    window.addEventListener(newProvidersEvent, handler);
    return () => window.removeEventListener(newProvidersEvent, handler);
  }, [client, refetch]);

  // Apply org-level restrictions (dev #1505) on top of the raw model list
  // so the picker never surfaces blocked options:
  //   - `allowZenModel` hides the built-in OpenCode provider entries when false
  //   - `allowCustomProviders` keeps org-managed providers, plus Zen when allowed.
  return React.useMemo(() => {
    const restrictToCloud = checkDesktopRestriction({
      restriction: "allowCustomProviders",
    });

    const options = getConnectedProviderItems(data)
      .flatMap((provider) =>
        Object.entries(provider.models).map(([id, model]) => {
          const summary = getModelBehaviorSummary(provider.id, model, null, provider.name);
          return {
            providerID: provider.id,
            modelID: id,
            title: model.name,
            description: provider.name,
            behaviorTitle: summary.title,
            behaviorLabel: summary.label,
            behaviorDescription: summary.description,
            behaviorValue: summary.value,
            behaviorOptions: summary.options,
            isFree: false,
          };
        }),
      );

    return filterEntitledModelOptions(filterCloudManagedModelOptions(
      mergeModelOptions(options, fallbackOptions),
      cloudProvidersEnabled,
    ), {
      restrictToCloud,
      checkRestriction: checkDesktopRestriction,
    });
  }, [checkDesktopRestriction, cloudProvidersEnabled, data, fallbackOptions]);
}

type ModelSelectItem = {
  id: string;
  option: ModelOption;
};

type ModelSelectGroup = {
  value: string;
  items: ModelSelectItem[];
};

function groupByProvider(modelOptions: ModelOption[]): ModelSelectGroup[] {
  const groups = new Map<string, ModelSelectItem[]>();

  for (const option of modelOptions) {
    const providerLabel = option.description ?? getProviderDisplayName(option.providerID);
    const item: ModelSelectItem = {
      id: `${option.providerID}:${option.modelID}`,
      option,
    };
    const existing = groups.get(providerLabel);

    if (existing) {
      existing.push(item);
      continue;
    }

    groups.set(providerLabel, [item]);
  }

  return [...groups.entries()]
    .map(([providerLabel, options]) => ({
      value: providerLabel,
      items: [...options].sort((a, b) => a.option.title.localeCompare(b.option.title)),
    }))
    .sort((a, b) => a.value.localeCompare(b.value));
}

function isSameModel(a: ModelRef, b: ModelRef) {
  return a.providerID === b.providerID && a.modelID === b.modelID;
}

function thinkingOptionsFor(option: ModelOption): ModelBehaviorOption[] {
  return (option.behaviorOptions ?? []).filter((item) => item.value != null);
}

function overlaySelectedBehavior(
  options: readonly ModelOption[],
  value: ModelRef,
  behavior: {
    value: string | null;
    label?: string;
    options: { value: string | null; label: string }[];
  },
): ModelOption[] {
  return options.map((option) => {
    if (!isSameModel(value, option)) return option;
    const fallbackOptions: ModelBehaviorOption[] = behavior.options.map((item) => ({
      value: item.value,
      label: item.label,
      description: "",
    }));
    return {
      ...option,
      behaviorValue: behavior.value ?? option.behaviorValue,
      behaviorLabel: behavior.label ?? option.behaviorLabel,
      behaviorOptions: (option.behaviorOptions?.length ?? 0) > 0
        ? option.behaviorOptions
        : fallbackOptions,
    };
  });
}

interface ModelSelectProps {
  open: boolean;
  value: ModelRef;
  hideValue?: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (model: ModelRef, variant?: string | null) => void;
  disabled?: boolean;
  /** When set, "All models" opens the full picker scoped to this session. */
  sessionId?: string;
  /** Den/import includes OpenWork Models; allowance gates use member access instead. */
  openWorkModelsEntitled?: boolean;
  /** The server is waiting to reload this workspace with OpenWork Models. */
  openWorkModelsSyncing?: boolean;
  /** Member-scoped models available before a workspace OpenCode client exists. */
  fallbackOptions?: readonly ModelOption[];
  behaviorValue?: string | null;
  behaviorLabel?: string;
  behaviorOptions?: { value: string | null; label: string }[];
  onBehaviorChange?: (value: string | null) => void;
}

export function ModelSelect({
  open,
  value,
  hideValue = false,
  onOpenChange,
  onChange,
  disabled = false,
  sessionId,
  openWorkModelsSyncing = false,
  fallbackOptions = [],
  behaviorValue = null,
  behaviorLabel,
  behaviorOptions = [],
  onBehaviorChange,
}: ModelSelectProps) {
  const [pane, setPane] = React.useState<"model" | "effort">("model");
  const [search, setSearch] = React.useState("");
  const [thinkingFor, setThinkingFor] = React.useState<ModelOption | null>(null);
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  const thinkingBackRef = React.useRef<HTMLButtonElement>(null);
  const platform = usePlatform();
  const denAuth = useDenAuth();
  const inference = useInferenceAccess();
  const favorites = useModelCollectionsStore((state) => state.favorites);
  const recent = useModelCollectionsStore((state) => state.recent);
  const catalogOptions = useModelOptions(open, fallbackOptions, denAuth.isSignedIn);
  const { options: modelOptions, managedOnly } = React.useMemo(
    () => modelPickerView(overlaySelectedBehavior(catalogOptions, value, {
      value: behaviorValue,
      label: behaviorLabel,
      options: behaviorOptions,
    }), { access: inference.access, signedIn: denAuth.isSignedIn, target: "session" }),
    [behaviorLabel, behaviorOptions, behaviorValue, catalogOptions, value, inference.access, denAuth.isSignedIn],
  );
  const selectedTitle = catalogOptions.find((option) => isSameModel(value, option))?.title ?? value.modelID;
  React.useEffect(() => {
    if (managedOnly && thinkingFor && thinkingFor.providerID !== "openwork") {
      setThinkingFor(null);
      setPane("model");
    }
  }, [managedOnly, thinkingFor]);
  const shortcutOs = resolveThinkingModeShortcutOs(
    platform.os,
    typeof navigator === "undefined" ? "" : navigator.platform,
  );
  const shortcutLabel = thinkingModeShortcutLabel(shortcutOs);
  const reverseShortcutLabel = thinkingModeShortcutLabel(shortcutOs, "reverse");
  const favoriteShortcutLabel = shortcutOs === "macos" ? "⌃⇧M" : favoriteModelShortcutLabel;

  const focusSearchInput = React.useCallback(() => {
    window.requestAnimationFrame(() => {
      const input = searchInputRef.current;

      if (!input) {
        return;
      }

      input.focus();
      input.select();
    });
  }, []);

  React.useEffect(() => {
    if (!open) {
      return;
    }

    if (pane !== "model") {
      thinkingBackRef.current?.focus();
      return;
    }

    focusSearchInput();
  }, [focusSearchInput, open, pane]);

  const selectedOption = modelOptions?.find((option) =>
    isSameModel(value, {
      providerID: option.providerID,
      modelID: option.modelID,
    }),
  );

  const optionsByKey = React.useMemo(
    () => new Map(modelOptions.map((option) => [modelRefKey(option), option])),
    [modelOptions],
  );
  const favoriteOptions = React.useMemo(
    () => favorites.flatMap((model) => {
      const option = optionsByKey.get(modelRefKey(model));
      return option ? [option] : [];
    }),
    [favorites, optionsByKey],
  );
  const favoriteKeys = React.useMemo(() => new Set(favorites.map(modelRefKey)), [favorites]);
  const recentOptions = React.useMemo(() => {
    return recent.flatMap((model) => {
      const option = optionsByKey.get(modelRefKey(model));
      return option && !favoriteKeys.has(modelRefKey(model)) ? [option] : [];
    });
  }, [favoriteKeys, optionsByKey, recent]);
  const recommendations = managedModelRecommendations(inference.access, modelOptions);
  const groups: ModelSelectGroup[] = [];
  const shown = new Set<string>();
  const query = search.trim().toLowerCase();
  const addGroup = (label: string, options: readonly ModelOption[]) => {
    const items = options.filter((option) => {
      const recommendation = managedModelRecommendation(inference.access, option);
      return !option.disabled && !shown.has(modelRefKey(option)) && (!query || [
        option.providerID, option.modelID, option.title, option.description,
        recommendation?.displayName, recommendation?.providerName, recommendation?.summary, ...(recommendation?.capabilities ?? []),
      ].some((text) => text?.toLowerCase().includes(query)));
    }).map((option) => {
      const id = modelRefKey(option);
      shown.add(id);
      return { id, option };
    });
    if (items.length) groups.push({ value: label, items });
  };
  addGroup("Recommended by OpenWork", recommendations);
  addGroup("Current model", selectedOption ? [selectedOption] : []);
  addGroup("Favorites", favoriteOptions);
  addGroup("Recent", recentOptions.slice(0, 3));
  const remaining = modelOptions.filter((option) => query || recommendations.length === 0 || option.providerID !== "openwork");
  for (const group of groupByProvider(remaining)) addGroup(group.value, group.items.map((item) => item.option));
  const selectedThinkingOptions = selectedOption ? thinkingOptionsFor(selectedOption) : [];
  const effectiveBehaviorLabel = behaviorLabel ?? selectedOption?.behaviorLabel ?? "Default";
  const nextFavorite = nextFavoriteModel(favoriteOptions.filter((model) => !model.disabled && !modelSelectionUpgradeReason(inference.access, model)), value);
  const showBehavior = !hideValue
    && selectedThinkingOptions.length > 0
    && Boolean(effectiveBehaviorLabel);

  const applyModel = (option: ModelOption, behavior?: string | null) => {
    if (!modelOptions.some((available) => isSameModel(available, option) && !available.disabled)) return;
    if (!inference.checkSelection(option, sessionId, modelOptions, value)) { onOpenChange(false); return; }
    markExplicitModelChoice();
    useModelCollectionsStore.getState().recordRecent(option);
    onChange({ providerID: option.providerID, modelID: option.modelID }, behavior);
    if (behavior !== undefined) {
      onBehaviorChange?.(behavior);
    }
    setSearch("");
    setThinkingFor(null);
    setPane("model");
    onOpenChange(false);
  };

  const handleSelect = (option: ModelOption) => {
    applyModel(option);
  };

  const thinkingOptions = thinkingFor ? thinkingOptionsFor(thinkingFor) : [];
  const thinkingValue =
    thinkingFor && isSameModel(value, thinkingFor)
      ? (behaviorValue ?? thinkingFor.behaviorValue)
      : (thinkingFor?.behaviorValue ?? null);

  const applyThinking = (option: ModelBehaviorOption) => {
    if (!thinkingFor) return;
    if (isSameModel(value, thinkingFor)) {
      onBehaviorChange?.(option.value);
      setThinkingFor(null);
      setPane("model");
      onOpenChange(false);
      return;
    }
    applyModel(thinkingFor, option.value);
  };

  const cycleFavorite = () => {
    if (!nextFavorite) return;
    const option = optionsByKey.get(modelRefKey(nextFavorite));
    if (!option) return;
    const thinking = thinkingOptionsFor(option);
    const compatibleBehavior = thinking.some((entry) => entry.value === behaviorValue)
      ? behaviorValue
      : option.behaviorValue ?? null;
    applyModel(option, compatibleBehavior);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        onOpenChange(nextOpen);

        if (nextOpen) {
          setPane("model");
          setThinkingFor(null);
        } else {
          setSearch("");
          setThinkingFor(null);
          setPane("model");
        }
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              type="button"
              disabled={disabled}
              aria-label="Change model"
              aria-keyshortcuts="Meta+Alt+/"
              className="flex h-9 max-h-9 min-w-0 max-w-fit flex-1 items-center gap-1.5 rounded-md px-2.5 text-sm text-gray-10 transition-colors hover:bg-gray-3 hover:text-gray-12 disabled:pointer-events-none disabled:opacity-60"
            />
          }
        >
          <span className="flex min-w-0 max-w-56 items-center gap-1.5">
            <span className="truncate">
              {hideValue || (!denAuth.isSignedIn && isCloudManagedProviderKey(value.providerID))
                ? "Select model"
                : selectedTitle}
            </span>
            {showBehavior ? (
              <span className="shrink-0 text-gray-9">· {effectiveBehaviorLabel}</span>
            ) : null}
          </span>
          <ChevronDown className="h-3 w-3" />
        </TooltipTrigger>
        <TooltipContent>
          Change model · Cycle thinking ({shortcutLabel} forward, {reverseShortcutLabel} back)
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        className="w-96 max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl bg-popover p-0 shadow-xl ring-1 ring-foreground/5 dark:ring-foreground/10"
        align="start"
        initialFocus={false}
        data-testid="managed-model-picker"
        data-model-scope={managedOnly ? "openwork" : "all"}
        aria-label={managedOnly ? "Choose an OpenWork model" : "Choose a model"}
        onKeyDownCapture={(event) => {
          if (!managedOnly || !isFavoriteModelShortcut(event)) return;
          event.preventDefault();
          event.stopPropagation();
          if (!event.repeat) cycleFavorite();
        }}
      >
        {pane === "effort" && thinkingFor && (!managedOnly || thinkingFor.providerID === "openwork") ? (
          <div data-slot="model-thinking-submenu" className="flex max-h-(--available-height) flex-col">
            <button
              ref={thinkingBackRef}
              type="button"
              aria-label="Back to models"
              className="flex cursor-pointer items-center gap-2 border-b border-border px-3 py-2 text-left hover:bg-accent"
              onClick={() => {
                setThinkingFor(null);
                setPane("model");
              }}
            >
              <ChevronLeft className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">Effort</span>
                <span className="block truncate text-xs text-muted-foreground">{thinkingFor.title}</span>
              </span>
            </button>
            <div className="min-h-0 flex-1 overflow-y-auto p-1">
              {thinkingOptions.map((option) => {
                const selected = option.value === thinkingValue
                  || (thinkingValue == null && option.value === thinkingOptions[0]?.value);
                return (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={selected}
                    className="flex w-full cursor-pointer items-center gap-2 rounded-xl px-3 py-2 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                    onClick={() => applyThinking(option)}
                  >
                    <span className="min-w-0 flex-1 truncate text-foreground">{option.label}</span>
                    {selected ? <Check className="size-3.5 shrink-0 text-muted-foreground" /> : null}
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="flex max-h-[min(var(--available-height),36rem)] flex-col">
            <Command items={groups} filter={null} value={search} onValueChange={setSearch}>
              <div className="flex min-h-0 flex-1 flex-col">
              <CommandHeader className="p-1.5 pb-1">
                <CommandInput ref={searchInputRef} placeholder="Search all models..." aria-label="Search all models" className="h-9 text-sm" />
                {managedOnly ? <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">OpenWork models</p> : null}
              </CommandHeader>
              <InferenceAllowanceSummary className="px-3 pb-2" available={catalogOptions.some((option) => option.providerID === "openwork")} />
              {openWorkModelsSyncing ? (
                <div className="mx-1 mb-1 flex items-center gap-2 rounded-md border border-amber-6/60 bg-amber-2/40 px-2 py-1.5">
                  <ProviderIcon providerId={OPENWORK_MODELS_PROVIDER_ID} providerName={OPENWORK_MODELS_PROVIDER_NAME} className="size-3.5 shrink-0 text-amber-11" size={14} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium text-foreground">{OPENWORK_MODELS_PROVIDER_NAME}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">Pending workspace reload…</span>
                  </span>
                </div>
              ) : null}
              <CommandPanel className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain">
                <CommandEmpty>{managedOnly
                  ? query ? "No OpenWork models match your search." : "No OpenWork models are available. Open the full list to refresh."
                  : "No models found."}</CommandEmpty>
                <CommandList className="not-empty:scroll-py-1 not-empty:p-1">
                  {(group: ModelSelectGroup) => (
                    <CommandGroup key={group.value} items={group.items} className="[[role=group]+&]:mt-1">
                      <CommandGroupLabel className="px-2 py-1 text-xs">{group.value}</CommandGroupLabel>
                      <CommandCollection>
                        {(item: ModelSelectItem) => {
                          const option = item.option;
                          const selected = isSameModel(value, option);
                          const recommendation = managedModelRecommendation(inference.access, option);
                          const name = recommendation?.displayName ?? option.title;
                          const accessLabel = managedModelAccessLabel(inference.access, option);
                          const favorite = favoriteKeys.has(modelRefKey(option));
                          return (
                            <CommandItem
                              className="min-h-0 gap-2 rounded-lg px-2 py-1.5"
                              key={item.id}
                              value={`${option.providerID}:${option.modelID} ${name} ${option.title} ${option.description ?? ""} ${recommendation?.summary ?? ""} ${recommendation?.capabilities.join(" ") ?? ""}`}
                              onClick={() => handleSelect(option)}
                              data-checked={selected}
                              data-testid={`model-option-${option.providerID}-${option.modelID}`}
                              aria-description={recommendation?.summary}
                              aria-label={`${name}${accessLabel ? `, ${accessLabel}` : ""}${selected ? ", current model" : ""}${modelSelectionUpgradeReason(inference.access, option) === "free_allowance_exhausted" ? ", allowance used up" : ""}${modelSelectionUpgradeReason(inference.access, option) ? ", opens upgrade options without changing your model" : ""}`}
                            >
                              <ProviderIcon providerId={option.providerID} providerName={option.description} className="size-3.5 opacity-70" size={14} />
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-foreground">{name}</span>
                                <span className="block truncate text-xs text-muted-foreground">{recommendation?.summary || option.description || getProviderDisplayName(option.providerID)}</span>
                                {recommendation?.capabilities.length ? <span className="block truncate text-[11px] text-muted-foreground">{recommendation.capabilities.join(" · ")}</span> : null}
                              </span>
                              {accessLabel ? <span data-testid="model-access-label" className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{accessLabel}</span> : null}
                              <button
                                type="button"
                                className="cursor-pointer rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                                aria-label={favorite ? `Remove ${name} from favorites` : `Add ${name} to favorites`}
                                aria-pressed={favorite}
                                onKeyDown={(event) => event.stopPropagation()}
                                onPointerDown={(event) => {
                                  event.preventDefault();
                                  event.stopPropagation();
                                }}
                                onClick={(event) => {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  useModelCollectionsStore.getState().toggleFavorite(option);
                                }}
                              >
                                <Star className="size-3.5" fill={favorite ? "currentColor" : "none"} />
                              </button>
                              {selected ? <Check className="size-3.5 shrink-0 text-muted-foreground" /> : null}
                            </CommandItem>
                          );
                        }}
                      </CommandCollection>
                    </CommandGroup>
                  )}
                </CommandList>
              </CommandPanel>
              {!hideValue && selectedOption && selectedThinkingOptions.length > 0 && onBehaviorChange ? <div className="border-t border-border px-2 py-1" data-testid="selected-model-detail">
                <button type="button" aria-label={`Thinking and effort for ${selectedOption.title}`} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring" onClick={() => {
                  setThinkingFor(selectedOption);
                  setPane("effort");
                }}>
                  <span className="min-w-0 flex-1 truncate">{selectedOption.title} · {effectiveBehaviorLabel}</span>
                  <kbd className="text-muted-foreground">{shortcutLabel}</kbd>
                  <ChevronRight className="size-3.5" />
                </button>
              </div> : null}
              <div className="border-t border-border px-2 py-1">
                <button
                  type="button"
                  className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                  onClick={() => {
                    onOpenChange(false);
                    setSearch("");
                    setPane("model");
                    window.dispatchEvent(new CustomEvent(openModelPickerEvent, sessionId ? { detail: { sessionId } } : undefined));
                  }}
                >
                  <Settings2 className="size-3.5" />
                  {managedOnly ? "See all OpenWork models" : "See all models"}
                </button>
                {favoriteOptions.length > 0 ? <button type="button" disabled={!nextFavorite} className="flex w-full items-center justify-between rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent disabled:opacity-50" aria-label="Cycle favorite models" onClick={cycleFavorite}>
                  <span>Next favorite</span><kbd>{favoriteShortcutLabel}</kbd>
                </button> : null}
                <OwnProviderAction onBeforeOpen={() => onOpenChange(false)} />
              </div>
              </div>
            </Command>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
