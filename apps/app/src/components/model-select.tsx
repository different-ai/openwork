"use client";

import * as React from "react";
import { ChevronDown, Settings2 } from "lucide-react";
import { useNavigate } from "react-router-dom";

import type { ModelOption, ModelRef } from "@/app/types";
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
import { usePlatform } from "@/react-app/kernel/platform";
import { useCheckDesktopRestriction } from "@/react-app/domains/cloud/desktop-config-provider";
import { useDenAuth } from "@/react-app/domains/cloud/den-auth-provider";
import {
  getOpenWorkModelsActionUrl,
  hasOpenWorkModelsProvider,
  hideOpenWorkModelsPromo,
  useOpenWorkModelsPromoEligibility,
  isOpenWorkModelsPromoHidden,
  OPENWORK_MODEL_PREVIEWS,
  OPENWORK_MODELS_PROVIDER_ID,
  OPENWORK_MODELS_PROVIDER_NAME,
  openWorkModelsPromoChangedEvent,
} from "@/react-app/domains/cloud/openwork-models-promo";
import { getConnectedProviderItems, useProviderListQuery } from "@/react-app/infra/provider-list-query";
import { filterEntitledModelOptions } from "@/react-app/domains/connections/provider-auth/provider-policy";
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
} from "@/components/ui/command";
import { openModelPickerEvent, openProviderAuthEvent } from "@/react-app/shell/new-providers-listener";
import { newProvidersEvent } from "@/app/lib/provider-events";

function getProviderDisplayName(providerId: string) {
  return providerId
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function useModelOptions(open: boolean) {
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
        Object.entries(provider.models).map(([id, model]) => ({
          providerID: provider.id,
          modelID: id,
          title: model.name,
          description: provider.name,
          behaviorTitle: "Reasoning",
          behaviorLabel: "Default",
          behaviorDescription: "",
          behaviorValue: null,
          isFree: false,
        })),
      );

    return filterEntitledModelOptions(options, {
      restrictToCloud,
      checkRestriction: checkDesktopRestriction,
    });
  }, [checkDesktopRestriction, data]);
}

type ModelSelectModelItem = {
  kind: "model";
  id: string;
  option: ModelOption;
};

type ModelSelectOpenWorkItem = {
  kind: "openwork";
  id: string;
  title: string;
  subtitle: string;
};

type ModelSelectItem = ModelSelectModelItem | ModelSelectOpenWorkItem;

type ModelSelectGroup = {
  value: string;
  items: ModelSelectItem[];
  promo: boolean;
};

function groupByProvider(modelOptions: ModelOption[]): ModelSelectGroup[] {
  const groups = new Map<string, ModelSelectModelItem[]>();

  for (const option of modelOptions) {
    const providerLabel = option.description ?? getProviderDisplayName(option.providerID);
    const item: ModelSelectModelItem = {
      kind: "model",
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
      promo: false,
    }))
    .sort((a, b) => a.value.localeCompare(b.value));
}

function openWorkModelsGroup(): ModelSelectGroup {
  return {
    value: OPENWORK_MODELS_PROVIDER_NAME,
    promo: true,
    items: OPENWORK_MODEL_PREVIEWS.map((model) => ({
      kind: "openwork",
      id: model.id,
      title: model.title,
      subtitle: model.subtitle,
    })),
  };
}

function isSameModel(a: ModelRef, b: ModelRef) {
  return a.providerID === b.providerID && a.modelID === b.modelID;
}

interface ModelSelectProps {
  open: boolean;
  value: ModelRef;
  hideValue?: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (model: ModelRef) => void;
  disabled?: boolean;
  /** When set, "All models" opens the full picker scoped to this session. */
  sessionId?: string;
  /** Den/import includes OpenWork Models — never show Subscribe while true. */
  openWorkModelsEntitled?: boolean;
}

export function ModelSelect({
  open,
  value,
  hideValue = false,
  onOpenChange,
  onChange,
  disabled = false,
  sessionId,
  openWorkModelsEntitled = false,
}: ModelSelectProps) {
  const [search, setSearch] = React.useState("");
  const [promoHidden, setPromoHidden] = React.useState(isOpenWorkModelsPromoHidden);
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  const modelOptions = useModelOptions(open);
  const denAuth = useDenAuth();
  const navigate = useNavigate();
  const platform = usePlatform();
  const openWorkModelsPromoEligible = useOpenWorkModelsPromoEligibility();
  const checkDesktopRestriction = useCheckDesktopRestriction();
  const canAddProviders = !checkDesktopRestriction({ restriction: "allowCustomProviders" });

  React.useEffect(() => {
    const handlePromoChanged = () => setPromoHidden(isOpenWorkModelsPromoHidden());
    window.addEventListener(openWorkModelsPromoChangedEvent, handlePromoChanged);
    return () => window.removeEventListener(openWorkModelsPromoChangedEvent, handlePromoChanged);
  }, []);

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

    focusSearchInput();
  }, [focusSearchInput, open]);

  const selectedOption = modelOptions?.find((option) =>
    isSameModel(value, {
      providerID: option.providerID,
      modelID: option.modelID,
    }),
  );

  const openWorkModelsAvailable = React.useMemo(
    () => hasOpenWorkModelsProvider(modelOptions.map((option) => option.providerID)),
    [modelOptions],
  );
  const showOpenWorkModelsSyncing = openWorkModelsEntitled && !openWorkModelsAvailable;
  const showOpenWorkModelsPromo = React.useMemo(
    () =>
      openWorkModelsPromoEligible &&
      !promoHidden &&
      !openWorkModelsAvailable &&
      !openWorkModelsEntitled,
    [openWorkModelsAvailable, openWorkModelsEntitled, openWorkModelsPromoEligible, promoHidden],
  );

  const groups = React.useMemo(() => {
    const providerGroups = groupByProvider(modelOptions);
    return showOpenWorkModelsPromo
      ? [openWorkModelsGroup(), ...providerGroups]
      : providerGroups;
  }, [modelOptions, showOpenWorkModelsPromo]);

  const handleSelect = (option: ModelOption) => {
    onChange({ providerID: option.providerID, modelID: option.modelID });
    setSearch("");
    onOpenChange(false);
  };

  const handleOpenWorkModels = React.useCallback(() => {
    onOpenChange(false);
    setSearch("");
    if (!denAuth.isSignedIn) {
      navigate("/settings/cloud-account");
    }
    window.setTimeout(() => {
      platform.openLink(getOpenWorkModelsActionUrl(denAuth.isSignedIn));
    }, 0);
  }, [denAuth.isSignedIn, navigate, onOpenChange, platform]);

  const handleHideOpenWorkModels = React.useCallback(() => {
    hideOpenWorkModelsPromo();
    setPromoHidden(true);
  }, []);

  const handleConnectProvider = React.useCallback(() => {
    onOpenChange(false);
    setSearch("");
    window.dispatchEvent(new Event(openProviderAuthEvent));
  }, [onOpenChange]);

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        onOpenChange(nextOpen);

        if (!nextOpen) {
          setSearch("");
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
              className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-gray-10 transition-colors hover:bg-gray-3 hover:text-gray-12 disabled:pointer-events-none disabled:opacity-60"
            />
          }
        >
          <span className="max-w-48 truncate">
            {hideValue ? "Select model" : (selectedOption?.title ?? value.modelID ?? "Select model")}
          </span>
          <ChevronDown className="h-3 w-3" />
        </TooltipTrigger>
        <TooltipContent>
          Change model
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        className="h-80 max-h-(--available-height) w-72 gap-0 overflow-hidden p-px **:data-[slot=scroll-area-viewport]:data-has-overflow-y:pe-0.5"
        align="start"
        initialFocus={false}
      >
        <Command items={groups} value={search} onValueChange={setSearch}>
          <CommandHeader>
            <CommandInput
              ref={searchInputRef}
              placeholder="Search models..."
            />
          </CommandHeader>
          <CommandEmpty>No models found.</CommandEmpty>
          {showOpenWorkModelsSyncing ? (
            <div className="mx-1 mb-1 flex items-center gap-2 rounded-md border border-amber-6/60 bg-amber-2/40 px-2 py-1.5">
              <ProviderIcon
                providerId={OPENWORK_MODELS_PROVIDER_ID}
                providerName={OPENWORK_MODELS_PROVIDER_NAME}
                className="size-3.5 shrink-0 text-amber-11"
                size={14}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium text-foreground">
                  {OPENWORK_MODELS_PROVIDER_NAME}
                </span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  Included — syncing into this workspace…
                </span>
              </span>
            </div>
          ) : null}
          <CommandList>
            {(group: ModelSelectGroup) => (
              <CommandGroup
                key={group.value}
                items={group.items}
              >
                <CommandGroupLabel className={group.promo ? "flex items-baseline justify-between gap-2" : undefined}>
                  {group.promo ? (
                    <>
                      <span>{group.value}</span>
                      <span className="shrink-0 font-normal text-muted-foreground">hosted · no API keys</span>
                    </>
                  ) : (
                    group.value
                  )}
                </CommandGroupLabel>
                <CommandCollection>
                  {(item: ModelSelectItem) => {
                    if (item.kind === "openwork") {
                      return (
                        <CommandItem
                          className="gap-2"
                          key={item.id}
                          value={`${OPENWORK_MODELS_PROVIDER_NAME} ${item.title} ${item.id} sign in subscribe`}
                          onClick={handleOpenWorkModels}
                        >
                          <ProviderIcon
                            providerId={OPENWORK_MODELS_PROVIDER_ID}
                            providerName={OPENWORK_MODELS_PROVIDER_NAME}
                            className="size-3.5 opacity-70"
                            size={14}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-foreground">
                              {item.title}
                            </span>
                          </span>
                        </CommandItem>
                      );
                    }

                    const option = item.option;
                    return (
                      <CommandItem
                        className="gap-2"
                        key={item.id}
                        value={`${option.providerID}:${option.modelID} ${option.title} ${option.description ?? ""}`}
                        onClick={() => handleSelect(option)}
                        data-checked={isSameModel(value, option)}
                      >
                        <ProviderIcon
                          providerId={option.providerID}
                          providerName={option.description}
                          className="size-3.5 opacity-70"
                          size={14}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-foreground">
                            {option.title}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {option.description ??
                              getProviderDisplayName(option.providerID)}
                          </span>
                        </span>
                      </CommandItem>
                    );
                  }}
                </CommandCollection>
                {group.promo ? (
                  <button
                    type="button"
                    className="mx-1 mb-1.5 mt-1 flex w-[calc(100%-0.5rem)] items-center gap-2 rounded-md bg-blue-2 px-3 py-2 text-left transition-colors hover:bg-blue-3"
                    onClick={handleOpenWorkModels}
                  >
                    <span className="min-w-0 flex-1 text-xs leading-4 text-foreground">
                      One subscription unlocks these in every workspace.
                    </span>
                    <span className="shrink-0 text-xs font-semibold text-blue-11">
                      {denAuth.isSignedIn ? "Enable →" : "Sign in →"}
                    </span>
                  </button>
                ) : null}
              </CommandGroup>
            )}
          </CommandList>
          {/* Your API keys → provider configuration */}
          {canAddProviders ? (
            <div className="border-t border-border p-1">
              <div className="flex items-baseline px-2 pb-0.5 pt-1 text-xs text-muted-foreground">
                Your API keys
              </div>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                onClick={handleConnectProvider}
              >
                <span className="min-w-0 flex-1 truncate text-foreground">
                  Anthropic, OpenAI, Google…
                </span>
                <span className="shrink-0 text-xs font-medium text-muted-foreground">
                  Connect
                </span>
              </button>
            </div>
          ) : null}
          {/* Link to full model picker */}
          <div className="border-t border-border px-2 py-1.5">
            <div className="flex items-center gap-1">
              <button
                type="button"
                className="flex flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                onClick={() => {
                  onOpenChange(false);
                  setSearch("");
                  window.dispatchEvent(new CustomEvent(openModelPickerEvent, sessionId ? { detail: { sessionId } } : undefined));
                }}
              >
                <Settings2 className="size-3.5" />
                All models
              </button>
              {showOpenWorkModelsPromo ? (
                <button
                  type="button"
                  className="shrink-0 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                  onClick={handleHideOpenWorkModels}
                >
                  Hide
                </button>
              ) : null}
            </div>
          </div>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
