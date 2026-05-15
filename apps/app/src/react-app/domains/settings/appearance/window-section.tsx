/** @jsxImportSource react */
import { Switch } from "@/components/ui/switch";
import { t } from "@/i18n";
import type { AppearanceViewProps } from "../pages/appearance-view";
import {
  LayoutSection,
  LayoutSectionDescription,
  LayoutSectionHeader,
  LayoutSectionItem,
  LayoutSectionItemDescription,
  LayoutSectionItemHeader,
  LayoutSectionItemHeaderActions,
  LayoutSectionItemTitle,
  LayoutSectionTitle,
} from "../settings-layout";

interface WindowSectionProps
  extends Pick<AppearanceViewProps, "busy" | "hideTitlebar" | "toggleHideTitlebar"> {}

export function WindowSection(props: WindowSectionProps) {
  return (
    <LayoutSection>
      <LayoutSectionHeader>
        <LayoutSectionTitle>{t("settings.window_title")}</LayoutSectionTitle>
        <LayoutSectionDescription>{t("settings.window_appearance_desc")}</LayoutSectionDescription>
      </LayoutSectionHeader>

      <LayoutSectionItem>
        <LayoutSectionItemHeader>
          <LayoutSectionItemTitle>{t("settings.hide_titlebar")}</LayoutSectionItemTitle>
          <LayoutSectionItemDescription>{t("settings.hide_titlebar_desc")}</LayoutSectionItemDescription>
          <LayoutSectionItemHeaderActions>
            <Switch
              checked={props.hideTitlebar}
              disabled={props.busy}
              onCheckedChange={props.toggleHideTitlebar}
            />
          </LayoutSectionItemHeaderActions>
        </LayoutSectionItemHeader>
      </LayoutSectionItem>
    </LayoutSection>
  );
}
