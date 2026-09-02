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

import type { PaletteItem } from "./command-palette-search";

const SETTINGS_KEYWORDS: Partial<Record<SettingsTab, string[]>> = {
  ai: ["provider", "providers", "api key", "anthropic", "openai", "openrouter", "google", "gemini", "claude", "gpt", "connect model", "models"],
  preferences: ["default model", "reasoning", "thinking", "compaction", "effort"],
  permissions: ["authorized folders", "folder access", "file access", "allow", "permission denied", "sandbox", "approvals"],
  extensions: ["library", "skills", "plugins", "mcp", "connections", "tools", "apps", "computer use", "voice"],
  environment: ["env", "environment variables", "secrets", "tokens", "api keys"],
  advanced: ["runtime", "developer", "connection", "server", "port", "reset", "fix", "repair", "clean up", "troubleshoot", "recovery"],
  appearance: ["theme", "dark mode", "light mode", "color", "font", "look"],
  updates: ["version", "upgrade", "check for updates", "release"],
  debug: ["logs", "diagnostics", "developer mode"],
  "cloud-account": ["sign in", "log in", "login", "account", "organization", "org", "den", "cloud", "openwork cloud"],
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
  /** Desktop policy checker; when `allowControlSettings` is blocked only the Cloud tabs remain. */
  checkRestriction?: DesktopAppRestrictionChecker;
  onOpenSettings: (route: string) => void;
  onOpenExtensions: (section?: string) => void;
}): PaletteItem[] {
  const checkRestriction = input.checkRestriction ?? (() => false);
  const tabs = ([
    "general",
    ...getWorkspaceSettingsTabs(),
    ...getGlobalSettingsTabs(input.developerMode, input.capabilities),
    ...CLOUD_SETTINGS_TABS,
  ] satisfies SettingsTab[]).filter((tab) => isSettingsTabAllowed({ tab, checkRestriction }));

  const tabItems = tabs.map((tab): PaletteItem => ({
    id: `settings:${tab}`,
    title: getSettingsTabLabel(tab),
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

  return [...tabItems, ...libraryItems];
}
