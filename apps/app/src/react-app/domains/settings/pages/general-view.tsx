/** @jsxImportSource react */
import {
  ArrowRight,
  ArrowUpRight,
  Cloud,
  Cog,
  FolderLock,
  LifeBuoy,
  MessageCircle,
  Paintbrush,
  Puzzle,
  RefreshCcw,
  ShieldCheck,
  Sparkles,
  Terminal,
  Wrench,
} from "lucide-react";

import { t } from "../../../../i18n";
import type { SettingsTab } from "../../../../app/types";
import { Button } from "@/components/ui/button";

export type GeneralSettingsViewProps = {
  onNavigateTab: (tab: SettingsTab) => void;
  developerMode: boolean;
  onSendFeedback: () => void;
  onJoinDiscord: () => void;
  onReportIssue: () => void;
};

function getWorkspaceCards(): { tab: SettingsTab; icon: typeof Sparkles; title: string; desc: string }[] {
  return [
    { tab: "preferences", icon: Cog, title: t("settings.general_card_preferences"), desc: t("settings.general_card_preferences_desc") },
    { tab: "permissions", icon: FolderLock, title: t("settings.general_card_permissions"), desc: t("settings.general_card_permissions_desc") },
    { tab: "extensions", icon: Puzzle, title: t("settings.general_card_extensions"), desc: t("settings.general_card_extensions_desc") },
    { tab: "advanced", icon: Wrench, title: t("settings.general_card_advanced"), desc: t("settings.general_card_advanced_desc") },
  ];
}

function getGlobalCards(): { tab: SettingsTab; icon: typeof Sparkles; title: string; desc: string }[] {
  return [
    { tab: "ai", icon: Sparkles, title: t("settings.general_card_ai"), desc: t("settings.general_card_ai_desc") },
    { tab: "cloud-account", icon: Cloud, title: t("settings.general_card_cloud"), desc: t("settings.general_card_cloud_desc") },
    { tab: "appearance", icon: Paintbrush, title: t("settings.general_card_appearance"), desc: t("settings.general_card_appearance_desc") },
    { tab: "environment", icon: Terminal, title: t("settings.general_card_environment"), desc: t("settings.general_card_environment_desc") },
    { tab: "updates", icon: RefreshCcw, title: t("settings.general_card_updates"), desc: t("settings.general_card_updates_desc") },
    { tab: "recovery", icon: ShieldCheck, title: t("settings.general_card_recovery"), desc: t("settings.general_card_recovery_desc") },
  ];
}

function SettingsCard(props: {
  icon: typeof Sparkles;
  title: string;
  desc: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className="flex items-center gap-3 rounded-2xl border border-dls-border bg-dls-surface p-4 text-left transition-colors hover:bg-dls-hover"
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-dls-border bg-dls-hover">
        <props.icon size={16} className="text-dls-secondary" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-dls-text">{props.title}</div>
        <div className="text-[11px] text-dls-secondary">{props.desc}</div>
      </div>
      <ArrowRight size={14} className="shrink-0 text-dls-secondary" />
    </button>
  );
}

export function GeneralSettingsView(props: GeneralSettingsViewProps) {
  return (
    <div className="w-full max-w-3xl space-y-8">
      {/* Workspace settings */}
      <div className="space-y-3">
        <div className="text-[11px] font-semibold uppercase tracking-[0.15em] text-dls-secondary">
          {t("settings.group_workspace")}
        </div>
        <div className="grid grid-cols-2 gap-2">
          {getWorkspaceCards().map((card) => (
            <SettingsCard
              key={card.tab}
              icon={card.icon}
              title={card.title}
              desc={card.desc}
              onClick={() => props.onNavigateTab(card.tab)}
            />
          ))}
        </div>
      </div>

      {/* Global settings */}
      <div className="space-y-3">
        <div className="text-[11px] font-semibold uppercase tracking-[0.15em] text-dls-secondary">
          {t("settings.group_global")}
        </div>
        <div className="grid grid-cols-2 gap-2">
          {getGlobalCards().map((card) => (
            <SettingsCard
              key={card.tab}
              icon={card.icon}
              title={card.title}
              desc={card.desc}
              onClick={() => props.onNavigateTab(card.tab)}
            />
          ))}
        </div>
      </div>

      {/* Feedback */}
      <div className="space-y-3">
        <div className="text-[11px] font-semibold uppercase tracking-[0.15em] text-dls-secondary">
          {t("settings.general_group_help")}
        </div>
        <div className="rounded-2xl border border-dls-border bg-dls-surface p-4">
          <div className="space-y-3">
            <div>
              <div className="flex items-center gap-2">
                <LifeBuoy size={14} className="text-dls-secondary" />
                <div className="text-[13px] font-medium text-dls-text">{t("settings.feedback_title")}</div>
              </div>
              <div className="mt-1 max-w-[58ch] text-[11px] text-dls-secondary">{t("settings.feedback_desc")}</div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={props.onSendFeedback}
              >
                <MessageCircle size={12} />
                {t("settings.send_feedback")}
                <ArrowUpRight size={11} />
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={props.onJoinDiscord}
              >
                {t("settings.join_discord")}
                <ArrowUpRight size={11} />
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={props.onReportIssue}
              >
                {t("settings.report_issue")}
                <ArrowUpRight size={11} />
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
