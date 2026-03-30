import { Show, type JSX } from "solid-js";
import {
  Box,
  ChevronLeft,
  ChevronRight,
  History,
  MessageCircle,
  Settings,
  SlidersHorizontal,
  X,
  Zap,
} from "lucide-solid";

import type { SettingsTab } from "../types";
import type { OpenworkServerClient } from "../lib/openwork-server";
import InboxPanel from "./session/inbox-panel";

type Props = {
  expanded: boolean;
  mobile?: boolean;
  showSelection?: boolean;
  settingsTab?: SettingsTab;
  developerMode: boolean;
  activeWorkspaceLabel: string;
  activeWorkspaceType: "local" | "remote";
  openworkServerClient: OpenworkServerClient | null;
  runtimeWorkspaceId: string | null;
  inboxId: string;
  onToggleExpanded: () => void;
  onCloseMobile?: () => void;
  onOpenAutomations: () => void;
  onOpenSkills: () => void;
  onOpenExtensions: () => void;
  onOpenMessaging: () => void;
  onOpenAdvanced: () => void;
  onOpenSettings: () => void;
  onInboxToast?: (message: string) => void;
};

export default function WorkspaceRightSidebar(props: Props) {
  const mobile = () => props.mobile ?? false;
  const showSelection = () => props.showSelection ?? true;
  const closeMobile = () => props.onCloseMobile?.();
  const sidebarButton = (
    label: string,
    icon: JSX.Element,
    active: boolean,
    onClick: () => void,
  ) => (
    <button
      type="button"
      class={`w-full border text-[13px] font-medium transition-[background-color,border-color,box-shadow,color] ${
        active
          ? "border-dls-border bg-dls-surface text-dls-text shadow-[var(--dls-card-shadow)]"
          : "border-transparent text-gray-10 hover:border-dls-border hover:bg-dls-surface hover:text-dls-text"
      } ${
        props.expanded
          ? "flex min-h-11 items-center justify-start gap-2.5 rounded-[16px] px-3.5"
          : "flex h-12 items-center justify-center rounded-[16px] px-0"
      }`}
      onClick={() => {
        onClick();
        if (mobile()) closeMobile();
      }}
      title={label}
      aria-label={label}
    >
      {icon}
      <Show when={props.expanded}>
        <span class="flex min-w-0 flex-1 items-center gap-2">
          <span class="truncate">{label}</span>
        </span>
      </Show>
    </button>
  );

  return (
    <div class={`flex h-full w-full flex-col overflow-hidden rounded-[24px] border border-dls-border bg-dls-sidebar p-3 ${mobile() ? "shadow-2xl" : "transition-[width] duration-200"}`}>
      <div class={`flex items-center pb-3 ${props.expanded ? "justify-between gap-3" : "justify-center"}`}>
        <Show when={props.expanded}>
          <div class="min-w-0 px-1">
            <div class="truncate text-[11px] font-medium uppercase tracking-[0.18em] text-gray-8">
              {(props.activeWorkspaceLabel || "Workspace")} configuration
            </div>
          </div>
        </Show>
        <button
          type="button"
          class="flex h-10 w-10 items-center justify-center rounded-[16px] text-gray-10 transition-colors hover:bg-dls-surface hover:text-dls-text"
          onClick={mobile() ? closeMobile : props.onToggleExpanded}
          title={mobile() ? "Close sidebar" : props.expanded ? "Collapse sidebar" : "Expand sidebar"}
          aria-label={mobile() ? "Close sidebar" : props.expanded ? "Collapse sidebar" : "Expand sidebar"}
        >
          <Show
            when={mobile()}
            fallback={<Show when={props.expanded} fallback={<ChevronLeft size={18} />}><ChevronRight size={18} /></Show>}
          >
            <X size={18} />
          </Show>
        </button>
      </div>
      <div class={`flex-1 overflow-y-auto ${props.expanded ? "space-y-5 pt-1" : "space-y-3 pt-1"}`}>
        <div class="mb-2 space-y-1">
          {sidebarButton(
            "Automations",
            <History size={18} />,
            showSelection() && props.settingsTab === "automations",
            props.onOpenAutomations,
          )}
          {sidebarButton(
            "Skills",
            <Zap size={18} />,
            showSelection() && props.settingsTab === "skills",
            props.onOpenSkills,
          )}
          {sidebarButton(
            "Extensions",
            <Box size={18} />,
            showSelection() && props.settingsTab === "extensions",
            props.onOpenExtensions,
          )}
          {sidebarButton(
            "Messaging",
            <MessageCircle size={18} />,
            showSelection() && props.settingsTab === "messaging",
            props.onOpenMessaging,
          )}
          <Show when={props.developerMode}>
            {sidebarButton(
              "Advanced",
              <SlidersHorizontal size={18} />,
                showSelection() && props.settingsTab === "advanced",
              props.onOpenAdvanced,
            )}
          </Show>
        </div>

        <Show when={props.expanded && props.activeWorkspaceType === "remote"}>
          <div class="rounded-[20px] border border-dls-border bg-dls-surface p-3 shadow-[var(--dls-card-shadow)]">
            <InboxPanel
              id={props.inboxId}
              client={props.openworkServerClient}
              workspaceId={props.runtimeWorkspaceId}
              onToast={props.onInboxToast}
            />
          </div>
        </Show>
      </div>

      <div class={`pt-3 ${props.expanded ? "mt-3 border-t border-dls-border/70" : "mt-2"}`}>
        {sidebarButton(
          "Settings",
          <Settings size={18} />,
          showSelection() && props.settingsTab === "general",
          props.onOpenSettings,
        )}
      </div>
    </div>
  );
}
