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
  RefreshCcw,
  ShieldCheck,
  Sparkles,
  Terminal,
  Wrench,
} from "lucide-react";

import { t } from "../../../../i18n";
import type { SettingsTab } from "../../../../app/types";
import { Button } from "@/components/ui/button";
import { getSettingsTabDescription, getSettingsTabLabel } from "../shell/settings-page";

export type GeneralSettingsViewProps = {
  onNavigateTab: (tab: SettingsTab) => void;
  developerMode: boolean;
  onSendFeedback: () => void;
  onJoinDiscord: () => void;
  onReportIssue: () => void;
};

type SettingsCardDefinition = { tab: SettingsTab; icon: typeof Sparkles };

const workspaceCards: SettingsCardDefinition[] = [
  { tab: "preferences", icon: Cog },
  { tab: "permissions", icon: FolderLock },
  { tab: "advanced", icon: Wrench },
];

const globalCards: SettingsCardDefinition[] = [
  { tab: "ai", icon: Sparkles },
  { tab: "cloud-account", icon: Cloud },
  { tab: "appearance", icon: Paintbrush },
  { tab: "environment", icon: Terminal },
  { tab: "updates", icon: RefreshCcw },
  { tab: "recovery", icon: ShieldCheck },
];

function cardTitle(card: SettingsCardDefinition) {
  return getSettingsTabLabel(card.tab);
}

function cardDescription(card: SettingsCardDefinition) {
  return getSettingsTabDescription(card.tab);
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
          {workspaceCards.map((card) => (
            <SettingsCard
              key={card.tab}
              icon={card.icon}
              title={cardTitle(card)}
              desc={cardDescription(card)}
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
          {globalCards.map((card) => (
            <SettingsCard
              key={card.tab}
              icon={card.icon}
              title={cardTitle(card)}
              desc={cardDescription(card)}
              onClick={() => props.onNavigateTab(card.tab)}
            />
          ))}
        </div>
      </div>

      {/* Feedback */}
      <div className="space-y-3">
        <div className="text-[11px] font-semibold uppercase tracking-[0.15em] text-dls-secondary">
          {t("settings.group_help")}
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
