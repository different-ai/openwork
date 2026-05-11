/** @jsxImportSource react */
import { ArrowUpRight, LifeBuoy, MessageCircle } from "lucide-react";

import { t } from "../../../../i18n";
import {
  AuthorizedFoldersPanel,
  type AuthorizedFoldersPanelProps,
} from "../panels/authorized-folders-panel";

export type GeneralSettingsViewProps = {
  authorizedFoldersPanel: AuthorizedFoldersPanelProps;
  onSendFeedback: () => void;
  onJoinDiscord: () => void;
  onReportIssue: () => void;
};

export function GeneralSettingsView(props: GeneralSettingsViewProps) {
  return (
    <div className="space-y-6 max-w-3xl w-full">
      <AuthorizedFoldersPanel {...props.authorizedFoldersPanel} />

      <div className="relative overflow-hidden rounded-2xl border border-dls-border bg-gradient-to-br from-slate-50 via-white to-slate-50 p-5">
        <div className="relative space-y-4">
          <div className="space-y-2">
            <div className="inline-flex items-center gap-1.5 rounded-full border border-dls-border bg-dls-hover px-2.5 py-1 text-[11px] font-medium text-dls-text">
              <LifeBuoy size={12} />
              {t("settings.feedback_badge")}
            </div>
            <div className="text-sm font-semibold text-gray-12">{t("settings.feedback_title")}</div>
            <div className="max-w-[58ch] text-xs text-gray-10">{t("settings.feedback_desc")}</div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="inline-flex h-9 items-center justify-center gap-2 rounded-full border border-transparent bg-[#011627] px-4 text-xs font-semibold text-white transition-colors duration-150 active:scale-[0.98] hover:bg-black focus:outline-none focus:ring-2 focus:ring-[rgba(1,22,39,0.2)]"
              onClick={props.onSendFeedback}
            >
              <MessageCircle size={14} />
              {t("settings.send_feedback")}
              <ArrowUpRight size={13} />
            </button>

            <button
              type="button"
              className="inline-flex h-9 items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 transition-colors hover:border-slate-300 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(1,22,39,0.15)]"
              onClick={props.onJoinDiscord}
            >
              {t("settings.join_discord")}
              <ArrowUpRight size={13} />
            </button>

            <button
              type="button"
              className="inline-flex h-9 items-center gap-1.5 rounded-full border border-gray-7/60 bg-gray-1/70 px-3 text-xs font-medium text-gray-10 transition-colors hover:border-gray-7/80 hover:text-gray-12 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-7/40"
              onClick={props.onReportIssue}
            >
              {t("settings.report_issue")}
              <ArrowUpRight size={13} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
