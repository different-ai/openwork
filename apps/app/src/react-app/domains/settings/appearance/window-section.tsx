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
  extends Pick<
    AppearanceViewProps,
    "busy" | "hideTitlebar" | "toggleHideTitlebar" | "composerSpellcheckEnabled" | "toggleComposerSpellcheck"
  > {}

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

      <LayoutSectionItem>
        <LayoutSectionItemHeader>
          <LayoutSectionItemTitle>{t("settings.composer_spellcheck")}</LayoutSectionItemTitle>
          <LayoutSectionItemDescription>{t("settings.composer_spellcheck_desc")}</LayoutSectionItemDescription>
          <LayoutSectionItemHeaderActions>
            <Switch
              checked={props.composerSpellcheckEnabled}
              disabled={props.busy}
              onCheckedChange={props.toggleComposerSpellcheck}
            />
          </LayoutSectionItemHeaderActions>
        </LayoutSectionItemHeader>
      </LayoutSectionItem>
    </LayoutSection>
  );
}
