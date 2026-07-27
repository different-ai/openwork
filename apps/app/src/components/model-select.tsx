"use client";

import * as React from "react";
import { ChevronDown, ChevronRight, Settings2, Sparkles } from "lucide-react";
import { useNavigate } from "react-router-dom";

import type { ModelOption, ModelRef } from "@/app/types";
import { ProviderIcon } from "@/react-app/design-system/provider-icon";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { openModelPickerEvent } from "@/react-app/shell/new-providers-listener";
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
  onOpenChange: (open: boolean) => void;
  onChange: (model: ModelRef) => void;
  behaviorTitle: string;
  behaviorLabel: string;
  behaviorValue: string | null;
  behaviorOptions?: { value: string | null; label: string }[];
  onBehaviorChange: (value: string | null) => void;
  disabled?: boolean;
  /** When set, "All models" opens the full picker scoped to this session. */
  sessionId?: string;
  /** Den/import includes OpenWork Models — never show Subscribe while true. */
  openWorkModelsEntitled?: boolean;
}

export function ModelSelect({
  open,
  value,
  onOpenChange,
  onChange,
  behaviorTitle,
  behaviorLabel,
  behaviorValue,
  behaviorOptions,
  onBehaviorChange,
  disabled = false,
  sessionId,
  openWorkModelsEntitled = false,
}: ModelSelectProps) {
  const [search, setSearch] = React.useState("");
  const [modelSubmenuOpen, setModelSubmenuOpen] = React.useState(false);
  const [promoHidden, setPromoHidden] = React.useState(isOpenWorkModelsPromoHidden);
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  const modelOptions = useModelOptions(open);
  const denAuth = useDenAuth();
  const navigate = useNavigate();
  const platform = usePlatform();
  const openWorkModelsPromoEligible = useOpenWorkModelsPromoEligibility();

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
    if (!modelSubmenuOpen) {
      return;
    }

    focusSearchInput();
  }, [focusSearchInput, modelSubmenuOpen]);

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
  const behaviorItems = React.useMemo(
    () => (behaviorOptions ?? []).flatMap((option) =>
      option.value ? [{ value: option.value, label: option.label }] : [],
    ),
    [behaviorOptions],
  );
  const selectedBehaviorValue = behaviorItems.some((option) => option.value === behaviorValue)
    ? behaviorValue
    : behaviorItems[0]?.value ?? null;

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

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(nextOpen) => {
        onOpenChange(nextOpen);

        if (!nextOpen) {
          setSearch("");
          setModelSubmenuOpen(false);
        }
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={disabled}
                  aria-label="Model settings"
                  aria-keyshortcuts="Meta+Alt+/"
                  data-model-settings-trigger
                />
              }
            />
          }
        >
          <span className="max-w-48 truncate">
            {selectedOption?.title ?? value.modelID ?? "Select model"}
          </span>
          {behaviorItems.length > 0 ? (
            <span className="text-muted-foreground">{behaviorLabel}</span>
          ) : null}
          <ChevronDown data-icon="inline-end" />
        </TooltipTrigger>
        <TooltipContent>
          Model settings
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={8}
        className="min-w-72"
        data-model-settings-content
      >
        <DropdownMenuGroup>
          <DropdownMenuSub open={modelSubmenuOpen} onOpenChange={setModelSubmenuOpen}>
            <DropdownMenuSubTrigger data-model-settings-model-trigger>
              <span>Model</span>
              <span className="ms-auto max-w-40 truncate text-muted-foreground">
                {selectedOption?.title ?? value.modelID ?? "Select model"}
              </span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent
              className="h-80 w-72 overflow-hidden p-px **:data-[slot=scroll-area-viewport]:data-has-overflow-y:pe-0.5"
              data-model-settings-model-content
            >
              <Command items={groups} value={search} onValueChange={setSearch}>
                <CommandHeader>
                  <CommandInput
                    ref={searchInputRef}
                    placeholder="Search models..."
                    onKeyDown={(event) => event.stopPropagation()}
                  />
                </CommandHeader>
                <CommandEmpty>No models found.</CommandEmpty>
                <CommandList>
                  {(group: ModelSelectGroup) => (
                    <CommandGroup
                      key={group.value}
                      items={group.items}
                    >
                      <CommandGroupLabel className={group.promo ? "flex items-center gap-1.5 text-foreground" : undefined}>
                        {group.promo ? <Sparkles className="size-3 text-info-foreground" /> : null}
                        {group.value}
                      </CommandGroupLabel>
                      <CommandCollection>
                        {(item: ModelSelectItem) => {
                          if (item.kind === "openwork") {
                            return (
                              <CommandItem
                                className="gap-2 border border-info/30 bg-info-muted/40 data-highlighted:bg-info-muted"
                                key={item.id}
                                value={`${OPENWORK_MODELS_PROVIDER_NAME} ${item.title} ${item.id} sign in subscribe`}
                                onClick={handleOpenWorkModels}
                              >
                                <ProviderIcon
                                  providerId={OPENWORK_MODELS_PROVIDER_ID}
                                  providerName={OPENWORK_MODELS_PROVIDER_NAME}
                                  className="size-3.5 text-info-foreground"
                                  size={14}
                                />
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate text-foreground">
                                    {item.title}
                                  </span>
                                  <span className="block truncate text-xs text-muted-foreground">
                                    {item.subtitle} - {denAuth.isSignedIn ? "Subscribe to add this model" : "Sign in to unlock"}
                                  </span>
                                </span>
                                <span className="shrink-0 rounded-full border border-info/30 bg-info-muted px-1.5 py-0.5 text-[10px] font-medium text-info-foreground">
                                  {denAuth.isSignedIn ? "Subscribe" : "Sign in"}
                                </span>
                                <ChevronRight className="size-3.5 text-info-foreground" />
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
                    </CommandGroup>
                  )}
                </CommandList>
                <div className="border-t border-border px-2 py-1.5">
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="flex-1 justify-start"
                      onClick={() => {
                        onOpenChange(false);
                        setSearch("");
                        window.dispatchEvent(new CustomEvent(openModelPickerEvent));
                      }}
                    >
                      <Settings2 data-icon="inline-start" />
                      All models
                    </Button>
                    {showOpenWorkModelsPromo ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={handleHideOpenWorkModels}
                      >
                        Hide
                      </Button>
                    ) : null}
                  </div>
                </div>
              </Command>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          {behaviorItems.length > 0 ? (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger data-model-settings-effort-trigger>
                <span>{behaviorTitle}</span>
                <span className="ms-auto text-muted-foreground">{behaviorLabel}</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent data-model-settings-effort-content>
                <DropdownMenuGroup>
                  <DropdownMenuLabel>{behaviorTitle}</DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={selectedBehaviorValue}
                    onValueChange={(nextValue) => {
                      const option = behaviorItems.find((item) => item.value === nextValue);
                      if (option) onBehaviorChange(option.value);
                    }}
                  >
                    {behaviorItems.map((option) => (
                      <DropdownMenuRadioItem
                        key={option.value}
                        value={option.value}
                        data-model-settings-effort-option={option.value}
                      >
                        {option.label}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ) : null}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
