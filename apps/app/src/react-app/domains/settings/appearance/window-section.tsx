/** @jsxImportSource react */
import { Button } from "@/components/ui/button";
import { t } from "../../../../i18n";
import type { AppearanceViewProps } from "../pages/appearance-view";
import {
  SettingsInset,
  SettingsSection,
  SettingsSectionHeader,
  SettingsSectionHeaderContent,
  SettingsSectionHeaderDescription,
  SettingsSectionHeaderTitle,
} from "../settings-section";

interface WindowSectionProps
  extends Pick<AppearanceViewProps, "busy" | "hideTitlebar" | "toggleHideTitlebar"> {}

export function WindowSection(props: WindowSectionProps) {
  return (
    <SettingsSection>
      <SettingsSectionHeader>
        <SettingsSectionHeaderContent>
          <SettingsSectionHeaderTitle>{t("settings.appearance_title")}</SettingsSectionHeaderTitle>
          <SettingsSectionHeaderDescription>{t("settings.window_appearance_desc")}</SettingsSectionHeaderDescription>
        </SettingsSectionHeaderContent>
      </SettingsSectionHeader>

      <SettingsInset>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm text-foreground">{t("settings.hide_titlebar")}</div>
            <div className="text-xs text-muted-foreground">{t("settings.hide_titlebar_desc")}</div>
          </div>
          <Button
            variant="outline"
            className="h-8 shrink-0 px-3 py-0 text-xs"
            onClick={props.toggleHideTitlebar}
            disabled={props.busy}
          >
            {props.hideTitlebar ? t("settings.on") : t("settings.off")}
          </Button>
        </div>
      </SettingsInset>
    </SettingsSection>
  );
}
