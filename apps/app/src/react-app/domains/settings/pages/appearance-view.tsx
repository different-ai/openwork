/** @jsxImportSource react */
import { LANGUAGE_OPTIONS, t, type Language } from "../../../../i18n";
import { isTauriRuntime } from "../../../../app/utils";
import { Button } from "../../../design-system/button";

const settingsPanelClass = "rounded-[28px] border border-dls-border bg-dls-surface p-5 md:p-6";

export type AppearanceViewProps = {
  busy: boolean;
  themeMode: "light" | "dark" | "system";
  setThemeMode: (value: "light" | "dark" | "system") => void;
  language: Language;
  setLanguage: (value: Language) => void;
  hideTitlebar: boolean;
  toggleHideTitlebar: () => void;
};

export function AppearanceView(props: AppearanceViewProps) {
  return (
    <div className="space-y-6">
      <div className={`${settingsPanelClass} space-y-4`}>
        <div>
          <div className="text-sm font-medium text-gray-12">{t("settings.appearance_title")}</div>
          <div className="text-xs text-gray-9">{t("settings.appearance_hint")}</div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            variant={props.themeMode === "system" ? "secondary" : "outline"}
            className="h-8 px-3 py-0 text-xs"
            onClick={() => props.setThemeMode("system")}
            disabled={props.busy}
          >
            {t("settings.theme_system")}
          </Button>
          <Button
            variant={props.themeMode === "light" ? "secondary" : "outline"}
            className="h-8 px-3 py-0 text-xs"
            onClick={() => props.setThemeMode("light")}
            disabled={props.busy}
          >
            {t("settings.theme_light")}
          </Button>
          <Button
            variant={props.themeMode === "dark" ? "secondary" : "outline"}
            className="h-8 px-3 py-0 text-xs"
            onClick={() => props.setThemeMode("dark")}
            disabled={props.busy}
          >
            {t("settings.theme_dark")}
          </Button>
        </div>

        <div className="space-y-2">
          <div className="text-xs font-medium text-gray-11">{t("settings.language")}</div>
          <div className="text-xs text-gray-9">{t("settings.language.description")}</div>
          <div className="flex flex-wrap gap-2">
            {LANGUAGE_OPTIONS.map((option) => (
              <Button
                key={option.value}
                variant={props.language === option.value ? "secondary" : "outline"}
                className="h-8 px-3 py-0 text-xs"
                onClick={() => props.setLanguage(option.value)}
                disabled={props.busy}
              >
                {option.nativeName}
              </Button>
            ))}
          </div>
        </div>

        <div className="text-xs text-gray-8">{t("settings.theme_system_hint")}</div>
      </div>

      {isTauriRuntime() ? (
        <div className="space-y-3 rounded-2xl border border-gray-6/50 bg-gray-2/30 p-5">
          <div>
            <div className="text-sm font-medium text-gray-12">{t("settings.appearance_title")}</div>
            <div className="text-xs text-gray-10">{t("settings.window_appearance_desc")}</div>
          </div>

          <div className="flex items-center justify-between gap-3 rounded-xl border border-gray-6 bg-gray-1 p-3">
            <div className="min-w-0">
              <div className="text-sm text-gray-12">{t("settings.hide_titlebar")}</div>
              <div className="text-xs text-gray-7">{t("settings.hide_titlebar_desc")}</div>
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
        </div>
      ) : null}
    </div>
  );
}
