/** @jsxImportSource react */
import { FileSpreadsheet, Globe, FolderOpen, Bot, FileText, Plug } from "lucide-react";
import { t } from "../../../i18n";

type CapabilityCardProps = {
  icon: React.ReactNode;
  title: string;
  description: string;
};

function CapabilityCard({ icon, title, description }: CapabilityCardProps) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-2xl border border-dls-border bg-dls-surface p-5 text-center transition-colors">
      <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-dls-border bg-dls-hover text-dls-secondary">
        {icon}
      </div>
      <div className="text-[14px] font-medium text-dls-text">{title}</div>
      <div className="text-[12px] leading-relaxed text-dls-secondary">
        {description}
      </div>
    </div>
  );
}

type WelcomePageProps = {
  onGetStarted: () => void;
};

export function WelcomePage({ onGetStarted }: WelcomePageProps) {
  return (
    <div className="relative flex min-h-screen w-full items-center justify-center bg-dls-background p-6">
      <div className="absolute inset-x-0 top-0 h-10 mac:titlebar-drag" />
      <div className="mx-auto w-full max-w-[640px] space-y-10">
        {/* Header */}
        <div className="space-y-3 text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-3xl border border-dls-border bg-dls-surface shadow-sm">
            <Bot size={28} className="text-dls-accent" />
          </div>
          <h1 className="text-[28px] font-semibold tracking-[-0.5px] text-dls-text">
            {t("welcome.title")}
          </h1>
          <p className="text-[16px] text-dls-secondary">
            {t("welcome.subtitle")}
          </p>
        </div>

        {/* Capability grid */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <CapabilityCard
            icon={<FileSpreadsheet size={20} />}
            title={t("welcome.capability_spreadsheets")}
            description={t("welcome.capability_spreadsheets_desc")}
          />
          <CapabilityCard
            icon={<Globe size={20} />}
            title={t("welcome.capability_browser")}
            description={t("welcome.capability_browser_desc")}
          />
          <CapabilityCard
            icon={<FolderOpen size={20} />}
            title={t("welcome.capability_files")}
            description={t("welcome.capability_files_desc")}
          />
          <CapabilityCard
            icon={<Bot size={20} />}
            title={t("welcome.capability_automate")}
            description={t("welcome.capability_automate_desc")}
          />
          <CapabilityCard
            icon={<FileText size={20} />}
            title={t("welcome.capability_content")}
            description={t("welcome.capability_content_desc")}
          />
          <CapabilityCard
            icon={<Plug size={20} />}
            title={t("welcome.capability_apis")}
            description={t("welcome.capability_apis_desc")}
          />
        </div>

        {/* CTA */}
        <div className="flex justify-center">
          <button
            type="button"
            onClick={onGetStarted}
            className="inline-flex items-center justify-center gap-2 rounded-full bg-dls-accent px-8 py-3 text-[15px] font-medium text-white transition-colors hover:bg-[var(--dls-accent-hover)] focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.18)]"
          >
            {t("welcome.get_started")}
          </button>
        </div>
      </div>
    </div>
  );
}
