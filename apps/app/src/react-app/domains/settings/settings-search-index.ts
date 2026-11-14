import type { SettingsTab } from "@/app/types";
import { t } from "@/i18n";

export type SettingsSearchOs = "macos" | "windows" | "linux";

const DESKTOP: SettingsSearchOs[] = ["macos", "windows", "linux"];

/**
 * One setting inside a settings page, as Cmd/Ctrl+K finds it. `title` and
 * `detail` repeat the row's own label and description so a search for the
 * words on the page lands on it.
 */
export type SettingsSearchEntry = {
  tab: SettingsTab;
  /** The row's `LayoutSectionItem anchor`, unique within its page. */
  anchor: string;
  title: string;
  detail?: string;
  /** Heading the setting sits under, shown in the result's path. */
  section?: string;
  keywords?: string[];
  /** Desktop systems that show this setting. Omitted: shown everywhere. */
  os?: SettingsSearchOs[];
};

/** Read at search time so titles follow the chosen language. */
export function getSettingsSearchEntries(): SettingsSearchEntry[] {
  return [
    {
      tab: "preferences",
      anchor: "show-model-reasoning",
      title: t("settings.show_model_reasoning"),
      detail: t("settings.show_model_reasoning_desc"),
      section: t("settings.model_title"),
      keywords: ["thinking", "thoughts", "reasoning traces"],
    },
    {
      tab: "preferences",
      anchor: "auto-compact",
      title: t("settings.auto_compact"),
      detail: t("settings.auto_compact_desc"),
      section: t("settings.model_title"),
      keywords: ["compaction", "context window", "summarize"],
    },
    {
      tab: "preferences",
      anchor: "follow-up",
      title: t("settings.follow_up.enter"),
      detail: t("settings.follow_up.section_desc"),
      section: t("settings.follow_up.title"),
      keywords: ["queue", "steer", "interrupt", "enter key", "send while working"],
    },
    {
      tab: "preferences",
      anchor: "desktop-notifications",
      title: t("settings.desktop_notifications.mode"),
      detail: t("settings.desktop_notifications.mode_desc"),
      section: t("settings.desktop_notifications.title"),
      keywords: ["notifications", "alerts", "notify"],
    },
    {
      tab: "preferences",
      anchor: "keep-awake",
      title: t("settings.keep_awake"),
      detail: t("settings.keep_awake_desc"),
      section: t("settings.power_title"),
      keywords: ["sleep", "prevent sleep", "caffeinate", "long tasks"],
      os: DESKTOP,
    },
    {
      tab: "preferences",
      anchor: "open-links-in",
      title: t("settings.links.open_in"),
      detail: t("settings.links.open_in_desc"),
      section: t("settings.browser_title"),
      keywords: ["links", "external browser", "default browser", "built-in browser"],
      os: DESKTOP,
    },
    {
      tab: "preferences",
      anchor: "usage-data",
      title: t("settings.analytics_toggle"),
      detail: t("settings.analytics_toggle_desc"),
      section: t("settings.privacy_title"),
      keywords: ["analytics", "telemetry", "tracking", "privacy"],
    },
    {
      tab: "appearance",
      anchor: "theme",
      title: t("settings.theme_title"),
      detail: t("settings.appearance_hint"),
      keywords: ["dark mode", "light mode", "system theme", "color scheme"],
    },
    {
      tab: "appearance",
      anchor: "language",
      title: t("settings.language"),
      detail: t("settings.language.description"),
      keywords: ["locale", "translation", "english"],
    },
    {
      tab: "appearance",
      anchor: "hide-titlebar",
      title: t("settings.hide_titlebar"),
      detail: t("settings.hide_titlebar_desc"),
      section: t("settings.window_title"),
      keywords: ["title bar", "window frame", "tiling"],
      os: DESKTOP,
    },
    {
      tab: "appearance",
      anchor: "menu-bar",
      title: "Display menu bar",
      detail: "Show the native desktop menu bar.",
      section: t("settings.window_title"),
      keywords: ["menubar", "application menu"],
      os: ["windows", "linux"],
    },
    {
      tab: "updates",
      anchor: "release-channel",
      title: "Release channel",
      detail: "Stable gets fully tested releases. Alpha includes the very latest changes.",
      keywords: ["stable", "alpha", "preview builds"],
      os: ["macos"],
    },
    {
      tab: "updates",
      anchor: "check-automatically",
      title: t("settings.background_checks_title"),
      detail: t("settings.background_checks_desc"),
      keywords: ["background checks", "check for updates", "auto update"],
    },
    {
      tab: "updates",
      anchor: "download-automatically",
      title: t("settings.auto_update_title"),
      detail: t("settings.auto_update_desc"),
      keywords: ["auto update", "install updates", "background download"],
    },
    {
      tab: "advanced",
      anchor: "show-workspace-run-mode",
      title: "Show workspace run mode",
      detail: "Choose when OpenWork asks before acting, using the icon beside attachments.",
      section: "Workspace run mode",
      keywords: ["approvals", "ask before acting"],
    },
    {
      tab: "advanced",
      anchor: "chat-engine",
      title: "Chat engine",
      section: "OpenCode engine",
      keywords: ["opencode v1", "opencode v2", "engine preview"],
      os: DESKTOP,
    },
    {
      tab: "advanced",
      anchor: "developer-mode",
      title: t("settings.developer_mode_title"),
      detail: t("settings.developer_mode_desc"),
      section: t("settings.developer"),
      keywords: ["debug tools", "diagnostics"],
    },
    {
      tab: "advanced",
      anchor: "screen-recordings",
      title: "Show computer use in screen recordings",
      detail: "The agent's cursor, frame and controls appear in screen recordings and screen sharing, for demos.",
      section: t("settings.developer"),
      keywords: ["screen sharing", "demo", "overlay", "cursor"],
      os: ["macos"],
    },
  ];
}
