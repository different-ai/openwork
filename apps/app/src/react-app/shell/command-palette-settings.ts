import type { PlatformCapabilities } from "@/app/lib/platform-capabilities";
import { isSettingsTabAllowed, type DesktopAppRestrictionChecker } from "@/app/cloud/desktop-app-restrictions";
import type { SettingsTab } from "@/app/types";
import {
  CLOUD_SETTINGS_TABS,
  getGlobalSettingsTabs,
  getSettingsTabDescription,
  getSettingsTabLabel,
  getWorkspaceSettingsTabs,
} from "@/react-app/domains/settings/shell/settings-page";

import { ADVANCED_SETTINGS_SECTIONS } from "@/react-app/domains/settings/advanced-sections";
import { getSettingsSearchEntries, type SettingsSearchOs } from "@/react-app/domains/settings/settings-search-index";

import type { PaletteItem } from "./command-palette-search";

const SETTINGS_KEYWORDS: Partial<Record<SettingsTab, string[]>> = {
  ollama: ["local models", "llama", "offline", "on device"],
  ai: ["provider", "providers", "api key", "anthropic", "openai", "openrouter", "google", "gemini", "claude", "gpt", "connect model", "models"],
  preferences: ["default model", "reasoning", "thinking", "compaction", "effort"],
  permissions: ["authorized folders", "folder access", "file access", "allow", "permission denied", "sandbox", "approvals"],
  extensions: ["library", "skills", "plugins", "mcp", "connections", "tools", "apps"],
  import: ["claude", "claude code", "chat history", "migrate"],
  environment: ["env", "environment variables", "secrets", "tokens", "api keys"],
  computer: ["desktop control", "accessibility", "screen recording", "macos permissions", "mouse", "keyboard", "apps"],
  devices: ["computers", "cloud computer", "desktops", "remote", "machines"],
  advanced: ["advanced settings", "runtime", "developer", "connection", "server", "port", "reset", "fix", "repair", "clean up", "troubleshoot", "recovery"],
  shortcuts: ["shortcut", "shortcuts", "keyboard", "keys", "hotkey", "keybinding", "switch model", "fast"],
  appearance: ["theme", "dark mode", "light mode", "color", "font", "look"],
  updates: ["version", "upgrade", "check for updates", "release"],
  debug: ["logs", "diagnostics", "developer mode"],
  usage: ["usage", "limit", "spend", "budget", "quota", "increase"],
  "cloud-account": ["sign in", "sign out", "log in", "log out", "login", "account", "organization", "org", "den", "cloud", "openwork cloud"],
  general: ["settings", "preferences", "options", "configure"],
};

const LIBRARY_SECTIONS = [
  { slug: "skills", title: "Skills", detail: "Instructions that teach agents specialized workflows", keywords: ["skill", "instructions", "workflows"] },
  { slug: "mcps", title: "MCP servers", detail: "Tools and services connected through MCP", keywords: ["mcp", "servers", "tools"] },
  { slug: "connections", title: "Connections", detail: "Connected organization apps and services", keywords: ["apps", "services", "sign in"] },
  { slug: "plugins", title: "Plugins", detail: "Extensions that add tools and behavior", keywords: ["extensions", "tools", "hooks"] },
  { slug: "agents", title: "Agents", detail: "Specialized agents available in conversations", keywords: ["agent", "assistants", "modes"] },
  { slug: "commands", title: "Commands", detail: "Slash commands available in the composer", keywords: ["command", "slash", "prompts"] },
] satisfies Array<{ slug: string; title: string; detail: string; keywords: string[] }>;

export function buildCommandPaletteSettingsItems(input: {
  developerMode: boolean;
  capabilities: Pick<PlatformCapabilities, "autoUpdate">;
  /** The desktop app's system. Left out on the web, which has no desktop-only settings. */
  os?: SettingsSearchOs;
  /** Desktop policy checker; when `allowControlSettings` is blocked only the Cloud tabs remain. */
  checkRestriction?: DesktopAppRestrictionChecker;
  onOpenSettings: (route: string) => void;
  onOpenExtensions: (section?: string) => void;
}): PaletteItem[] {
  const checkRestriction = input.checkRestriction ?? (() => false);
  // The settings sidebar's pages, in its order (`useSettingsNavGroups`).
  const tabs = ([
    "general",
    ...getWorkspaceSettingsTabs(),
    ...getGlobalSettingsTabs(input.developerMode, input.capabilities, { desktop: input.os !== undefined }),
    // Not in the sidebar (opened from AI Providers), but still searchable.
    "ollama",
    ...CLOUD_SETTINGS_TABS,
    "devices",
  ] satisfies SettingsTab[]).filter((tab) => isSettingsTabAllowed({ tab, checkRestriction }));

  const tabItems = tabs.map((tab): PaletteItem => ({
    id: `settings:${tab}`,
    title: tab === "advanced" ? "Advanced settings" : getSettingsTabLabel(tab),
    detail: getSettingsTabDescription(tab),
    keywords: SETTINGS_KEYWORDS[tab],
    breadcrumb: "Settings",
    group: "settings",
    action: () => {
      if (tab === "extensions") {
        input.onOpenExtensions();
        return;
      }
      input.onOpenSettings(`/settings/${tab}`);
    },
  }));

  const libraryItems = LIBRARY_SECTIONS.map((section): PaletteItem => ({
    id: `settings:extensions/${section.slug}`,
    title: section.title,
    detail: section.detail,
    keywords: section.keywords,
    breadcrumb: "Settings › Library",
    group: "settings",
    action: () => input.onOpenExtensions(section.slug),
  }));

  const advancedItems: PaletteItem[] = tabs.includes("advanced")
    ? ADVANCED_SETTINGS_SECTIONS.filter((section) => section.id !== "experimental-engine" || input.os !== undefined).map((section) => ({
        id: `settings:advanced/${section.id}`,
        title: section.title,
        keywords: section.keywords,
        breadcrumb: "Settings › Advanced",
        group: "settings",
        action: () => input.onOpenSettings(`/settings/advanced/${section.id}`),
      }))
    : [];

  // One result per setting inside a page, so a search for an option's own
  // name opens the page at that option.
  const settingItems = getSettingsSearchEntries()
    .filter((entry) => tabs.includes(entry.tab))
    .filter((entry) => !entry.os || (input.os !== undefined && entry.os.includes(input.os)))
    .map((entry): PaletteItem => ({
      id: `settings:${entry.tab}/${entry.anchor}`,
      title: entry.title,
      detail: entry.detail,
      keywords: entry.keywords,
      breadcrumb: ["Settings", getSettingsTabLabel(entry.tab), entry.section].filter(Boolean).join(" › "),
      group: "settings",
      action: () => input.onOpenSettings(`/settings/${entry.tab}/${entry.anchor}`),
    }));

  // Settings inside pages come last: the empty palette previews the first few
  // entries, which stay the pages themselves.
  return input.developerMode
    ? [...advancedItems, ...tabItems, ...libraryItems, ...settingItems]
    : [...tabItems, ...advancedItems, ...libraryItems, ...settingItems];
}
