"use client";

import * as React from "react";
import { useIsMobile } from "@/hooks/use-mobile";
import { FAST_DEFAULT_VARIANT } from "@openwork/types/cloud-model-fast";
import { Check, ChevronDown, ChevronLeft, ChevronRight, Settings2, Star } from "lucide-react";

import type { ModelBehaviorOption, ModelOption, ModelRef } from "@/app/types";
import { FAST_PRICING_WARNING, getModelBehaviorControls, getModelBehaviorSelection, getModelBehaviorSummary } from "@/app/lib/model-behavior";
import { ProviderIcon } from "@/react-app/design-system/provider-icon";
import { Switch } from "@/components/ui/switch";
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
  markDisabledModelOptions,
} from "@/react-app/domains/connections/provider-auth/assigned-model-options";
import { isCloudManagedProviderKey } from "@/react-app/domains/connections/provider-auth/cloud-provider-config";
import { useGatewayModelSelection } from "@/react-app/domains/connections/provider-auth/gateway-model-access";
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
  pendingOptions: readonly ModelOption[],
  disabledProviders: readonly string[],
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
      markDisabledModelOptions(mergeModelOptions(pendingOptions, mergeModelOptions(options, fallbackOptions)), disabledProviders),
      cloudProvidersEnabled,
    ), {
      restrictToCloud,
      checkRestriction: checkDesktopRestriction,
    });
  }, [checkDesktopRestriction, cloudProvidersEnabled, data, disabledProviders, fallbackOptions, pendingOptions]);
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
  if (option.gatewayAuthorization) return [];
  if (option.behaviorValue == null && !option.behaviorOptions?.some((item) => item.value !== null)) return [];
  return getModelBehaviorSelection(option.behaviorOptions ?? [], option.behaviorValue ?? null).options;
}

function overlaySelectedBehavior(
  options: readonly ModelOption[],
  value: ModelRef,
  behavior: {
    value: string | null;
    options: { value: string | null; label: string }[];
  },
): ModelOption[] {
  return options.map((option) => {
    if (!isSameModel(value, option)) return option;
    const selected = getModelBehaviorSelection(option.behaviorOptions ?? behavior.options, behavior.value);
    return {
      ...option,
      behaviorValue: selected.value,
      behaviorLabel: selected.label,
      behaviorDescription: selected.description,
      behaviorOptions: selected.options,
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
  const fastModeId = React.useId();
  const platform = usePlatform();
  const denAuth = useDenAuth();
  const favorites = useModelCollectionsStore((state) => state.favorites);
  const recent = useModelCollectionsStore((state) => state.recent);
  const gatewaySelection = useGatewayModelSelection(JSON.stringify([sessionId, value, behaviorValue, disabled]));
  const catalogOptions = useModelOptions(open, fallbackOptions, denAuth.isSignedIn, gatewaySelection.options, gatewaySelection.disabledProviders);
  const modelOptions = React.useMemo(
    () => overlaySelectedBehavior(catalogOptions, value, {
      value: behaviorValue,
      options: behaviorOptions,
    }),
    [behaviorOptions, behaviorValue, catalogOptions, value],
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

  const isMobile = useIsMobile();
  const modelButtonRef = React.useRef<HTMLButtonElement>(null);
  const effortButtonRef = React.useRef<HTMLButtonElement>(null);
  const favoritesButtonRef = React.useRef<HTMLButtonElement>(null);
  const backButtonRef = React.useRef<HTMLButtonElement>(null);
  const previousPaneRef = React.useRef(pane);
  const effortReturnPaneRef = React.useRef<"root" | "model" | "favorites">("root");

  // Base UI owns opening/closing focus. These are panes within one popup, so
  // restore focus after their DOM commits without reopening the mobile keyboard.
  React.useLayoutEffect(() => {
    const previous = previousPaneRef.current;
    previousPaneRef.current = pane;
    if (!open || previous === pane) return;
    const target = pane === "root"
      ? (previous === "effort" ? effortButtonRef : previous === "favorites" ? favoritesButtonRef : modelButtonRef).current
      : pane === "model" && !isMobile ? searchInputRef.current : backButtonRef.current;
    target?.focus({ preventScroll: true });
    if (target === searchInputRef.current) searchInputRef.current?.select();
  }, [isMobile, open, pane]);

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
  const selectedControls = getModelBehaviorControls(selectedThinkingOptions, behaviorValue);
  const effectiveBehaviorLabel = selectedOption?.behaviorLabel ?? behaviorLabel ?? "Default";
  const effortLabel = selectedControls.options.find((option) => option.value === behaviorValue)?.label ?? effectiveBehaviorLabel;
  const triggerBehaviorLabel = selectedOption?.behaviorValue === FAST_DEFAULT_VARIANT ? "Fast" : effectiveBehaviorLabel;
  const currentFavorite = favoriteOptions.find((option) => isSameModel(value, option)) ?? favoriteOptions[0] ?? null;
  const nextFavorite = nextFavoriteModel(favoriteOptions, value);
  const showBehavior = !hideValue
    && selectedThinkingOptions.length > 0
    && (selectedOption ? selectedOption.behaviorValue != null : behaviorValue != null)
    && Boolean(effectiveBehaviorLabel);

  const applyModel = (option: ModelOption, behavior?: string | null) => {
    const currentOption = optionsByKey.get(modelRefKey(option));
    if (!currentOption) return;
    gatewaySelection.select(currentOption, () => {
      useModelCollectionsStore.getState().recordRecent(option);
      onChange({ providerID: option.providerID, modelID: option.modelID }, behavior);
      if (behavior !== undefined) onBehaviorChange?.(behavior);
      setSearch("");
      setThinkingFor(null);
      setPane("root");
      onOpenChange(false);
    });
  };

  const handleSelect = (option: ModelOption) => {
    const thinking = thinkingOptionsFor(option);
    if (thinking.length > 0 && onBehaviorChange) {
      effortReturnPaneRef.current = pane === "favorites" ? "favorites" : "model";
      setThinkingFor(option);
      setPane("effort");
      return;
    }
    applyModel(option);
  };

  const thinkingOptions = thinkingFor ? thinkingOptionsFor(thinkingFor) : [];
  const thinkingValue =
    thinkingFor && isSameModel(value, thinkingFor)
      ? behaviorValue
      : (thinkingFor?.behaviorValue ?? null);
  const thinkingControls = getModelBehaviorControls(thinkingOptions, thinkingValue);

  const applyThinking = (option: ModelBehaviorOption) => {
    if (!thinkingFor) return;
    if (isSameModel(value, thinkingFor) && !optionsByKey.get(modelRefKey(thinkingFor))?.gatewayAuthorization) {
      onBehaviorChange?.(option.value);
      setThinkingFor(null);
      setPane("root");
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
      : null;
    applyModel(option, compatibleBehavior);
  };

  const handleConnectProvider = React.useCallback(() => {
    onOpenChange(false);
    setSearch("");
    setThinkingFor(null);
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
                : (selectedOption?.title || "Select model")}
            </span>
            {showBehavior ? (
              <span className="shrink-0 text-gray-9">· {triggerBehaviorLabel}</span>
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
        initialFocus={true}
      >
        {pane === "root" ? (
          <div data-slot="model-select-root" className="space-y-0.5 p-2">
            <button
              ref={effortButtonRef}
              type="button"
              disabled={!selectedOption || selectedThinkingOptions.length === 0 || !onBehaviorChange}
              className="flex w-full cursor-pointer items-center gap-3 rounded-xl px-2.5 py-2 text-left text-sm transition-colors hover:bg-accent disabled:cursor-default disabled:opacity-50"
              onClick={() => {
                if (!selectedOption) return;
                effortReturnPaneRef.current = "root";
                setThinkingFor(selectedOption);
                setPane("effort");
              }}
            >
              <span className="min-w-0 flex-1 font-medium text-foreground">Effort</span>
              <span className="max-w-24 truncate text-muted-foreground">
                {selectedThinkingOptions.length > 0 ? effortLabel : "Unavailable"}
              </span>
              <kbd className="hidden shrink-0 rounded border border-border/70 bg-muted/40 px-1.5 py-0.5 font-sans text-[10px] leading-none text-muted-foreground sm:inline-flex">
                {shortcutLabel}
              </kbd>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
            </button>
            {selectedControls.hasFast ? (
              <div className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-sm transition-colors hover:bg-accent" title={FAST_PRICING_WARNING}>
                <label htmlFor={fastModeId} className="min-w-0 flex-1 cursor-pointer font-medium text-foreground">Fast mode</label>
                <Switch
                  id={fastModeId}
                  size="sm"
                  checked={selectedControls.fast}
                  disabled={!onBehaviorChange || selectedControls.toggleValue === undefined}
                  onCheckedChange={() => {
                    if (selectedControls.toggleValue !== undefined) onBehaviorChange?.(selectedControls.toggleValue);
                  }}
                />
              </div>
            ) : null}
            <button
              ref={favoritesButtonRef}
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
              ref={modelButtonRef}
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
                ref={backButtonRef}
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
                   data-model-key={modelRefKey(option)}
                   type="button"
                  className="flex w-full cursor-pointer items-center gap-2 rounded-xl px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
                  onClick={() => handleSelect(option)}
                >
                  <ProviderIcon providerId={option.providerID} providerName={option.description} className="size-3.5 opacity-70" size={14} />
                  <span className="min-w-0 flex-1 truncate text-foreground">{option.title}</span>
                   {option.gatewayAuthorization ? <span className="text-xs text-muted-foreground">Sign-in required</span> : isSameModel(value, option) ? <Check className="size-3.5 shrink-0 text-muted-foreground" /> : null}
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
                setPane(effortReturnPaneRef.current);
              }}
              ref={backButtonRef}
            >
              <ChevronLeft className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">Effort</span>
                <span className="block truncate text-xs text-muted-foreground">{thinkingFor.title}</span>
              </span>
            </button>
            <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
              {getModelBehaviorSelection(thinkingOptions, thinkingControls.fast ? thinkingControls.toggleValue ?? null : thinkingValue).description}
            </p>
            <div className="min-h-0 flex-1 overflow-y-auto p-1">
              {thinkingControls.options.map((option) => {
                const selected = option.value === thinkingValue;
                return (
                  <button
                    key={option.value === null ? "default" : `variant-${option.value}`}
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
          <div className="flex max-h-[min(var(--available-height),28rem)] flex-col">
            <button
              type="button"
              className="flex cursor-pointer items-center gap-2 border-b border-border px-3 py-1.5 text-left hover:bg-accent"
              onClick={() => {
                setSearch("");
                setPane("root");
              }}
              ref={backButtonRef}
            >
              <ChevronLeft className="size-4 shrink-0 text-muted-foreground" />
              <span className="text-sm font-medium">Model</span>
            </button>
            <Command items={groups} value={search} onValueChange={setSearch}>
              <div className="flex min-h-0 flex-1 flex-col">
              <CommandHeader className="p-1.5 pb-1">
                <CommandInput ref={searchInputRef} autoFocus={false} placeholder="Search models..." className="h-9 text-base sm:text-base md:text-base lg:text-sm" />
              </CommandHeader>
              {openWorkModelsSyncing ? (
                <div className="mx-1 mb-1 flex items-center gap-2 rounded-md border border-border bg-muted/30 px-2 py-1.5">
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
                              data-model-key={modelRefKey(option)}
                              value={`${option.providerID}:${option.modelID} ${option.title} ${option.description ?? ""}`}
                              onClick={() => handleSelect(option)}
                              data-checked={isSameModel(value, option)}
                            >
                              <ProviderIcon providerId={option.providerID} providerName={option.description} className="size-3.5 opacity-70" size={14} />
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-foreground">{option.title}</span>
                                <span className="block truncate text-xs text-muted-foreground">{option.gatewayAuthorization ? "Sign-in required" : option.description ?? getProviderDisplayName(option.providerID)}</span>
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
