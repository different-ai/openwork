"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";

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
import { useCheckDesktopRestriction } from "@/react-app/domains/cloud/desktop-config-provider";
import { getConnectedProviderItems, useProviderListQuery } from "@/react-app/domains/connections/provider-list-query";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { isDesktopProviderBlocked } from "@/app/cloud/desktop-app-restrictions";
import { readHiddenModels } from "@/react-app/domains/session/modals/model-picker-modal";
import { Settings2 } from "lucide-react";
import { openModelPickerEvent } from "@/react-app/shell/new-providers-toast";
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
  //   - `blockZenModel` hides the built-in OpenCode provider entries
  //   - `disallowNonCloudModels` hides providers that OpenCode does not report
  //     as connected through the provider list endpoint.
  return React.useMemo(() => {
    const restrictToCloud = checkDesktopRestriction({
      restriction: "disallowNonCloudModels",
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
          isConnected: true,
        })),
      );

    return options.filter((option) => {
      if (
        isDesktopProviderBlocked({
          providerId: option.providerID,
          checkRestriction: checkDesktopRestriction,
        })
      ) {
        return false;
      }

      if (restrictToCloud && !option.isConnected) {
        return false;
      }

      return true;
    });
  }, [checkDesktopRestriction, data]);
}

function groupByProvider(modelOptions: ModelOption[]) {
  const groups = new Map<string, ModelOption[]>();

  for (const option of modelOptions) {
    const providerLabel = option.description ?? getProviderDisplayName(option.providerID);
    const existing = groups.get(providerLabel);

    if (existing) {
      existing.push(option);
      continue;
    }

    groups.set(providerLabel, [option]);
  }

  return [...groups.entries()].map(([providerLabel, options]) => ({
    providerLabel,
    options,
  }));
}

function isSameModel(a: ModelRef, b: ModelRef) {
  return a.providerID === b.providerID && a.modelID === b.modelID;
}

interface ModelSelectProps {
  open: boolean;
  value: ModelRef;
  onOpenChange: (open: boolean) => void;
  onChange: (model: ModelRef) => void;
  disabled?: boolean;
}

export function ModelSelect({
  open,
  value,
  onOpenChange,
  onChange,
  disabled = false,
}: ModelSelectProps) {
  const [search, setSearch] = React.useState("");
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  const modelOptions = useModelOptions(open);

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

  // Filter out models the user has hidden via the "Available models" tab.
  // Re-read localStorage when the popover opens so changes from the
  // model picker modal are picked up immediately.
  const visibleOptions = React.useMemo(() => {
    const hidden = readHiddenModels();
    if (hidden.size === 0) return modelOptions ?? [];
    return (modelOptions ?? []).filter(
      (opt) => !hidden.has(`${opt.providerID}/${opt.modelID}`),
    );
  }, [modelOptions, open]);

  const groups = React.useMemo(
    () => groupByProvider(visibleOptions),
    [visibleOptions],
  );

  const handleSelect = (option: ModelOption) => {
    onChange({ providerID: option.providerID, modelID: option.modelID });
    setSearch("");
    onOpenChange(false);
  };

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
            {selectedOption?.title ?? value.modelID ?? "Select model"}
          </span>
          <ChevronDown className="h-3 w-3" />
        </TooltipTrigger>
        <TooltipContent>
          Change model
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        className="w-72 gap-0 p-0"
        align="start"
        initialFocus={false}
      >
        <Command
          value={`${value.providerID}:${value.modelID}`}
          filter={(value, search, keywords) => {
            const haystack = (keywords ?? []).join(" ").toLowerCase();

            return haystack.includes(search.toLowerCase()) ? 1 : 0;
          }}
        >
          <CommandInput
            ref={searchInputRef}
            value={search}
            onValueChange={setSearch}
            placeholder="Search models..."
          />
          <CommandList>
            <CommandEmpty>No models found.</CommandEmpty>
            {groups.map((group) => (
              <CommandGroup
                key={group.providerLabel}
                heading={group.providerLabel}
              >
                {group.options.map((option) => (
                  <CommandItem
                    key={`${option.providerID}:${option.modelID}`}
                    value={`${option.providerID}:${option.modelID}`}
                    keywords={[option.title, group.providerLabel]}
                    onSelect={() => handleSelect(option)}
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
                ))}
              </CommandGroup>
            ))}
          </CommandList>
          {/* Link to full model picker */}
          <div className="border-t border-border px-2 py-1.5">
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
              onClick={() => {
                onOpenChange(false);
                setSearch("");
                window.dispatchEvent(new CustomEvent(openModelPickerEvent));
              }}
            >
              <Settings2 className="size-3.5" />
              Browse all models
            </button>
          </div>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
