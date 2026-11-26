import { isDesktopRuntime } from "@/app/lib/runtime-env";
import type { PlatformCapabilities } from "@/app/lib/platform-capabilities";
import { isSettingsTabAllowed, type DesktopAppRestrictionChecker } from "@/app/cloud/desktop-app-restrictions";
import type { SettingsTab } from "@/app/types";
import {
  getSettingsNavGroups,
  getSettingsTabDescription,
  getSettingsTabLabel,
} from "@/react-app/domains/settings/shell/settings-page";

import { ADVANCED_SETTINGS_SECTIONS } from "@/react-app/domains/settings/advanced-sections";

import type { PaletteItem } from "./command-palette-search";

const SETTINGS_KEYWORDS: Partial<Record<SettingsTab, string[]>> = {
  ollama: ["local models", "llama", "offline", "on device"],
  ai: ["provider", "providers", "api key", "anthropic", "openai", "openrouter", "google", "gemini", "claude", "gpt", "connect model", "models"],
  preferences: ["default model", "reasoning", "thinking", "compaction", "effort"],
  permissions: ["authorized folders", "folder access", "file access", "allow", "permission denied", "sandbox", "approvals", "file sharing", "uploads", "always allow", "drive", "gmail", "outlook"],
  extensions: ["library", "skills", "plugins", "mcp", "connections", "tools", "apps"],
  environment: ["env", "environment variables", "secrets", "tokens", "api keys"],
  advanced: ["advanced settings", "runtime", "developer", "connection", "server", "port", "reset", "fix", "repair", "clean up", "troubleshoot", "recovery"],
  shortcuts: ["shortcut", "shortcuts", "keyboard", "keys", "hotkey", "keybinding", "switch model", "fast"],
  appearance: ["theme", "dark mode", "light mode", "color", "font", "look"],
  updates: ["version", "upgrade", "check for updates", "release"],
  debug: ["logs", "diagnostics", "developer mode"],
  usage: ["usage", "limit", "spend", "budget", "quota", "increase"],
  computer: ["computer use", "control apps", "mouse", "keyboard", "screen", "accessibility", "screen recording", "automate mac"],
  devices: ["devices", "remote", "cloud computers", "desktops", "other computers"],
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
  checkRestriction?: DesktopAppRestrictionChecker;
  onOpenSettings: (route: string) => void;
  onOpenExtensions: (section?: string) => void;
}): PaletteItem[] {
  const checkRestriction = input.checkRestriction ?? (() => false);
  const nav = getSettingsNavGroups({ developerMode: input.developerMode, capabilities: input.capabilities, checkRestriction });
  const tabs: SettingsTab[] = [
    ...nav.hub,
    ...nav.workspace,
    ...nav.global,
    ...(isSettingsTabAllowed({ tab: "ollama", checkRestriction }) ? ["ollama" as const] : []),
    ...nav.cloud,
  ];

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
    ? ADVANCED_SETTINGS_SECTIONS.filter((section) => section.id !== "experimental-engine" || isDesktopRuntime()).map((section) => ({
        id: `settings:advanced/${section.id}`,
        title: section.title,
        keywords: section.keywords,
        breadcrumb: "Settings › Advanced",
        group: "settings",
        action: () => input.onOpenSettings(`/settings/advanced/${section.id}`),
      }))
    : [];

  return input.developerMode
    ? [...advancedItems, ...tabItems, ...libraryItems]
    : [...tabItems, ...advancedItems, ...libraryItems];
}
