/** @jsxImportSource react */
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LANGUAGE_OPTIONS, t } from "../../../../i18n";
import type { AppearanceViewProps } from "../pages/appearance-view";
import {
  SettingsSection,
  SettingsSectionHeader,
  SettingsSectionHeaderContent,
  SettingsSectionHeaderDescription,
  SettingsSectionHeaderTitle,
} from "../settings-section";

interface LanguageSectionProps extends Pick<AppearanceViewProps, "busy" | "language" | "setLanguage"> {}

export function LanguageSection(props: LanguageSectionProps) {
  return (
    <SettingsSection>
      <SettingsSectionHeader>
        <SettingsSectionHeaderContent>
          <SettingsSectionHeaderTitle>{t("settings.language")}</SettingsSectionHeaderTitle>
          <SettingsSectionHeaderDescription>{t("settings.language.description")}</SettingsSectionHeaderDescription>
        </SettingsSectionHeaderContent>

        <div className="flex shrink-0 items-center gap-2">
          <div className="w-64 max-w-full">
            <Select
              value={props.language}
              items={LANGUAGE_OPTIONS}
              onValueChange={(value) => {
                if (value) props.setLanguage(value);
              }}
              disabled={props.busy}
            >
              <SelectTrigger className="w-full" aria-label={t("settings.language")}>
                <SelectValue placeholder={t("settings.language")} />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {LANGUAGE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.nativeName}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        </div>
      </SettingsSectionHeader>
    </SettingsSection>
  );
}
