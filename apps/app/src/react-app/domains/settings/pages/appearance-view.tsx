/** @jsxImportSource react */
import { isDesktopRuntime } from "@/app/utils";
import type { Language } from "@/i18n";
import { Separator } from "@/components/ui/separator";
import { LanguageSection } from "../appearance/language-section";
import { ThemeSection } from "../appearance/theme-section";
import { WindowSection } from "../appearance/window-section";
import { LayoutStack } from "../settings-layout";

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
    <LayoutStack>
      <ThemeSection {...props} />
      <Separator />
      <LanguageSection {...props} />
      {isDesktopRuntime() ? (
        <>
          <Separator />
          <WindowSection {...props} />
        </>
      ) : null}
    </LayoutStack>
  );
}
