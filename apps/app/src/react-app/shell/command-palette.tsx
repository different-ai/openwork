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
import { useCheckDesktopRestriction } from "../domains/cloud/desktop-config-provider";
import { usePlatform } from "../kernel/platform";
import {
  buildCommandPaletteBehaviorItems,
  buildCommandPaletteModelItems,
  commandPaletteBackMode,
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
  onSelectModel?: (model: ModelRef, behavior: string | null) => void;
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
          detail: t("ui.palette_choose_any_session"),
          meta: t("ui.palette_meta_workbench"),
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
          detail: t("ui.palette_new_split_detail"),
          meta: t("ui.palette_meta_workbench"),
          searchText: "new side chat new split empty session side by side pane",
          action: () => {
            props.onClose();
            props.onCreateNewSplitSession?.();
          },
        }]
      : []),
    ...(hasNestedModelPicker || props.onOpenModelPicker
      ? [{
          id: "models",
          title: t("models.title"),
          detail: t("ui.palette_models_detail"),
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
          title: t("session_management.move_to_group"),
          detail: props.currentSessionForGroupMove
            ? t("ui.palette_move_session_to_group", { title: props.currentSessionForGroupMove.title })
            : t("ui.palette_move_to_group_detail"),
          meta: sessionGroupCount > 0 ? `${sessionGroupCount.toLocaleString()} ${t("session_management.group_name")}` : t("session_management.no_groups_yet"),
          searchText: "move to group add task session folder organize",
          group: ACTIONS_GROUP,
          action: () => {
            setMode("groups");
          },
        }]
      : []),
    {
      id: "accessible-items",
      title: t("ui.palette_accessible_items"),
      detail: accessibleTargetCount > 0
        ? t("ui.palette_accessible_open", { count: accessibleTargetCount.toLocaleString() })
        : t("ui.palette_accessible_none"),
      meta: t("ui.palette_meta_session"),
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
  ], [accessibleTargetCount, canMoveCurrentSessionToGroup, hasNestedModelPicker, props, sessionGroupCount]);

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
          title: t("ui.toggle_sidebar"),
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
          title: t("ui.automations"),
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
          title: t("ui.dashboard"),
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
          title: t("ui.palette_new_workspace"),
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
      title: t("welcome.sign_in_cloud"),
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
      meta: item.isActive ? t("session.cmd_current_workspace") : t("ui.palette_other_workspace"),
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
        meta: target.kind === "url" ? t("ui.palette_meta_server") : t("ui.palette_meta_artifact"),
        searchText: `${target.name} ${target.value} ${target.preview}`.toLowerCase(),
        action: () => {
          props.onClose();
          props.onOpenAccessibleTarget?.(target);
        },
      })),
      ...targets.map((target) => ({
        id: `accessible-hide:${target.id}`,
        title: t("ui.palette_stop_tracking", { name: target.name || target.value }),
        detail: target.value,
        meta: t("ui.palette_meta_hide"),
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
      meta: props.currentSessionGroupId === group.id ? t("ui.palette_meta_current") : undefined,
      searchText: `group ${group.label}`.toLowerCase(),
      action: () => {
        props.onClose();
        props.onMoveCurrentSessionToGroup?.(group.id);
      },
    }))
  ), [props]);

  const modelItems = useMemo<PaletteItem[]>(() => (
    buildCommandPaletteModelItems(props.modelOptions ?? [], props.selectedModel).map((item) => ({
      id: item.id,
      title: item.title,
      detail: item.detail,
      meta: item.meta,
      searchText: item.searchText,
      disabled: item.option.disabled,
      action: () => {
        if ((item.option.behaviorOptions?.length ?? 0) > 0) {
          setBehaviorModel(item.option);
          setMode("model-behavior");
          return;
        }
        props.onSelectModel?.(
          { providerID: item.option.providerID, modelID: item.option.modelID },
          null,
        );
        props.onClose();
      },
    }))
  ), [props.modelOptions, props.onClose, props.onSelectModel, props.selectedModel]);

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
        props.onSelectModel?.(
          { providerID: behaviorModel.providerID, modelID: behaviorModel.modelID },
          item.option.value,
        );
        props.onClose();
      },
    }));
  }, [behaviorModel, props.onClose, props.onSelectModel, props.selectedModel, props.selectedModelBehavior]);

  const navigateBack = () => {
    const nextMode = commandPaletteBackMode(mode);
    if (!nextMode) return;
    if (mode === "model-behavior") setBehaviorModel(null);
    setMode(nextMode);
  };

  const handleEscape = (event: ReactKeyboardEvent<HTMLElement>) => {
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

  const renderPaletteItem = (item: PaletteItem) => (
    <CommandItem
      key={item.id}
      value={mode === "root" ? item.id : item}
      data-command-palette-item={item.id}
      disabled={item.disabled}
      onClick={() => {
        setRecents(recordPaletteRecent(item.id));
        item.action();
      }}
    >
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
      {item.shortcut || item.meta ? (
        <CommandShortcut>{item.shortcut ?? item.meta}</CommandShortcut>
      ) : null}
    </CommandItem>
  );

  return (
    <CommandDialog open={props.open} onOpenChange={handleOpenChange}>
      <CommandDialogPopup onKeyDownCapture={handleEscape}>
        <CommandDialogTitle>
          {mode === "split-sessions"
              ? t("session_management.open_in_split_view")
            : mode === "accessible-items"
              ? t("ui.palette_accessible_items")
              : mode === "agents"
                ? t("session.cmd_agents_title")
                : mode === "groups"
                  ? t("session_management.move_to_group")
                  : mode === "models"
                    ? t("models.title")
                    : mode === "model-behavior"
                      ? behaviorModel?.behaviorTitle ?? t("ui.palette_thinking_effort")
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
                  ? t("ui.palette_search_actions")
                  : mode === "split-sessions"
                    ? t("ui.palette_search_sessions_workspaces")
                  : mode === "accessible-items"
                    ? t("ui.palette_search_servers_artifacts")
                    : mode === "agents"
                      ? t("session.palette_placeholder_agents")
                      : mode === "groups"
                        ? t("ui.palette_search_groups")
                        : mode === "models"
                          ? t("models.search_placeholder")
                          : mode === "model-behavior"
                            ? t("ui.palette_search_thinking_effort")
                        : t("session.palette_placeholder_actions")
              }
              onKeyDown={handleBackspace}
            />
          </CommandHeader>
          <CommandPanel>
            <CommandEmpty>{mode === "root" ? t("ui.palette_no_matches_root") : mode === "accessible-items" ? t("ui.palette_no_accessible") : mode === "groups" ? t("ui.palette_no_groups") : mode === "models" ? t("models.no_models_match_search") : mode === "model-behavior" ? t("ui.palette_no_thinking_effort") : t("session.palette_no_matches")}</CommandEmpty>
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
