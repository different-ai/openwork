/** @jsxImportSource react */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { Agent } from "@opencode-ai/sdk/v2/client";

import { t } from "@/i18n";
import {
  Command,
  CommandCollection,
  CommandDialog,
  CommandDialogPopup,
  CommandDialogTitle,
  CommandEmpty,
  CommandFooter,
  CommandHeader,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
  CommandShortcut,
} from "@/components/ui/command";
import { Button } from "@/components/ui/button";
import { ChevronLeftIcon } from "lucide-react";
import type { ModelOption, ModelRef } from "@/app/types";
import { useModelChoice } from "@/react-app/domains/models/use-model-catalog";
import { useCheckDesktopRestriction } from "../domains/cloud/desktop-config-provider";
import { usePlatform } from "../kernel/platform";
import { ModelSourceIcon } from "@/react-app/domains/models/model-picker-list";
import { ProviderIcon } from "../design-system/provider-icon";
import { resolveExtensionIconSrc } from "../design-system/extension-icon-src";
import { isAutoModel, modelTitle, publicModelTitle } from "@/react-app/domains/models/model-catalog";
import { useModelCollectionsStore } from "../domains/session/models/model-collections-store";
import {
  buildCommandPaletteBehaviorItems,
  buildCommandPaletteModelItems,
  commandPaletteBackMode,
  createCommandPaletteModelControls,
  type CommandPaletteMode,
} from "./command-palette-models";
import { buildCommandPaletteSplitSessions, type CommandPaletteSessionRef } from "./command-palette-sessions";
import { loadPaletteRecents, recordPaletteRecent } from "./command-palette-recents";
import {
  rankPaletteItems,
  type PaletteGroup,
  type PaletteItem,
  type PaletteResultGroup,
} from "./command-palette-search";
import { buildCommandPaletteSettingsItems } from "./command-palette-settings";

export type { PaletteItem } from "./command-palette-search";

const ACTIONS_GROUP: PaletteGroup = "actions";

function paletteItemSearchValue(item: unknown) {
  if (!item || typeof item !== "object") return "";
  const title = Reflect.get(item, "title");
  const detail = Reflect.get(item, "detail");
  const searchText = Reflect.get(item, "searchText");
  return [title, detail, searchText]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
}

export type AccessibleTargetOption = {
  id: string;
  kind: "url" | "file";
  value: string;
  name: string;
  preview: string;
};

export type SessionOption = {
  workspaceId: string;
  sessionId: string;
  title: string;
  workspaceTitle: string;
  updatedAt: number;
  searchText: string;
  isActive: boolean;
};

export type SessionGroupOption = {
  id: string;
  label: string;
};

export type CommandPaletteProps = {
  open: boolean;
  onClose: () => void;
  developerMode: boolean;
  /** Called when a session row is chosen. */
  onOpenSession: (workspaceId: string, sessionId: string) => void;
  /** Opens a chosen session beside the current session without navigating away. */
  onOpenSessionInSplit?: (workspaceId: string, sessionId: string) => void;
  currentSession?: CommandPaletteSessionRef | null;
  /** Called when "New session" is chosen. */
  onCreateNewSession: () => void;
  /** Starts an empty session beside the current session. */
  onCreateNewSplitSession?: () => void;
  /** Called when "Open settings" is chosen. Accepts an optional route to jump straight to a tab. */
  onOpenSettings: (route?: string) => void;
  /** Called when the first-class Extensions page is chosen. */
  onOpenExtensions: (section?: string) => void;
  onToggleSidebar?: () => void;
  onOpenAutomations?: () => void;
  onOpenDashboard?: () => void;
  onCreateWorkspace?: () => void;
  /** Optional: open the full default-model picker. */
  onOpenModelPicker?: () => void;
  /** Optional: model data for the nested model and effort modes. */
  modelOptions?: ModelOption[];
  selectedModel?: ModelRef;
  selectedModelBehavior?: string | null;
  onSelectModel?: (model: ModelRef, behavior?: string | null) => void;
  onNextPinnedModel?: () => void;
  onCycleModelSource?: () => void;
  /** Optional — open a URL in the user's browser. Falls back to window.open. */
  onOpenUrl?: (url: string) => void;
  /** Optional: current session servers/artifacts exposed through Cmd/Ctrl+K. */
  accessibleTargets?: AccessibleTargetOption[];
  onOpenAccessibleTarget?: (target: AccessibleTargetOption) => void;
  onHideAccessibleTarget?: (target: AccessibleTargetOption) => void;
  /** Sessions available to the split-view picker. */
  sessions: SessionOption[];
  sessionGroups?: SessionGroupOption[];
  currentSessionForGroupMove?: { title: string } | null;
  currentSessionGroupId?: string | null;
  onMoveCurrentSessionToGroup?: (groupId: string) => void;
  extraItems?: PaletteItem[];
  /** Optional: agent picker submode (Switch agent). */
  listAgents?: () => Promise<Agent[]>;
  selectedAgent?: string | null;
  onSelectAgent?: (agent: string | null) => void;
};

/**
 * React command palette (Cmd/Ctrl+K).
 *
 * Root mode searches actions and settings, not conversations.
 */
export function CommandPalette(props: CommandPaletteProps) {
  const platform = usePlatform();
  const [mode, setMode] = useState<CommandPaletteMode>("root");
  const [query, setQuery] = useState("");
  const [recents, setRecents] = useState(loadPaletteRecents);
  const [behaviorModel, setBehaviorModel] = useState<ModelOption | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!props.open) {
      setMode("root");
      setBehaviorModel(null);
      setQuery("");
    }
  }, [props.open]);

  useEffect(() => {
    if (mode !== "root") setQuery("");
  }, [mode]);

  useEffect(() => {
    if (!props.open) return;
    const frame = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => searchInputRef.current?.focus());
    });
    return () => window.cancelAnimationFrame(frame);
  }, [mode, props.open]);

  // Fetch agents lazily when the submode opens so the palette stays instant.
  const listAgents = props.listAgents;
  useEffect(() => {
    if (mode !== "agents" || !listAgents) return;
    let cancelled = false;
    void listAgents()
      .then((next) => {
        if (!cancelled) setAgents(next);
      })
      .catch(() => {
        if (!cancelled) setAgents([]);
      });
    return () => {
      cancelled = true;
    };
  }, [mode, listAgents]);

  const openUrl = (url: string) => {
    if (props.onOpenUrl) {
      props.onOpenUrl(url);
    } else {
      window.open(url, "_blank", "noopener");
    }
  };

  const accessibleTargetCount = props.accessibleTargets?.length ?? 0;
  const sessionGroupCount = props.sessionGroups?.length ?? 0;
  const canMoveCurrentSessionToGroup = Boolean(props.currentSessionForGroupMove && props.onMoveCurrentSessionToGroup);
  const hasNestedModelPicker = props.modelOptions !== undefined && props.onSelectModel !== undefined;
  const favorites = useModelCollectionsStore((state) => state.favorites);
  const recentModels = useModelCollectionsStore((state) => state.recent);
  const choice = useModelChoice(JSON.stringify([props.selectedModel, props.selectedModelBehavior]));
  const modelControls = createCommandPaletteModelControls({ options: props.modelOptions ?? [], current: props.selectedModel,
    behavior: props.selectedModelBehavior, favorites, onSelect: (model, behavior, option) => {
      choice.choose(option, () => props.onSelectModel?.(model, behavior));
    } });
  const currentModelOption = props.modelOptions?.find((option) => option.providerID === props.selectedModel?.providerID && option.modelID === props.selectedModel.modelID);
  const currentModelTitle = currentModelOption ? publicModelTitle(currentModelOption) : undefined;
  // Organization policy (`allowControlSettings`) can hide desktop settings;
  // the settings palette entries follow the same allow-list as the settings nav.
  const checkDesktopRestriction = useCheckDesktopRestriction();

  const rootItems = useMemo<PaletteItem[]>(() => [
    {
      id: "new-session",
      title: t("session.cmd_new_session_title"),
      detail: t("session.cmd_new_session_detail"),
      meta: t("session.cmd_new_session_meta"),
      keywords: ["new task", "new chat", "conversation", "start"],
      group: ACTIONS_GROUP,
      action: () => {
        props.onClose();
        props.onCreateNewSession();
      },
    },
    ...(props.onOpenSessionInSplit && props.currentSession
      ? [{
          id: "open-in-split-view",
          title: `${t("session_management.open_in_split_view")}…`,
          detail: "Choose any session, including one from another workspace",
          meta: "Workbench",
          searchText: "side chat split view side by side session workspace",
          group: ACTIONS_GROUP,
          action: () => {
            setMode("split-sessions");
          },
        }]
      : []),
    ...(props.onCreateNewSplitSession && props.currentSession
      ? [{
          id: "new-split",
          title: t("session_management.new_split"),
          detail: "Start an empty session beside this one",
          meta: "Workbench",
          searchText: "new side chat new split empty session side by side pane",
          action: () => {
            props.onClose();
            props.onCreateNewSplitSession?.();
          },
        }]
      : []),
    ...(hasNestedModelPicker || props.onNextPinnedModel ? [{ id: "models.next-pinned", title: "Next pinned model", shortcut: "Ctrl+Shift+M", group: ACTIONS_GROUP,
      detail: modelControls.nextPinnedOption ? [currentModelTitle, modelTitle(modelControls.nextPinnedOption)].filter(Boolean).join(" → ") : "No alternative pinned model",
      disabled: !modelControls.nextPinnedOption,
      action: () => { (props.onNextPinnedModel ?? modelControls.onNextPinnedModel)(); props.onClose(); } }] : []),
    ...(hasNestedModelPicker || props.onCycleModelSource ? [{ id: "models.next-source", title: "Cycle model source", shortcut: "Ctrl+Alt+M", group: ACTIONS_GROUP,
      detail: modelControls.sourceCycleDetail || "No accessible model sources", disabled: !modelControls.nextSourceOption,
      action: () => { (props.onCycleModelSource ?? modelControls.onCycleModelSource)(); props.onClose(); } }] : []),
    ...(hasNestedModelPicker || props.onOpenModelPicker
      ? [{
          id: "models",
          title: "Models",
          meta: currentModelTitle,
          detail: "Choose the LLM that runs your next prompts",
          searchText: "model models llm provider openai anthropic claude gpt gemini switch pick select default",
          group: ACTIONS_GROUP,
          action: () => {
            if (hasNestedModelPicker) {
              setBehaviorModel(null);
              setMode("models");
              return;
            }
            props.onClose();
            props.onOpenModelPicker?.();
          },
        }]
      : []),
    ...(props.listAgents
      ? [{
          id: "agents",
          title: t("session.cmd_agents_title"),
          detail: t("session.cmd_agents_detail"),
          meta: props.selectedAgent
            ? props.selectedAgent.charAt(0).toUpperCase() + props.selectedAgent.slice(1)
            : t("session.default_agent"),
          searchText: "agent agents switch pick select default build plan",
          group: ACTIONS_GROUP,
          action: () => {
            setMode("agents");
          },
        }]
      : []),
    ...(canMoveCurrentSessionToGroup
      ? [{
          id: "move-to-group",
          title: "Move to Group",
          detail: props.currentSessionForGroupMove
            ? `Add ${props.currentSessionForGroupMove.title} to an existing group`
            : "Add the selected task to an existing group",
          meta: sessionGroupCount > 0 ? `${sessionGroupCount.toLocaleString()} groups` : "No groups",
          searchText: "move to group add task session folder organize",
          group: ACTIONS_GROUP,
          action: () => {
            setMode("groups");
          },
        }]
      : []),
    {
      id: "accessible-items",
      title: "Accessible items",
      detail: accessibleTargetCount > 0
        ? `Open ${accessibleTargetCount.toLocaleString()} servers and artifacts detected in this session`
        : "No servers or artifacts detected in this session yet",
      meta: "Session",
      keywords: ["servers", "artifacts", "files", "urls", "open"],
      group: ACTIONS_GROUP,
      action: () => {
        setMode("accessible-items");
      },
    },
    // Top-bar shortcuts mirror the documentation and feedback controls.
    {
      id: "open-docs",
      title: t("session.support_docs"),
      meta: t("session.cmd_settings_meta"),
      keywords: ["help", "documentation", "guides", "support"],
      group: ACTIONS_GROUP,
      action: () => {
        props.onClose();
        openUrl("https://openwork.dev/docs");
      },
    },
    {
      id: "open-feedback",
      title: t("session.support_feedback"),
      meta: t("session.cmd_settings_meta"),
      keywords: ["feedback", "issue", "bug", "support"],
      group: ACTIONS_GROUP,
      action: () => {
        props.onClose();
        openUrl("https://openwork.dev/feedback");
      },
    },
  ], [accessibleTargetCount, canMoveCurrentSessionToGroup, hasNestedModelPicker, props, sessionGroupCount, currentModelTitle, modelControls]);

  const settingsItems = useMemo(
    () => buildCommandPaletteSettingsItems({
      developerMode: props.developerMode,
      capabilities: platform.capabilities,
      checkRestriction: checkDesktopRestriction,
      onOpenSettings: (route) => {
        props.onClose();
        props.onOpenSettings(route);
      },
      onOpenExtensions: (section) => {
        props.onClose();
        props.onOpenExtensions(section);
      },
    }),
    [
      checkDesktopRestriction,
      platform.capabilities,
      props.developerMode,
      props.onClose,
      props.onOpenExtensions,
      props.onOpenSettings,
    ],
  );

  const coreActionItems = useMemo<PaletteItem[]>(() => [
    ...(props.onToggleSidebar
      ? [{
          id: "sidebar.toggle",
          title: "Toggle sidebar",
          keywords: ["hide", "show", "sidebar", "collapse", "expand"],
          group: ACTIONS_GROUP,
          action: () => {
            props.onClose();
            props.onToggleSidebar?.();
          },
        }]
      : []),
    ...(props.onOpenAutomations
      ? [{
          id: "automations.open",
          title: "Automations",
          keywords: ["schedule", "scheduled", "recurring", "cron", "daily", "weekly"],
          group: ACTIONS_GROUP,
          action: () => {
            props.onClose();
            props.onOpenAutomations?.();
          },
        }]
      : []),
    ...(props.onOpenDashboard
      ? [{
          id: "dashboard.open",
          title: "Dashboard",
          keywords: ["home", "overview", "apps"],
          group: ACTIONS_GROUP,
          action: () => {
            props.onClose();
            props.onOpenDashboard?.();
          },
        }]
      : []),
    ...(props.onCreateWorkspace
      ? [{
          id: "workspace.create",
          title: "New workspace…",
          keywords: ["open folder", "add project", "directory"],
          group: ACTIONS_GROUP,
          action: () => {
            props.onClose();
            props.onCreateWorkspace?.();
          },
        }]
      : []),
    {
      id: "cloud.sign_in",
      title: "Sign in to OpenWork Cloud",
      keywords: ["login", "account", "organization", "org", "den", "cloud"],
      group: ACTIONS_GROUP,
      action: () => {
        props.onClose();
        props.onOpenSettings("/settings/cloud-account");
      },
    },
  ], [props]);

  const allRootItems = useMemo(
    () => [
      ...rootItems,
      ...coreActionItems,
      ...settingsItems,
      ...(props.extraItems ?? []),
    ],
    [coreActionItems, props.extraItems, rootItems, settingsItems],
  );

  const rootGroups = useMemo(
    () => rankPaletteItems(query, allRootItems, recents),
    [allRootItems, query, recents],
  );

  const splitSessionItems = useMemo<PaletteItem[]>(
    () => buildCommandPaletteSplitSessions(props.sessions, props.currentSession).map((item) => ({
      id: `split-session:${item.workspaceId}:${item.sessionId}`,
      title: item.title,
      detail: item.workspaceTitle,
      meta: item.isActive ? t("session.cmd_current_workspace") : "Other workspace",
      searchText: `${item.searchText} split side by side`,
      action: () => {
        props.onOpenSessionInSplit?.(item.workspaceId, item.sessionId);
        props.onClose();
      },
    })),
    [props.currentSession, props.onClose, props.onOpenSessionInSplit, props.sessions],
  );

  const accessibleItems = useMemo<PaletteItem[]>(() => {
    const targets = props.accessibleTargets ?? [];
    return [
      ...targets.map((target) => ({
        id: `accessible:${target.id}`,
        title: target.name || target.value,
        detail: target.value,
        meta: target.kind === "url" ? "Server" : "Artifact",
        searchText: `${target.name} ${target.value} ${target.preview}`.toLowerCase(),
        action: () => {
          props.onClose();
          props.onOpenAccessibleTarget?.(target);
        },
      })),
      ...targets.map((target) => ({
        id: `accessible-hide:${target.id}`,
        title: `Stop tracking ${target.name || target.value}`,
        detail: target.value,
        meta: "Hide",
        searchText: `stop tracking hide ${target.name} ${target.value} ${target.preview}`.toLowerCase(),
        action: () => {
          props.onClose();
          props.onHideAccessibleTarget?.(target);
        },
      })),
    ];
  }, [props]);

  const agentItems = useMemo<PaletteItem[]>(() => {
    const selectAgent = (name: string | null) => {
      props.onSelectAgent?.(name);
      props.onClose();
    };
    return [
      {
        id: "agent:default",
        title: t("session.default_agent"),
        detail: t("session.cmd_agent_default_detail"),
        meta: props.selectedAgent == null ? t("session.cmd_agent_active") : undefined,
        action: () => selectAgent(null),
      },
      ...agents.map((agent) => ({
        id: `agent:${agent.name}`,
        title: agent.name.charAt(0).toUpperCase() + agent.name.slice(1),
        detail: agent.description,
        meta: props.selectedAgent === agent.name ? t("session.cmd_agent_active") : undefined,
        searchText: `agent ${agent.name} ${agent.description ?? ""}`.toLowerCase(),
        action: () => selectAgent(agent.name),
      })),
    ];
  }, [agents, props]);

  const groupItems = useMemo<PaletteItem[]>(() => (
    (props.sessionGroups ?? []).map((group) => ({
      id: `group:${group.id}`,
      title: group.label,
      meta: props.currentSessionGroupId === group.id ? "Current" : undefined,
      searchText: `group ${group.label}`.toLowerCase(),
      action: () => {
        props.onClose();
        props.onMoveCurrentSessionToGroup?.(group.id);
      },
    }))
  ), [props]);

  const modelItems = useMemo<PaletteItem[]>(() => (
    buildCommandPaletteModelItems(props.modelOptions ?? [], props.selectedModel, favorites, recentModels).map((item) => ({
      id: item.id,
      title: item.title,
      detail: item.detail,
      meta: item.option.gatewayAuthorization ? "Sign-in required" : item.meta,
      searchText: item.searchText,
      disabled: item.option.disabled,
      action: () => {
        choice.choose(item.option, () => {
          props.onSelectModel?.({ providerID: item.option.providerID, modelID: item.option.modelID });
          props.onClose();
        });
      },
    }))
  ), [choice.choose, props.modelOptions, props.onClose, props.onSelectModel, props.selectedModel, favorites, recentModels]);

  const behaviorItems = useMemo<PaletteItem[]>(() => {
    if (!behaviorModel) return [];
    return buildCommandPaletteBehaviorItems(
      behaviorModel,
      props.selectedModel,
      props.selectedModelBehavior,
    ).map((item) => ({
      id: item.id,
      title: item.title,
      detail: item.detail,
      meta: item.meta,
      searchText: item.searchText,
      action: () => {
        const currentOption = props.modelOptions?.find((option) => option.providerID === behaviorModel.providerID && option.modelID === behaviorModel.modelID);
        if (!currentOption) return;
        choice.choose(currentOption, () => {
          props.onSelectModel?.({ providerID: behaviorModel.providerID, modelID: behaviorModel.modelID }, item.option.value);
          props.onClose();
        });
      },
    }));
  }, [behaviorModel, choice.choose, props.modelOptions, props.onClose, props.onSelectModel, props.selectedModel, props.selectedModelBehavior]);

  const navigateBack = () => {
    const nextMode = commandPaletteBackMode(mode);
    if (!nextMode) return;
    if (mode === "model-behavior") setBehaviorModel(null);
    setMode(nextMode);
  };

  const handleEscape = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (choice.loginOpen) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (mode !== "root") {
        navigateBack();
        return;
      }
      props.onClose();
    }
  };

  const handleBackspace = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (
      event.key === "Backspace" &&
      event.currentTarget.value === "" &&
      mode !== "root"
    ) {
      event.preventDefault();
      navigateBack();
    }
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      props.onClose();
    }
  };

  const submodeItems = mode === "split-sessions"
      ? splitSessionItems
    : mode === "accessible-items"
      ? accessibleItems
      : mode === "agents"
        ? agentItems
        : mode === "groups"
          ? groupItems
          : mode === "models"
            ? modelItems
            : mode === "model-behavior"
              ? behaviorItems
          : [];

  const paletteModels = useMemo(() => new Map((props.modelOptions ?? []).map((option) => [`model:${option.providerID}:${option.modelID}`, option])), [props.modelOptions]);
  const renderPaletteItem = (item: PaletteItem) => {
    const model = paletteModels.get(item.id);
    return <CommandItem
      key={item.id}
      value={mode === "root" ? item.id : item}
      data-command-palette-item={item.id}
      disabled={item.disabled}
      onClick={() => {
        setRecents(recordPaletteRecent(item.id));
        item.action();
      }}
    >
      {model ? <span data-slot="model-provider-mark" className="flex size-4 shrink-0 items-center justify-center">
        {isAutoModel(model) ? <img src={resolveExtensionIconSrc("/openwork-mark.svg")} alt="OpenWork" className="size-4" />
          : <ProviderIcon providerId={model.providerID} providerName={model.description} size={16} />}
      </span> : null}
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{item.title}</div>
        {item.breadcrumb || item.detail ? (
          <div className="truncate text-muted-foreground text-xs">
            {item.breadcrumb ? (
              <span className="text-muted-foreground/72">
                {item.breadcrumb}{item.detail ? " › " : ""}
              </span>
            ) : null}
            {item.detail}
          </div>
        ) : null}
        {item.searchText ? (
          <span className="sr-only">{item.searchText}</span>
        ) : null}
      </div>
      {model && !isAutoModel(model) ? <span data-slot="model-source" className="flex size-4 shrink-0 items-center justify-center"><ModelSourceIcon model={model} /></span> : null}
      {item.shortcut || item.meta ? (
        <CommandShortcut>{item.shortcut ?? item.meta}</CommandShortcut>
      ) : null}
    </CommandItem>;
  };

  return (
    <CommandDialog open={props.open} onOpenChange={handleOpenChange}>
      <CommandDialogPopup onKeyDownCapture={handleEscape}>
        <CommandDialogTitle>
          {mode === "split-sessions"
              ? t("session_management.open_in_split_view")
            : mode === "accessible-items"
              ? "Accessible items"
              : mode === "agents"
                ? t("session.cmd_agents_title")
                : mode === "groups"
                  ? "Move to Group"
                  : mode === "models"
                    ? "Models"
                    : mode === "model-behavior"
                      ? behaviorModel?.behaviorTitle ?? "Thinking / Effort"
                  : t("session.palette_title_actions")
          }
        </CommandDialogTitle>
        <Command
          key={mode}
          items={mode === "root" ? rootGroups : submodeItems}
          {...(mode === "root"
            ? { filter: null, value: query, onValueChange: setQuery }
            : { itemToStringValue: paletteItemSearchValue })}
        >
          <CommandHeader className="flex items-center gap-0">
            {mode !== "root" && (
              <Button variant="outline" size="icon-sm" className="rounded-xl" onClick={navigateBack}>
                <ChevronLeftIcon className="size-4" />
                <span className="sr-only">{t("common.back")}</span>
              </Button>
            )}
            <CommandInput
              ref={searchInputRef}
              data-command-palette-input
              className="w-full"
              placeholder={
                mode === "root"
                  ? "Search actions and settings…"
                  : mode === "split-sessions"
                    ? "Search sessions and workspaces..."
                  : mode === "accessible-items"
                    ? "Search servers and artifacts..."
                    : mode === "agents"
                      ? t("session.palette_placeholder_agents")
                      : mode === "groups"
                        ? "Search groups..."
                        : mode === "models"
                          ? "Search models…"
                          : mode === "model-behavior"
                            ? "Search thinking or effort..."
                        : t("session.palette_placeholder_actions")
              }
              onKeyDown={handleBackspace}
            />
          </CommandHeader>
          <CommandPanel>
            <CommandEmpty>{mode === "root" ? "No matches. Try a different word, or type > for actions only." : mode === "accessible-items" ? "No accessible items found for this session." : mode === "groups" ? "No groups found for this workspace." : mode === "models" ? "No models match your search." : mode === "model-behavior" ? "No thinking or effort options match your search." : t("session.palette_no_matches")}</CommandEmpty>
            <CommandList>
              {mode === "root"
                ? (group: PaletteResultGroup) => (
                    <CommandGroup
                      key={group.value}
                      items={group.items}
                      data-command-palette-group={group.value}
                    >
                      <CommandGroupLabel>{group.label}</CommandGroupLabel>
                      <CommandCollection>
                        {renderPaletteItem}
                      </CommandCollection>
                    </CommandGroup>
                  )
                : renderPaletteItem}
            </CommandList>
          </CommandPanel>
          <CommandFooter>
            <span>{t("session.palette_hint_navigate")}</span>
            <span>{t("session.palette_hint_run")}</span>
          </CommandFooter>
        </Command>
      </CommandDialogPopup>
    </CommandDialog>
  );
}
