import { createContext, useContext, type Accessor, type ParentProps } from "solid-js";

import type {
  HubSkillCard,
  HubSkillRepo,
  PluginScope,
  SkillCard,
  SuggestedPlugin,
} from "../types";

export type ExtensionsContextValue = {
  skills: Accessor<SkillCard[]>;
  skillsStatus: Accessor<string | null>;
  hubSkills: Accessor<HubSkillCard[]>;
  hubSkillsStatus: Accessor<string | null>;
  hubRepo: Accessor<HubSkillRepo | null>;
  hubRepos: Accessor<HubSkillRepo[]>;
  skillsAccessHint: Accessor<string | null>;
  canInstallSkillCreator: Accessor<boolean>;
  canUseDesktopTools: Accessor<boolean>;
  refreshSkills: (options?: { force?: boolean }) => Promise<void>;
  refreshHubSkills: (options?: { force?: boolean }) => Promise<void>;
  ensureHubSkillsFresh: () => void;
  importLocalSkill: () => void;
  installSkillCreator: () => Promise<{ ok: boolean; message: string }>;
  installHubSkill: (name: string) => Promise<{ ok: boolean; message: string }>;
  setHubRepo: (repo: Partial<HubSkillRepo> | null) => void;
  addHubRepo: (repo: Partial<HubSkillRepo>) => void;
  removeHubRepo: (repo: Partial<HubSkillRepo>) => void;
  revealSkillsFolder: () => void;
  uninstallSkill: (name: string) => void;
  readSkill: (name: string) => Promise<{ name: string; path: string; content: string } | null>;
  saveSkill: (input: { name: string; content: string; description?: string }) => void;
  pluginsAccessHint: Accessor<string | null>;
  canEditPlugins: Accessor<boolean>;
  canUseGlobalPluginScope: Accessor<boolean>;
  pluginScope: Accessor<PluginScope>;
  setPluginScope: (scope: PluginScope) => void;
  pluginConfigPath: Accessor<string | null>;
  pluginList: Accessor<string[]>;
  pluginInput: Accessor<string>;
  setPluginInput: (value: string) => void;
  pluginStatus: Accessor<string | null>;
  activePluginGuide: Accessor<string | null>;
  setActivePluginGuide: (value: string | null) => void;
  isPluginInstalled: (name: string, aliases?: string[]) => boolean;
  suggestedPlugins: SuggestedPlugin[];
  refreshPlugins: (scopeOverride?: PluginScope) => Promise<void>;
  addPlugin: (pluginNameOverride?: string) => void;
  removePlugin: (pluginName: string) => void;
};

const ExtensionsContext = createContext<ExtensionsContextValue | undefined>(undefined);

export function ExtensionsProvider(props: ParentProps<{ value: ExtensionsContextValue }>) {
  return (
    <ExtensionsContext.Provider value={props.value}>
      {props.children}
    </ExtensionsContext.Provider>
  );
}

export function useExtensions() {
  const context = useContext(ExtensionsContext);
  if (!context) {
    throw new Error("Extensions context is missing");
  }
  return context;
}
