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
import { openModelPickerEvent, openProviderAuthEvent } from "@/react-app/shell/new-providers-listener";
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
import { favoriteModelShortcutLabel } from "@/react-app/shell/favorite-model-shortcut";

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
  /** Den/import includes OpenWork Models. Kept for callers; picker no longer upsells here. */
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
  const [pane, setPane] = React.useState<"root" | "model" | "effort" | "favorites">("root");
  const [search, setSearch] = React.useState("");
  const [thinkingFor, setThinkingFor] = React.useState<ModelOption | null>(null);
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  const platform = usePlatform();
  const denAuth = useDenAuth();
  const favorites = useModelCollectionsStore((state) => state.favorites);
  const recent = useModelCollectionsStore((state) => state.recent);
  const catalogOptions = useModelOptions(open, fallbackOptions, denAuth.isSignedIn);
  const modelOptions = React.useMemo(
    () => overlaySelectedBehavior(catalogOptions, value, {
      value: behaviorValue,
      label: behaviorLabel,
      options: behaviorOptions,
    }),
    [behaviorLabel, behaviorOptions, behaviorValue, catalogOptions, value],
  );
  const checkDesktopRestriction = useCheckDesktopRestriction();
  const canAddProviders = !checkDesktopRestriction({ restriction: "allowCustomProviders" });
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
  const groups = React.useMemo(() => {
    const quickGroups: ModelSelectGroup[] = [];
    if (favoriteOptions.length > 0) {
      quickGroups.push({
        value: "Favorites",
        items: favoriteOptions.map((option) => ({ id: `favorite:${modelRefKey(option)}`, option })),
      });
    }
    if (recentOptions.length > 0) {
      quickGroups.push({
        value: "Recent",
        items: recentOptions.map((option) => ({ id: `recent:${modelRefKey(option)}`, option })),
      });
    }
    return [...quickGroups, ...groupByProvider(modelOptions)];
  }, [favoriteOptions, modelOptions, recentOptions]);
  const selectedThinkingOptions = selectedOption ? thinkingOptionsFor(selectedOption) : [];
  const effectiveBehaviorLabel = behaviorLabel ?? selectedOption?.behaviorLabel ?? "Default";
  const currentFavorite = favoriteOptions.find((option) => isSameModel(value, option)) ?? favoriteOptions[0] ?? null;
  const nextFavorite = nextFavoriteModel(favorites, value);
  const showBehavior = !hideValue
    && selectedThinkingOptions.length > 0
    && Boolean(effectiveBehaviorLabel);

  const applyModel = (option: ModelOption, behavior?: string | null) => {
    useModelCollectionsStore.getState().recordRecent(option);
    onChange({ providerID: option.providerID, modelID: option.modelID }, behavior);
    if (behavior !== undefined) {
      onBehaviorChange?.(behavior);
    }
    setSearch("");
    setThinkingFor(null);
    setPane("root");
    onOpenChange(false);
  };

  const handleSelect = (option: ModelOption) => {
    const thinking = thinkingOptionsFor(option);
    if (thinking.length > 0 && onBehaviorChange) {
      setThinkingFor(option);
      setPane("effort");
      return;
    }
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
      setPane("root");
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

  const handleConnectProvider = React.useCallback(() => {
    onOpenChange(false);
    setSearch("");
    setPane("root");
    window.dispatchEvent(new Event(openProviderAuthEvent));
  }, [onOpenChange]);

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        onOpenChange(nextOpen);

        if (nextOpen) {
          setPane("root");
          setThinkingFor(null);
        } else {
          setSearch("");
          setThinkingFor(null);
          setPane("root");
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
                : (selectedOption?.title ?? value.modelID ?? "Select model")}
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
        className="w-80 overflow-hidden rounded-2xl bg-popover p-0 shadow-xl ring-1 ring-foreground/5 dark:ring-foreground/10"
        align="start"
        initialFocus={false}
      >
        {pane === "root" ? (
          <div data-slot="model-select-root" className="space-y-0.5 p-2">
            <button
              type="button"
              disabled={!selectedOption || selectedThinkingOptions.length === 0 || !onBehaviorChange}
              className="flex w-full cursor-pointer items-center gap-3 rounded-xl px-2.5 py-2 text-left text-sm transition-colors hover:bg-accent disabled:cursor-default disabled:opacity-50"
              onClick={() => {
                if (!selectedOption) return;
                setThinkingFor(selectedOption);
                setPane("effort");
              }}
            >
              <span className="min-w-0 flex-1 font-medium text-foreground">Effort</span>
              <span className="max-w-24 truncate text-muted-foreground">
                {selectedThinkingOptions.length > 0 ? effectiveBehaviorLabel : "Unavailable"}
              </span>
              <kbd className="hidden shrink-0 rounded border border-border/70 bg-muted/40 px-1.5 py-0.5 font-sans text-[10px] leading-none text-muted-foreground sm:inline-flex">
                {shortcutLabel}
              </kbd>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
            </button>
            <button
              type="button"
              disabled={favoriteOptions.length === 0}
              className="flex w-full cursor-pointer items-center gap-3 rounded-xl px-2.5 py-2 text-left text-sm transition-colors hover:bg-accent disabled:cursor-default disabled:opacity-50"
              onClick={() => setPane("favorites")}
            >
              <span className="min-w-0 flex-1 font-medium text-foreground">Favorites</span>
              <span className="max-w-36 truncate text-muted-foreground">
                {currentFavorite?.title ?? "None"}
              </span>
              <kbd className="hidden shrink-0 rounded border border-border/70 bg-muted/40 px-1.5 py-0.5 font-sans text-[10px] leading-none text-muted-foreground sm:inline-flex">
                {favoriteShortcutLabel}
              </kbd>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
            </button>
            <button
              type="button"
              className="flex w-full cursor-pointer items-center gap-3 rounded-xl px-2.5 py-2 text-left text-sm transition-colors hover:bg-accent"
              onClick={() => setPane("model")}
            >
              <span className="min-w-0 flex-1 font-medium text-foreground">Model</span>
              <span className="max-w-36 truncate text-muted-foreground">
                {selectedOption?.title ?? value.modelID ?? "Select model"}
              </span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
            </button>
          </div>
        ) : pane === "favorites" ? (
          <div data-slot="model-favorites-submenu" className="flex max-h-(--available-height) flex-col">
            <div className="flex items-center gap-2 border-b border-border px-2 py-1.5">
              <button
                type="button"
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg px-1 py-1 text-left hover:bg-accent"
                onClick={() => setPane("root")}
              >
                <ChevronLeft className="size-4 shrink-0 text-muted-foreground" />
                <span className="text-sm font-medium">Favorites</span>
              </button>
              <button
                type="button"
                disabled={!nextFavorite}
                className="cursor-pointer rounded-lg px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-50"
                onClick={cycleFavorite}
              >
                Next · {favoriteModelShortcutLabel}
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-1">
              {favoriteOptions.map((option) => (
                <button
                  key={modelRefKey(option)}
                  type="button"
                  className="flex w-full cursor-pointer items-center gap-2 rounded-xl px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
                  onClick={() => handleSelect(option)}
                >
                  <ProviderIcon providerId={option.providerID} providerName={option.description} className="size-3.5 opacity-70" size={14} />
                  <span className="min-w-0 flex-1 truncate text-foreground">{option.title}</span>
                  {isSameModel(value, option) ? <Check className="size-3.5 shrink-0 text-muted-foreground" /> : null}
                </button>
              ))}
            </div>
          </div>
        ) : pane === "effort" && thinkingFor ? (
          <div data-slot="model-thinking-submenu" className="flex max-h-(--available-height) flex-col">
            <button
              type="button"
              className="flex cursor-pointer items-center gap-2 border-b border-border px-3 py-2 text-left hover:bg-accent"
              onClick={() => {
                setThinkingFor(null);
                setPane(isSameModel(value, thinkingFor) ? "root" : "model");
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
          <div className="flex max-h-[min(var(--available-height),28rem)] flex-col">
            <button
              type="button"
              className="flex cursor-pointer items-center gap-2 border-b border-border px-3 py-1.5 text-left hover:bg-accent"
              onClick={() => {
                setSearch("");
                setPane("root");
              }}
            >
              <ChevronLeft className="size-4 shrink-0 text-muted-foreground" />
              <span className="text-sm font-medium">Model</span>
            </button>
            <Command items={groups} value={search} onValueChange={setSearch}>
              <div className="flex min-h-0 flex-1 flex-col">
              <CommandHeader className="p-1.5 pb-1">
                <CommandInput ref={searchInputRef} placeholder="Search models..." className="h-9 text-sm" />
              </CommandHeader>
              {openWorkModelsSyncing ? (
                <div className="mx-1 mb-1 flex items-center gap-2 rounded-md border border-amber-6/60 bg-amber-2/40 px-2 py-1.5">
                  <ProviderIcon providerId={OPENWORK_MODELS_PROVIDER_ID} providerName={OPENWORK_MODELS_PROVIDER_NAME} className="size-3.5 shrink-0 text-amber-11" size={14} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium text-foreground">{OPENWORK_MODELS_PROVIDER_NAME}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">Included — pending workspace reload…</span>
                  </span>
                </div>
              ) : null}
              <CommandPanel className="h-0 min-h-0 flex-1 overflow-y-auto overscroll-y-contain">
                <CommandEmpty>No models found.</CommandEmpty>
                <CommandList className="not-empty:scroll-py-1 not-empty:p-1">
                  {(group: ModelSelectGroup) => (
                    <CommandGroup key={group.value} items={group.items} className="[[role=group]+&]:mt-1">
                      <CommandGroupLabel className="px-2 py-1 text-xs">{group.value}</CommandGroupLabel>
                      <CommandCollection>
                        {(item: ModelSelectItem) => {
                          const option = item.option;
                          const hasThinking = Boolean(onBehaviorChange) && thinkingOptionsFor(option).length > 0;
                          const favorite = favoriteKeys.has(modelRefKey(option));
                          return (
                            <CommandItem
                              className="min-h-0 gap-2 rounded-lg px-2 py-1.5"
                              key={item.id}
                              value={`${option.providerID}:${option.modelID} ${option.title} ${option.description ?? ""}`}
                              onClick={() => handleSelect(option)}
                              data-checked={isSameModel(value, option)}
                            >
                              <ProviderIcon providerId={option.providerID} providerName={option.description} className="size-3.5 opacity-70" size={14} />
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-foreground">{option.title}</span>
                                <span className="block truncate text-xs text-muted-foreground">{option.description ?? getProviderDisplayName(option.providerID)}</span>
                              </span>
                              <button
                                type="button"
                                className="cursor-pointer rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                                aria-label={favorite ? `Remove ${option.title} from favorites` : `Add ${option.title} to favorites`}
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
                              {hasThinking ? <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" /> : null}
                            </CommandItem>
                          );
                        }}
                      </CommandCollection>
                    </CommandGroup>
                  )}
                </CommandList>
              </CommandPanel>
              {canAddProviders ? (
                <div className="border-t border-border px-2 py-1">
                  <button type="button" className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground" onClick={handleConnectProvider}>
                    Connect more providers
                  </button>
                </div>
              ) : null}
              <div className="border-t border-border px-2 py-1">
                <button
                  type="button"
                  className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                  onClick={() => {
                    onOpenChange(false);
                    setSearch("");
                    setPane("root");
                    window.dispatchEvent(new CustomEvent(openModelPickerEvent, sessionId ? { detail: { sessionId } } : undefined));
                  }}
                >
                  <Settings2 className="size-3.5" />
                  All models
                </button>
              </div>
              </div>
            </Command>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
