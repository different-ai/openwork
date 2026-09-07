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
  resolveSessionNumberShortcutOs,
  sessionNumberShortcutHelp,
} from "./session-number-shortcuts";
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
  selectedModelLabel?: string;
  /** Optional — open a URL in the user's browser. Falls back to window.open. */
  onOpenUrl?: (url: string) => void;
  /** Optional: current session servers/artifacts exposed through Cmd/Ctrl+K. */
  accessibleTargets?: AccessibleTargetOption[];
  onOpenAccessibleTarget?: (target: AccessibleTargetOption) => void;
  onHideAccessibleTarget?: (target: AccessibleTargetOption) => void;
  /** Optional: sessions for the second mode. */
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
 * - Root mode: "New session", "Open settings", and a link into the Sessions submode.
 * - Sessions submode: fuzzy list of every session across workspaces.
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
  const sessionNumberOs = resolveSessionNumberShortcutOs(
    platform.os,
    typeof navigator === "undefined" ? "" : navigator.platform,
  );
  const sessionNumberHelp = useMemo(
    () => sessionNumberShortcutHelp(sessionNumberOs),
    [sessionNumberOs],
  );
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
    {
      id: "sessions",
      title: t("session.cmd_sessions_title"),
      detail: t("session.cmd_sessions_detail", undefined, {
        count: props.sessions.length.toLocaleString(),
      }),
      meta: t("session.cmd_sessions_meta"),
      keywords: ["tasks", "chats", "conversations", "history", "switch"],
      group: ACTIONS_GROUP,
      action: () => {
        setMode("sessions");
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
    {
      id: "session-number-shortcuts",
      ...sessionNumberHelp,
      keywords: ["keyboard", "shortcut", "switch session", "number"],
      group: ACTIONS_GROUP,
      action: () => {
        setMode("sessions");
      },
    },
    ...(hasNestedModelPicker || props.onOpenModelPicker
      ? [{
          id: "models",
          title: "Switch model",
          detail: "Choose the LLM that runs your next prompts",
          meta: props.selectedModelLabel ?? t("session.default_model"),
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
  ], [accessibleTargetCount, canMoveCurrentSessionToGroup, hasNestedModelPicker, props, sessionGroupCount, sessionNumberHelp]);

  const sessionItems = useMemo<PaletteItem[]>(
    () =>
      props.sessions.map((item) => ({
        id: `session:${item.workspaceId}:${item.sessionId}`,
        title: item.title,
        detail: item.workspaceTitle,
        meta: item.isActive
          ? t("session.cmd_current_workspace")
          : t("session.cmd_switch"),
        searchText: item.searchText,
        keywords: ["session", "task", "conversation", "workspace"],
        group: "sessions",
        action: () => {
          props.onClose();
          props.onOpenSession(item.workspaceId, item.sessionId);
        },
      })),
    [props],
  );

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
      ...sessionItems,
    ],
    [coreActionItems, props.extraItems, rootItems, sessionItems, settingsItems],
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

  const submodeItems = mode === "sessions"
    ? sessionItems
    : mode === "split-sessions"
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
          {mode === "sessions"
            ? t("session.palette_title_sessions")
            : mode === "split-sessions"
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
                  ? "Search actions, settings, and sessions…"
                  : mode === "sessions"
                  ? t("session.palette_placeholder_sessions")
                  : mode === "split-sessions"
                    ? "Search sessions and workspaces..."
                  : mode === "accessible-items"
                    ? "Search servers and artifacts..."
                    : mode === "agents"
                      ? t("session.palette_placeholder_agents")
                      : mode === "groups"
                        ? "Search groups..."
                        : mode === "models"
                          ? "Search models..."
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
