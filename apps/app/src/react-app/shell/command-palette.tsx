/** @jsxImportSource react */
import {
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import type { Agent } from "@opencode-ai/sdk/v2/client";

import { t } from "@/i18n";
import {
  Command,
  CommandDialog,
  CommandDialogPopup,
  CommandDialogTitle,
  CommandEmpty,
  CommandFooter,
  CommandHeader,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
  CommandShortcut,
} from "@/components/ui/command";
import { Button } from "@/components/ui/button";
import { Check, ChevronLeftIcon, FileText, Globe, Zap } from "lucide-react";

export type PaletteItem = {
  id: string;
  title: string;
  detail?: string;
  meta?: string;
  icon?: ReactNode;
  searchText?: string;
  action: () => void;
};

export type AccessibleTargetOption = {
  id: string;
  kind: "url" | "file";
  value: string;
  name: string;
  preview: string;
};

type PaletteMode = "root" | "sessions" | "accessible-items" | "agents";

export type SessionOption = {
  workspaceId: string;
  sessionId: string;
  title: string;
  workspaceTitle: string;
  updatedAt: number;
  searchText: string;
  isActive: boolean;
};

function targetIcon(target: AccessibleTargetOption) {
  if (target.kind === "url") return <Globe className="size-4 text-primary" />;
  if (target.preview === "sheet") {
    return (
      <span className="inline-flex h-4 min-w-6 shrink-0 items-center justify-center rounded-[4px] border border-emerald-500/30 bg-emerald-500/10 px-0.5 text-[7px] font-bold leading-none text-emerald-700">
        XLS
      </span>
    );
  }
  if (target.preview === "markdown") {
    return (
      <span className="inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-primary/25 bg-primary/10 text-[8px] font-bold leading-none text-primary">
        MD
      </span>
    );
  }
  return <FileText className="size-4 text-primary" />;
}

export type CommandPaletteProps = {
  open: boolean;
  onClose: () => void;
  /** Called when a session row is chosen. */
  onOpenSession: (workspaceId: string, sessionId: string) => void;
  /** Called when "New session" is chosen. */
  onCreateNewSession: () => void;
  /** Called when "Open settings" is chosen. Accepts an optional route to jump straight to a tab. */
  onOpenSettings: (route?: string) => void;
  /** Optional — open a URL in the user's browser. Falls back to window.open. */
  onOpenUrl?: (url: string) => void;
  /** Optional: current session servers/artifacts exposed through Cmd/Ctrl+K. */
  accessibleTargets?: AccessibleTargetOption[];
  onOpenAccessibleTarget?: (target: AccessibleTargetOption) => void;
  onHideAccessibleTarget?: (target: AccessibleTargetOption) => void;
  /** Optional: sessions for the second mode. */
  sessions: SessionOption[];
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
  const [mode, setMode] = useState<PaletteMode>("root");
  const [agents, setAgents] = useState<Agent[]>([]);

  useEffect(() => {
    if (!props.open) {
      setMode("root");
    }
  }, [props.open]);

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

  const rootItems = useMemo<PaletteItem[]>(() => [
    {
      id: "new-session",
      title: t("session.cmd_new_session_title"),
      detail: t("session.cmd_new_session_detail"),
      meta: t("session.cmd_new_session_meta"),
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
      action: () => {
        setMode("sessions");
      },
    },
    ...(props.listAgents
      ? [{
          id: "agents",
          title: t("session.cmd_agents_title"),
          detail: t("session.cmd_agents_detail"),
          meta: props.selectedAgent
            ? props.selectedAgent.charAt(0).toUpperCase() + props.selectedAgent.slice(1)
            : t("session.default_agent"),
          searchText: "agent agents switch pick select default build plan",
          action: () => {
            setMode("agents");
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
      action: () => {
        setMode("accessible-items");
      },
    },
    ...(props.extraItems ?? []),
    {
      id: "open-settings",
      title: t("settings.tab_general"),
      detail: t("settings.tab_description_general"),
      meta: t("session.cmd_settings_meta"),
      action: () => {
        props.onClose();
        props.onOpenSettings();
      },
    },
    // Top-bar shortcuts — these used to be selectable via Cmd+K and were
    // missing after the React port. Each one mirrors one of the icons at
    // the bottom-right of the session surface (documentation / feedback)
    // plus every settings tab the user is likely to reach for.
    {
      id: "open-docs",
      title: t("session.support_docs"),
      meta: t("session.cmd_settings_meta"),
      action: () => {
        props.onClose();
        openUrl("https://openwork.dev/docs");
      },
    },
    {
      id: "open-feedback",
      title: t("session.support_feedback"),
      meta: t("session.cmd_settings_meta"),
      action: () => {
        props.onClose();
        openUrl("https://openwork.dev/feedback");
      },
    },
    {
      id: "settings-skills",
      title: t("settings.tab_skills"),
      detail: t("settings.tab_description_skills"),
      meta: t("session.cmd_settings_meta"),
      action: () => {
        props.onClose();
        props.onOpenSettings("/settings/skills");
      },
    },
    {
      id: "settings-extensions",
      title: t("settings.tab_extensions"),
      detail: t("settings.tab_description_extensions"),
      meta: t("session.cmd_settings_meta"),
      action: () => {
        props.onClose();
        props.onOpenSettings("/settings/extensions");
      },
    },
    {
      id: "settings-appearance",
      title: t("settings.tab_appearance"),
      detail: t("settings.tab_description_appearance"),
      meta: t("session.cmd_settings_meta"),
      action: () => {
        props.onClose();
        props.onOpenSettings("/settings/appearance");
      },
    },
    {
      id: "settings-recovery",
      title: t("settings.tab_recovery"),
      detail: t("settings.tab_description_recovery"),
      meta: t("session.cmd_settings_meta"),
      action: () => {
        props.onClose();
        props.onOpenSettings("/settings/recovery");
      },
    },
    {
      id: "settings-updates",
      title: t("settings.tab_updates"),
      detail: t("settings.tab_description_updates"),
      meta: t("session.cmd_settings_meta"),
      action: () => {
        props.onClose();
        props.onOpenSettings("/settings/updates");
      },
    },
  ], [accessibleTargetCount, props]);

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
        action: () => {
          props.onClose();
          props.onOpenSession(item.workspaceId, item.sessionId);
        },
      })),
    [props],
  );

  const accessibleItems = useMemo<PaletteItem[]>(() => {
    const targets = props.accessibleTargets ?? [];
    return [
      ...targets.map((target) => ({
        id: `accessible:${target.id}`,
        title: target.name || target.value,
        detail: target.value,
        meta: target.kind === "url" ? "Server" : "Artifact",
        icon: targetIcon(target),
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
        icon: targetIcon(target),
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
        icon: props.selectedAgent == null
          ? <Check className="size-4 text-primary" />
          : <Zap className="size-4 text-muted-foreground" />,
        action: () => selectAgent(null),
      },
      ...agents.map((agent) => ({
        id: `agent:${agent.name}`,
        title: agent.name.charAt(0).toUpperCase() + agent.name.slice(1),
        detail: agent.description,
        meta: props.selectedAgent === agent.name ? t("session.cmd_agent_active") : undefined,
        icon: props.selectedAgent === agent.name
          ? <Check className="size-4 text-primary" />
          : <Zap className="size-4 text-muted-foreground" />,
        searchText: `agent ${agent.name} ${agent.description ?? ""}`.toLowerCase(),
        action: () => selectAgent(agent.name),
      })),
    ];
  }, [agents, props]);

  const handleEscape = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (mode !== "root") {
        setMode("root");
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
      setMode("root");
    }
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      props.onClose();
    }
  };

  const items = mode === "sessions"
    ? sessionItems
    : mode === "accessible-items"
      ? accessibleItems
      : mode === "agents"
        ? agentItems
        : rootItems;

  return (
    <CommandDialog open={props.open} onOpenChange={handleOpenChange}>
      <CommandDialogPopup onKeyDownCapture={handleEscape}>
        <CommandDialogTitle>
          {mode === "sessions"
            ? t("session.palette_title_sessions")
            : mode === "accessible-items"
              ? "Accessible items"
              : mode === "agents"
                ? t("session.cmd_agents_title")
                : t("session.palette_title_actions")
          }
        </CommandDialogTitle>
        <Command key={mode} items={items}>
          <CommandHeader className="flex items-center gap-0">
            {mode !== "root" && (
              <Button variant="outline" size="icon-sm" className="rounded-xl" onClick={() => setMode("root")}>
                <ChevronLeftIcon className="size-4" />
                <span className="sr-only">{t("common.back")}</span>
              </Button>
            )}
            <CommandInput
              className="w-full"
              placeholder={
                mode === "sessions"
                  ? t("session.palette_placeholder_sessions")
                  : mode === "accessible-items"
                    ? "Search servers and artifacts..."
                    : mode === "agents"
                      ? t("session.palette_placeholder_agents")
                      : t("session.palette_placeholder_actions")
              }
              onKeyDown={handleBackspace}
            />
          </CommandHeader>
          <CommandPanel>
            <CommandEmpty>{mode === "accessible-items" ? "No accessible items found for this session." : t("session.palette_no_matches")}</CommandEmpty>
            <CommandList>
              {(item: PaletteItem) => (
                <CommandItem
                  key={item.id}
                  value={item.id}
                  onClick={item.action}
                >
                  {item.icon ? <span className="mr-2 shrink-0">{item.icon}</span> : null}
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{item.title}</div>
                    {item.detail ? (
                      <div className="truncate text-muted-foreground text-xs">
                        {item.detail}
                      </div>
                    ) : null}
                    {item.searchText ? (
                      <span className="sr-only">{item.searchText}</span>
                    ) : null}
                  </div>
                  {item.meta ? <CommandShortcut>{item.meta}</CommandShortcut> : null}
                </CommandItem>
              )}
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
