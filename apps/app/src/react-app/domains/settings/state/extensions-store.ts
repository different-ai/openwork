import { useSyncExternalStore } from "react";

import { applyEdits, modify } from "jsonc-parser";
import { join } from "@tauri-apps/api/path";

import { currentLocale, t } from "../../../../i18n";
import type {
  Client,
  DenOrgSkillCard,
  HubSkillCard,
  HubSkillRepo,
  PluginScope,
  ReloadReason,
  ReloadTrigger,
  SkillCard,
} from "../../../../app/types";
import { addOpencodeCacheHint, isTauriRuntime, normalizeDirectoryPath } from "../../../../app/utils";
import skillCreatorTemplate from "../../../../app/data/skill-creator.md?raw";
import {
  isPluginInstalled,
  loadPluginsFromConfig as loadPluginsFromConfigHelpers,
  parsePluginListFromContent,
  stripPluginVersion,
} from "../../../../app/utils/plugins";
import {
  importSkill,
  installSkillTemplate,
  listLocalSkills,
  pickDirectory,
  readLocalSkill,
  readOpencodeConfig,
  uninstallSkill as uninstallSkillCommand,
  workspaceOpenworkRead,
  workspaceOpenworkWrite,
  writeLocalSkill,
  writeOpencodeConfig,
  type OpencodeConfigFile,
} from "../../../../app/lib/tauri";
import type { OpenworkHubRepo, OpenworkServerClient } from "../../../../app/lib/openwork-server";
import {
  createDenClient,
  fetchDenOrgSkillsCatalog,
  readDenSettings,
  type DenOrgSkillHub,
} from "../../../../app/lib/den";
import {
  readWorkspaceCloudImports,
  withWorkspaceCloudImports,
  type CloudImportedSkill,
  type CloudImportedSkillHub,
} from "../../../../app/cloud/import-state";
import type { OpenworkServerStore } from "../../connections/openwork-server-store";

const OPENCODE_SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DEFAULT_HUB_REPO: HubSkillRepo = {
  owner: "different-ai",
  repo: "openwork-hub",
  ref: "main",
};
const HUB_REPOS_STORAGE_KEY = "openwork.skills.hubRepos.v1";

type SetStateAction<T> = T | ((current: T) => T);

export type ExtensionsStoreSnapshot = {
  workspaceContextKey: string;
  skills: SkillCard[];
  skillsStatus: string | null;
  hubSkills: HubSkillCard[];
  hubSkillsStatus: string | null;
  cloudOrgSkills: DenOrgSkillCard[];
  cloudOrgSkillsStatus: string | null;
  importedCloudSkills: Record<string, CloudImportedSkill>;
  cloudOrgSkillHubs: DenOrgSkillHub[];
  cloudOrgSkillHubsStatus: string | null;
  importedCloudSkillHubs: Record<string, CloudImportedSkillHub>;
  hubRepo: HubSkillRepo | null;
  hubRepos: HubSkillRepo[];
  pluginScope: PluginScope;
  pluginConfig: OpencodeConfigFile | null;
  pluginConfigPath: string | null;
  pluginList: string[];
  pluginInput: string;
  pluginStatus: string | null;
  activePluginGuide: string | null;
  sidebarPluginList: string[];
  sidebarPluginStatus: string | null;
  skillsStale: boolean;
  pluginsStale: boolean;
  hubSkillsStale: boolean;
  cloudOrgSkillsStale: boolean;
};

type MutableState = {
  skillsContextKey: string;
  pluginsContextKey: string;
  hubSkillsContextKey: string;
  cloudOrgSkillsContextKey: string;
  skills: SkillCard[];
  skillsStatus: string | null;
  hubSkills: HubSkillCard[];
  hubSkillsStatus: string | null;
  cloudOrgSkills: DenOrgSkillCard[];
  cloudOrgSkillsStatus: string | null;
  importedCloudSkills: Record<string, CloudImportedSkill>;
  cloudOrgSkillHubs: DenOrgSkillHub[];
  cloudOrgSkillHubsStatus: string | null;
  importedCloudSkillHubs: Record<string, CloudImportedSkillHub>;
  hubRepo: HubSkillRepo | null;
  hubRepos: HubSkillRepo[];
  pluginScope: PluginScope;
  pluginConfig: OpencodeConfigFile | null;
  pluginConfigPath: string | null;
  pluginList: string[];
  pluginInput: string;
  pluginStatus: string | null;
  activePluginGuide: string | null;
  sidebarPluginList: string[];
  sidebarPluginStatus: string | null;
};

export type ExtensionsStore = ReturnType<typeof createExtensionsStore>;

function extractSkillBodyMarkdown(skillText: string): string {
  const trimmed = skillText.trim();
  if (!trimmed.startsWith("---")) return trimmed;
  const rest = trimmed.slice(3);
  const end = rest.indexOf("\n---");
  if (end === -1) return trimmed;
  return rest.slice(end + 4).replace(/^\s*\n?/, "");
}

function slugifyOpencodeSkillName(title: string): string {
  let base = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!base) base = "skill";
  if (base.length > 64) base = base.slice(0, 64).replace(/-+$/g, "");
  if (!OPENCODE_SKILL_NAME_RE.test(base)) base = "skill";
  return base;
}

function uniqueSkillInstallName(base: string, taken: Set<string>, stableSuffix: string): string {
  const suffixSource = stableSuffix.replace(/[^a-z0-9]+/g, "").slice(-8) || "org";
  let candidate = base;
  if (!taken.has(candidate)) return candidate;
  for (let n = 1; n < 50; n += 1) {
    const extra = `${suffixSource}${n}`;
    const trimmedBase = base.slice(0, Math.max(1, 64 - extra.length - 1));
    candidate = `${trimmedBase}-${extra}`.replace(/^-+|-+$/g, "").slice(0, 64);
    if (OPENCODE_SKILL_NAME_RE.test(candidate) && !taken.has(candidate)) return candidate;
  }
  return `skill-${suffixSource}`.slice(0, 64);
}

export function createExtensionsStore(options: {
  client: () => Client | null;
  projectDir: () => string;
  selectedWorkspaceId: () => string;
  selectedWorkspaceRoot: () => string;
  workspaceType: () => "local" | "remote";
  openworkServer: OpenworkServerStore;
  runtimeWorkspaceId: () => string | null;
  setBusy: (value: boolean) => void;
  setBusyLabel: (value: string | null) => void;
  setBusyStartedAt: (value: number | null) => void;
  setError: (value: string | null) => void;
  markReloadRequired?: (reason: ReloadReason, trigger?: ReloadTrigger) => void;
}) {
  const listeners = new Set<() => void>();
  const translate = (key: string) => t(key, currentLocale());

  let disposed = false;
  let started = false;
  let stopOpenworkSubscription: (() => void) | null = null;
  let stopDenSessionListener: (() => void) | null = null;
  let lastWorkspaceContextKey = "";
  let snapshot: ExtensionsStoreSnapshot;

  let refreshSkillsInFlight = false;
  let refreshPluginsInFlight = false;
  let refreshHubSkillsInFlight = false;
  let refreshCloudOrgSkillsInFlight = false;
  let refreshCloudOrgSkillHubsInFlight = false;
  let refreshSkillsAborted = false;
  let refreshPluginsAborted = false;
  let refreshHubSkillsAborted = false;
  let refreshCloudOrgSkillsAborted = false;
  let refreshCloudOrgSkillHubsAborted = false;
  let skillsLoaded = false;
  let hubSkillsLoaded = false;
  let cloudOrgSkillsLoaded = false;
  let cloudOrgSkillHubsLoaded = false;
  let skillsRoot = "";
  let hubSkillsLoadKey = "";
  let cloudOrgSkillsLoadKey = "";
  let cloudOrgSkillHubsLoadKey = "";

  let state: MutableState = {
    skillsContextKey: "",
    pluginsContextKey: "",
    hubSkillsContextKey: "",
    cloudOrgSkillsContextKey: "",
    skills: [],
    skillsStatus: null,
    hubSkills: [],
    hubSkillsStatus: null,
    cloudOrgSkills: [],
    cloudOrgSkillsStatus: null,
    importedCloudSkills: {},
    cloudOrgSkillHubs: [],
    cloudOrgSkillHubsStatus: null,
    importedCloudSkillHubs: {},
    hubRepo: DEFAULT_HUB_REPO,
    hubRepos: [DEFAULT_HUB_REPO],
    pluginScope: "project",
    pluginConfig: null,
    pluginConfigPath: null,
    pluginList: [],
    pluginInput: "",
    pluginStatus: null,
    activePluginGuide: null,
    sidebarPluginList: [],
    sidebarPluginStatus: null,
  };

  const emitChange = () => {
    for (const listener of listeners) listener();
  };

  const getWorkspaceContextKey = () => {
    const workspaceId = options.selectedWorkspaceId().trim();
    const root = normalizeDirectoryPath(options.selectedWorkspaceRoot().trim());
    const runtimeWorkspaceId = (options.runtimeWorkspaceId() ?? "").trim();
    const workspaceType = options.workspaceType();
    return `${workspaceType}:${workspaceId}:${root}:${runtimeWorkspaceId}`;
  };

  const refreshSnapshot = () => {
    const workspaceContextKey = getWorkspaceContextKey();
    const orgId = readDenSettings().activeOrgId?.trim() ?? "";
    snapshot = {
      workspaceContextKey,
      skills: state.skills,
      skillsStatus: state.skillsStatus,
      hubSkills: state.hubSkills,
      hubSkillsStatus: state.hubSkillsStatus,
      cloudOrgSkills: state.cloudOrgSkills,
      cloudOrgSkillsStatus: state.cloudOrgSkillsStatus,
      importedCloudSkills: state.importedCloudSkills,
      cloudOrgSkillHubs: state.cloudOrgSkillHubs,
      cloudOrgSkillHubsStatus: state.cloudOrgSkillHubsStatus,
      importedCloudSkillHubs: state.importedCloudSkillHubs,
      hubRepo: state.hubRepo,
      hubRepos: state.hubRepos,
      pluginScope: state.pluginScope,
      pluginConfig: state.pluginConfig,
      pluginConfigPath: state.pluginConfigPath,
      pluginList: state.pluginList,
      pluginInput: state.pluginInput,
      pluginStatus: state.pluginStatus,
      activePluginGuide: state.activePluginGuide,
      sidebarPluginList: state.sidebarPluginList,
      sidebarPluginStatus: state.sidebarPluginStatus,
      skillsStale: state.skillsContextKey !== workspaceContextKey,
      pluginsStale: state.pluginsContextKey !== workspaceContextKey,
      hubSkillsStale: state.hubSkillsContextKey !== workspaceContextKey,
      cloudOrgSkillsStale: state.cloudOrgSkillsContextKey !== `${workspaceContextKey}::${orgId}`,
    };
  };

  const mutateState = (updater: (current: MutableState) => MutableState) => {
    state = updater(state);
    refreshSnapshot();
    emitChange();
  };

  const setStateField = <K extends keyof MutableState>(key: K, value: MutableState[K]) => {
    if (Object.is(state[key], value)) return;
    mutateState((current) => ({ ...current, [key]: value }));
  };

  const applyStateAction = <T,>(current: T, next: SetStateAction<T>) =>
    typeof next === "function" ? (next as (value: T) => T)(current) : next;

  const formatSkillPath = (location: string) => location.replace(/[/\\]SKILL\.md$/i, "");

  const normalizeHubRepo = (input?: Partial<HubSkillRepo> | null): HubSkillRepo | null => {
    const owner = input?.owner?.trim() || "";
    const repo = input?.repo?.trim() || "";
    const ref = input?.ref?.trim() || DEFAULT_HUB_REPO.ref;
    if (!owner || !repo) return null;
    return { owner, repo, ref };
  };

  const hubRepoKey = (repo: HubSkillRepo) => `${repo.owner}/${repo.repo}@${repo.ref}`;

  const normalizeHubRepoList = (items: unknown[]): HubSkillRepo[] => {
    const seen = new Set<string>();
    const next: HubSkillRepo[] = [];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const normalized = normalizeHubRepo({
        owner: typeof record.owner === "string" ? record.owner : undefined,
        repo: typeof record.repo === "string" ? record.repo : undefined,
        ref: typeof record.ref === "string" ? record.ref : undefined,
      });
      if (!normalized) continue;
      const key = hubRepoKey(normalized);
      if (seen.has(key)) continue;
      seen.add(key);
      next.push(normalized);
    }
    return next;
  };

  const readWorkspaceOpenworkConfigRecord = async (): Promise<Record<string, unknown>> => {
    const root = options.selectedWorkspaceRoot().trim();
    const isLocalWorkspace = options.workspaceType() === "local";
    const openworkSnapshot = options.openworkServer.getSnapshot();
    const openworkClient = openworkSnapshot.openworkServerClient;
    const openworkWorkspaceId = options.runtimeWorkspaceId();
    const canUseOpenworkServer =
      openworkSnapshot.openworkServerStatus === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      openworkSnapshot.openworkServerCapabilities?.config?.read;

    if (canUseOpenworkServer) {
      const config = await openworkClient.getConfig(openworkWorkspaceId);
      return config.openwork ?? {};
    }

    if (isLocalWorkspace && isTauriRuntime() && root) {
      return await workspaceOpenworkRead({ workspacePath: root }) as unknown as Record<string, unknown>;
    }

    return {};
  };

  const writeWorkspaceOpenworkConfigRecord = async (config: Record<string, unknown>) => {
    const root = options.selectedWorkspaceRoot().trim();
    const isLocalWorkspace = options.workspaceType() === "local";
    const openworkSnapshot = options.openworkServer.getSnapshot();
    const openworkClient = openworkSnapshot.openworkServerClient;
    const openworkWorkspaceId = options.runtimeWorkspaceId();
    const canUseOpenworkServer =
      openworkSnapshot.openworkServerStatus === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      openworkSnapshot.openworkServerCapabilities?.config?.write;

    if (canUseOpenworkServer) {
      await openworkClient.patchConfig(openworkWorkspaceId, { openwork: config });
      return true;
    }

    if (isLocalWorkspace && isTauriRuntime() && root) {
      const result = await workspaceOpenworkWrite({
        workspacePath: root,
        config: config as never,
      });
      if (!result.ok) {
        throw new Error(result.stderr || result.stdout || "Failed to write .opencode/openwork.json");
      }
      return true;
    }

    return false;
  };

  const refreshImportedCloudSkillHubs = async () => {
    try {
      const config = await readWorkspaceOpenworkConfigRecord();
      const cloudImports = readWorkspaceCloudImports(config);
      setStateField("importedCloudSkillHubs", cloudImports.skillHubs);
      return cloudImports.skillHubs;
    } catch {
      setStateField("importedCloudSkillHubs", {});
      return {};
    }
  };

  const refreshImportedCloudSkills = async () => {
    try {
      const config = await readWorkspaceOpenworkConfigRecord();
      const cloudImports = readWorkspaceCloudImports(config);
      setStateField("importedCloudSkills", cloudImports.skills);
      return cloudImports.skills;
    } catch {
      setStateField("importedCloudSkills", {});
      return {};
    }
  };

  const persistImportedCloudSkillHubs = async (nextSkillHubs: Record<string, CloudImportedSkillHub>) => {
    const config = await readWorkspaceOpenworkConfigRecord();
    const cloudImports = readWorkspaceCloudImports(config);
    const nextConfig = withWorkspaceCloudImports(config, {
      ...cloudImports,
      skillHubs: nextSkillHubs,
    });
    const persisted = await writeWorkspaceOpenworkConfigRecord(nextConfig);
    if (!persisted) {
      throw new Error("OpenWork server unavailable. Connect to manage imported cloud skill hubs.");
    }
    setStateField("importedCloudSkillHubs", nextSkillHubs);
  };

  const persistImportedCloudSkills = async (nextSkills: Record<string, CloudImportedSkill>) => {
    const config = await readWorkspaceOpenworkConfigRecord();
    const cloudImports = readWorkspaceCloudImports(config);
    const nextConfig = withWorkspaceCloudImports(config, {
      ...cloudImports,
      skills: nextSkills,
    });
    const persisted = await writeWorkspaceOpenworkConfigRecord(nextConfig);
    if (!persisted) {
      throw new Error("OpenWork server unavailable. Connect to manage imported cloud skills.");
    }
    setStateField("importedCloudSkills", nextSkills);
  };

  const buildCloudSkillContent = (name: string, description: string, body: string) => {
    const safeDescription = description.replace(/\s+/g, " ").trim();
    const normalizedBody = body.replace(/^\s*\n?/, "");
    return [
      "---",
      `name: ${JSON.stringify(name)}`,
      `description: ${JSON.stringify(safeDescription)}`,
      "---",
      "",
      normalizedBody,
    ].join("\n");
  };

  const upsertWorkspaceSkill = async (
    name: string,
    content: string,
    description: string,
    optionsOverride?: { overwrite?: boolean },
  ) => {
    const isRemoteWorkspace = options.workspaceType() === "remote";
    const isLocalWorkspace = options.workspaceType() === "local";
    const root = options.selectedWorkspaceRoot().trim();
    const openworkSnapshot = options.openworkServer.getSnapshot();
    const openworkClient = openworkSnapshot.openworkServerClient;
    const openworkWorkspaceId = options.runtimeWorkspaceId();
    const canUseOpenworkServer =
      openworkSnapshot.openworkServerStatus === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      openworkSnapshot.openworkServerCapabilities?.skills?.write;

    if (canUseOpenworkServer) {
      await openworkClient.upsertSkill(openworkWorkspaceId, {
        name,
        content,
        description,
      });
      return;
    }

    if (isRemoteWorkspace) {
      throw new Error("OpenWork server unavailable. Connect to import skills.");
    }

    if (!isTauriRuntime()) {
      throw new Error(translate("skills.desktop_required"));
    }

    if (!isLocalWorkspace || !root) {
      throw new Error(translate("skills.pick_workspace_first"));
    }

    const result = await installSkillTemplate(root, name, content, {
      overwrite: optionsOverride?.overwrite ?? false,
    });
    if (!result.ok) {
      throw new Error(result.stderr || result.stdout || translate("skills.install_failed"));
    }
  };

  const buildImportedSkillNameMap = (imported?: CloudImportedSkillHub | null) => {
    const mapping = new Map<string, string>();
    if (!imported) return mapping;
    imported.skillIds.forEach((skillId, index) => {
      const name = imported.skillNames[index]?.trim();
      if (skillId.trim() && name) {
        mapping.set(skillId.trim(), name);
      }
    });
    return mapping;
  };

  const findImportedCloudSkill = (cloudSkillId: string) => snapshot.importedCloudSkills[cloudSkillId] ?? null;

  const persistImportedCloudSkillRecord = async (skill: DenOrgSkillCard, installedName: string) => {
    const imported = findImportedCloudSkill(skill.id);
    const nextSkills = {
      ...snapshot.importedCloudSkills,
      [skill.id]: {
        cloudSkillId: skill.id,
        installedName,
        title: skill.title,
        description: skill.description,
        shared: skill.shared,
        updatedAt: skill.updatedAt,
        importedAt: imported?.importedAt ?? Date.now(),
      },
    } satisfies Record<string, CloudImportedSkill>;
    await persistImportedCloudSkills(nextSkills);
    return nextSkills[skill.id];
  };

  const deleteWorkspaceSkill = async (name: string) => {
    const isRemoteWorkspace = options.workspaceType() === "remote";
    const isLocalWorkspace = options.workspaceType() === "local";
    const root = options.selectedWorkspaceRoot().trim();
    const openworkSnapshot = options.openworkServer.getSnapshot();
    const openworkClient = openworkSnapshot.openworkServerClient;
    const openworkWorkspaceId = options.runtimeWorkspaceId();
    const canUseOpenworkServer =
      openworkSnapshot.openworkServerStatus === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      openworkSnapshot.openworkServerCapabilities?.skills?.write;

    if (canUseOpenworkServer) {
      await openworkClient.deleteSkill(openworkWorkspaceId, name);
      return;
    }

    if (isRemoteWorkspace) {
      throw new Error("OpenWork server unavailable. Connect to remove skills.");
    }

    if (!isTauriRuntime()) {
      throw new Error(translate("skills.desktop_required"));
    }

    if (!isLocalWorkspace || !root) {
      throw new Error(translate("skills.pick_workspace_first"));
    }

    const result = await uninstallSkillCommand(root, name);
    if (!result.ok) {
      throw new Error(result.stderr || result.stdout || translate("skills.uninstall_failed"));
    }
  };

  const applyCloudOrgSkillHubImport = async (hub: DenOrgSkillHub, imported?: CloudImportedSkillHub | null) => {
    const importedNameMap = buildImportedSkillNameMap(imported);
    const taken = new Set(snapshot.skills.map((skill) => skill.name));
    imported?.skillNames.forEach((name) => {
      if (name.trim()) taken.delete(name.trim());
    });

    const nextSkillNames: string[] = [];
    const nextSkillIds: string[] = [];

    for (const skill of hub.skills) {
      const preferredName = importedNameMap.get(skill.id)?.trim() ?? "";
      const installName =
        preferredName && !nextSkillNames.includes(preferredName)
          ? preferredName
          : uniqueSkillInstallName(slugifyOpencodeSkillName(skill.title), taken, skill.id);
      taken.add(installName);
      nextSkillNames.push(installName);
      nextSkillIds.push(skill.id);

      const rawDesc = (skill.description?.trim() || skill.title).trim();
      const description = rawDesc.slice(0, 1024) || skill.title.slice(0, 1024) || "Skill";
      const body = extractSkillBodyMarkdown(skill.skillText);
      const content = buildCloudSkillContent(installName, description, body);
      await upsertWorkspaceSkill(installName, content, description, {
        overwrite: Boolean(preferredName),
      });
    }

    const removedSkillNames = (imported?.skillNames ?? []).filter((name) => !nextSkillNames.includes(name));
    for (const name of removedSkillNames) {
      await deleteWorkspaceSkill(name);
    }

    return { nextSkillNames, nextSkillIds, removedSkillNames };
  };

  const persistHubRepos = () => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        HUB_REPOS_STORAGE_KEY,
        JSON.stringify({ selected: state.hubRepo, repos: state.hubRepos }),
      );
    } catch {
      // ignore
    }
  };

  const invalidateWorkspaceCaches = () => {
    skillsLoaded = false;
    hubSkillsLoaded = false;
    cloudOrgSkillsLoaded = false;
    cloudOrgSkillHubsLoaded = false;
    skillsRoot = "";
    hubSkillsLoadKey = "";
    cloudOrgSkillsLoadKey = "";
    cloudOrgSkillHubsLoadKey = "";
  };

  const touch = () => {
    refreshSnapshot();
    emitChange();
  };

  async function refreshHubSkills(optionsOverride?: { force?: boolean }) {
    const root = options.selectedWorkspaceRoot().trim();
    const repo = snapshot.hubRepo;
    const loadKey = `${root}::${repo ? hubRepoKey(repo) : "none"}`;
    const openworkSnapshot = options.openworkServer.getSnapshot();
    const openworkClient = openworkSnapshot.openworkServerClient;
    const canUseOpenworkServer =
      openworkSnapshot.openworkServerStatus === "connected" &&
      openworkClient &&
      openworkSnapshot.openworkServerCapabilities?.hub?.skills?.read;

    if (loadKey !== hubSkillsLoadKey) {
      hubSkillsLoaded = false;
    }

    if (!optionsOverride?.force && hubSkillsLoaded) return;
    if (refreshHubSkillsInFlight) return;

    refreshHubSkillsInFlight = true;
    refreshHubSkillsAborted = false;

    try {
      setStateField("hubSkillsStatus", null);

      if (!repo) {
        mutateState((current) => ({
          ...current,
          hubSkills: [],
          hubSkillsStatus: "No hub repo selected. Add a GitHub repo to browse skills.",
        }));
        hubSkillsLoaded = true;
        hubSkillsLoadKey = loadKey;
        return;
      }

      if (canUseOpenworkServer) {
        const response = await openworkClient.listHubSkills({
          repo: {
            owner: repo.owner,
            repo: repo.repo,
            ref: repo.ref,
          },
        });
        if (refreshHubSkillsAborted) return;
        const next: HubSkillCard[] = Array.isArray(response?.items)
          ? response.items.map((entry) => ({
              name: String(entry.name ?? ""),
              description: typeof entry.description === "string" ? entry.description : undefined,
              trigger: typeof entry.trigger === "string" ? entry.trigger : undefined,
              source: entry.source,
            }))
          : [];
        mutateState((current) => ({
          ...current,
          hubSkills: next,
          hubSkillsStatus: next.length ? null : "No hub skills found.",
          hubSkillsContextKey: getWorkspaceContextKey(),
        }));
        hubSkillsLoaded = true;
        hubSkillsLoadKey = loadKey;
        return;
      }

      const listingRes = await fetch(
        `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/contents/skills?ref=${encodeURIComponent(repo.ref)}`,
        { headers: { Accept: "application/vnd.github+json" } },
      );
      if (!listingRes.ok) {
        throw new Error(`Failed to fetch hub catalog (${listingRes.status})`);
      }
      const listing = (await listingRes.json()) as unknown;
      const dirs: string[] = Array.isArray(listing)
        ? listing
            .filter((entry) => entry && typeof entry === "object" && (entry as { type?: string }).type === "dir")
            .map((entry) => String((entry as { name?: string }).name ?? ""))
            .filter(Boolean)
        : [];

      const next: HubSkillCard[] = dirs.map((dirName) => ({
        name: dirName,
        source: { owner: repo.owner, repo: repo.repo, ref: repo.ref, path: `skills/${dirName}` },
      }));

      if (refreshHubSkillsAborted) return;
      const sorted = next.slice().sort((a, b) => a.name.localeCompare(b.name));
      mutateState((current) => ({
        ...current,
        hubSkills: sorted,
        hubSkillsStatus: sorted.length ? null : "No hub skills found.",
        hubSkillsContextKey: getWorkspaceContextKey(),
      }));
      hubSkillsLoaded = true;
      hubSkillsLoadKey = loadKey;
    } catch (error) {
      if (refreshHubSkillsAborted) return;
      mutateState((current) => ({
        ...current,
        hubSkills: [],
        hubSkillsStatus: error instanceof Error ? error.message : "Failed to load hub skills.",
      }));
    } finally {
      refreshHubSkillsInFlight = false;
    }
  }

  async function refreshCloudOrgSkills(optionsOverride?: { force?: boolean }) {
    const root = options.selectedWorkspaceRoot().trim();
    const wk = getWorkspaceContextKey();
    const settings = readDenSettings();
    const token = settings.authToken?.trim() ?? "";
    const orgId = settings.activeOrgId?.trim() ?? "";
    const loadKey = `${wk}::${orgId}`;

    if (!root) {
      mutateState((current) => ({
        ...current,
        cloudOrgSkills: [],
        cloudOrgSkillsStatus: null,
        cloudOrgSkillsContextKey: loadKey,
      }));
      cloudOrgSkillsLoaded = true;
      cloudOrgSkillsLoadKey = loadKey;
      return;
    }

    if (loadKey !== cloudOrgSkillsLoadKey) {
      cloudOrgSkillsLoaded = false;
    }

    if (!optionsOverride?.force && cloudOrgSkillsLoaded) {
      await refreshImportedCloudSkills();
      return;
    }
    if (refreshCloudOrgSkillsInFlight) return;

    refreshCloudOrgSkillsInFlight = true;
    refreshCloudOrgSkillsAborted = false;

    try {
      setStateField("cloudOrgSkillsStatus", null);

      if (!token || !orgId) {
        mutateState((current) => ({
          ...current,
          cloudOrgSkills: [],
          cloudOrgSkillsStatus: null,
          cloudOrgSkillsContextKey: loadKey,
        }));
        cloudOrgSkillsLoaded = true;
        cloudOrgSkillsLoadKey = loadKey;
        await refreshImportedCloudSkills();
        return;
      }

      const client = createDenClient({ baseUrl: settings.baseUrl, apiBaseUrl: settings.apiBaseUrl, token });
      const catalog = await fetchDenOrgSkillsCatalog(client, orgId);
      if (refreshCloudOrgSkillsAborted) return;
      mutateState((current) => ({
        ...current,
        cloudOrgSkills: catalog,
        cloudOrgSkillsStatus: catalog.length ? null : translate("skills.cloud_org_empty"),
        cloudOrgSkillsContextKey: loadKey,
      }));
      cloudOrgSkillsLoaded = true;
      cloudOrgSkillsLoadKey = loadKey;
      await refreshImportedCloudSkills();
    } catch (error) {
      if (refreshCloudOrgSkillsAborted) return;
      mutateState((current) => ({
        ...current,
        cloudOrgSkills: [],
        cloudOrgSkillsStatus:
          error instanceof Error ? error.message : translate("skills.cloud_org_load_failed"),
      }));
    } finally {
      refreshCloudOrgSkillsInFlight = false;
    }
  }

  async function refreshCloudOrgSkillHubs(optionsOverride?: { force?: boolean }) {
    const wk = getWorkspaceContextKey();
    const settings = readDenSettings();
    const token = settings.authToken?.trim() ?? "";
    const orgId = settings.activeOrgId?.trim() ?? "";
    const loadKey = `${wk}::${orgId}`;

    if (loadKey !== cloudOrgSkillHubsLoadKey) {
      cloudOrgSkillHubsLoaded = false;
    }

    if (!optionsOverride?.force && cloudOrgSkillHubsLoaded) {
      await refreshImportedCloudSkillHubs();
      return;
    }
    if (refreshCloudOrgSkillHubsInFlight) return;

    refreshCloudOrgSkillHubsInFlight = true;
    refreshCloudOrgSkillHubsAborted = false;

    try {
      setStateField("cloudOrgSkillHubsStatus", null);

      if (!token || !orgId) {
        mutateState((current) => ({
          ...current,
          cloudOrgSkillHubs: [],
          cloudOrgSkillHubsStatus: null,
        }));
        cloudOrgSkillHubsLoaded = true;
        cloudOrgSkillHubsLoadKey = loadKey;
        await refreshImportedCloudSkillHubs();
        return;
      }

      const client = createDenClient({ baseUrl: settings.baseUrl, apiBaseUrl: settings.apiBaseUrl, token });
      const hubs = await client.listOrgSkillHubs(orgId);
      if (refreshCloudOrgSkillHubsAborted) return;
      mutateState((current) => ({
        ...current,
        cloudOrgSkillHubs: hubs,
        cloudOrgSkillHubsStatus: hubs.length ? null : "No organization skill hubs are available yet.",
      }));
      cloudOrgSkillHubsLoaded = true;
      cloudOrgSkillHubsLoadKey = loadKey;
      await refreshImportedCloudSkillHubs();
    } catch (error) {
      if (refreshCloudOrgSkillHubsAborted) return;
      mutateState((current) => ({
        ...current,
        cloudOrgSkillHubs: [],
        cloudOrgSkillHubsStatus:
          error instanceof Error ? error.message : "Failed to load organization skill hubs.",
      }));
    } finally {
      refreshCloudOrgSkillHubsInFlight = false;
    }
  }

  async function importCloudOrgSkillHub(hub: DenOrgSkillHub): Promise<{ ok: boolean; message: string; importedNames: string[] }> {
    const importedNames: string[] = [];
    options.setBusy(true);
    options.setError(null);
    setStateField("skillsStatus", null);

    try {
      const applied = await applyCloudOrgSkillHubImport(hub, snapshot.importedCloudSkillHubs[hub.id]);
      importedNames.push(...applied.nextSkillNames);
      const nextImports = {
        ...snapshot.importedCloudSkillHubs,
        [hub.id]: {
          hubId: hub.id,
          name: hub.name,
          skillNames: applied.nextSkillNames,
          skillIds: applied.nextSkillIds,
          importedAt: Date.now(),
        },
      };
      await persistImportedCloudSkillHubs(nextImports);
      options.markReloadRequired?.("skills", { type: "skill", name: hub.name, action: "added" });
      await refreshSkills({ force: true });
      await refreshCloudOrgSkills({ force: true });
      await refreshCloudOrgSkillHubs({ force: true });
      return {
        ok: true,
        message: `Imported ${hub.skills.length} skill${hub.skills.length === 1 ? "" : "s"} from ${hub.name}.`,
        importedNames,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : translate("skills.unknown_error");
      options.setError(addOpencodeCacheHint(message));
      return { ok: false, message, importedNames };
    } finally {
      options.setBusy(false);
    }
  }

  async function syncCloudOrgSkillHub(hub: DenOrgSkillHub): Promise<{ ok: boolean; message: string; importedNames: string[] }> {
    const imported = snapshot.importedCloudSkillHubs[hub.id];
    if (!imported) return importCloudOrgSkillHub(hub);

    options.setBusy(true);
    options.setError(null);
    setStateField("skillsStatus", null);

    try {
      const applied = await applyCloudOrgSkillHubImport(hub, imported);
      const nextImports = {
        ...snapshot.importedCloudSkillHubs,
        [hub.id]: {
          hubId: hub.id,
          name: hub.name,
          skillNames: applied.nextSkillNames,
          skillIds: applied.nextSkillIds,
          importedAt: imported.importedAt ?? Date.now(),
        },
      };
      await persistImportedCloudSkillHubs(nextImports);
      options.markReloadRequired?.("skills", { type: "skill", name: hub.name, action: "added" });
      await refreshSkills({ force: true });
      await refreshCloudOrgSkills({ force: true });
      await refreshCloudOrgSkillHubs({ force: true });
      return { ok: true, message: `Synced ${hub.name} from cloud.`, importedNames: applied.nextSkillNames };
    } catch (error) {
      const message = error instanceof Error ? error.message : translate("skills.unknown_error");
      options.setError(addOpencodeCacheHint(message));
      return { ok: false, message, importedNames: [] };
    } finally {
      options.setBusy(false);
    }
  }

  async function removeCloudOrgSkillHub(hubId: string): Promise<{ ok: boolean; message: string; removedNames: string[] }> {
    const imported = snapshot.importedCloudSkillHubs[hubId];
    if (!imported) {
      return { ok: false, message: "This skill hub has not been imported into the workspace.", removedNames: [] };
    }

    options.setBusy(true);
    options.setError(null);
    setStateField("skillsStatus", null);

    try {
      for (const name of imported.skillNames) {
        await deleteWorkspaceSkill(name);
        options.markReloadRequired?.("skills", { type: "skill", name, action: "removed" });
      }

      const nextImports = { ...snapshot.importedCloudSkillHubs };
      delete nextImports[hubId];
      await persistImportedCloudSkillHubs(nextImports);
      await refreshSkills({ force: true });
      await refreshCloudOrgSkills({ force: true });
      await refreshCloudOrgSkillHubs({ force: true });
      return {
        ok: true,
        message: `Removed ${imported.skillNames.length} imported skill${imported.skillNames.length === 1 ? "" : "s"} from ${imported.name}.`,
        removedNames: imported.skillNames,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : translate("skills.unknown_error");
      options.setError(addOpencodeCacheHint(message));
      return { ok: false, message, removedNames: [] };
    } finally {
      options.setBusy(false);
    }
  }

  async function installHubSkill(name: string): Promise<{ ok: boolean; message: string }> {
    const trimmed = name.trim();
    if (!trimmed) return { ok: false, message: "Skill name is required." };
    const repo = snapshot.hubRepo;
    if (!repo) return { ok: false, message: "Select a hub repo before installing skills." };

    const isRemoteWorkspace = options.workspaceType() === "remote";
    const openworkSnapshot = options.openworkServer.getSnapshot();
    const openworkClient = openworkSnapshot.openworkServerClient;
    const openworkWorkspaceId = options.runtimeWorkspaceId();
    const canUseOpenworkServer =
      openworkSnapshot.openworkServerStatus === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      openworkSnapshot.openworkServerCapabilities?.hub?.skills?.install;

    if (!canUseOpenworkServer) {
      if (isRemoteWorkspace) return { ok: false, message: "OpenWork server unavailable. Connect to install skills." };
      return { ok: false, message: "Hub install requires OpenWork server." };
    }

    options.setBusy(true);
    options.setError(null);
    setStateField("skillsStatus", null);

    try {
      const repoOverride: OpenworkHubRepo = { owner: repo.owner, repo: repo.repo, ref: repo.ref };
      const result = await openworkClient.installHubSkill(openworkWorkspaceId, trimmed, { repo: repoOverride });
      await refreshSkills({ force: true });
      await refreshHubSkills({ force: true });
      if (!result?.ok) return { ok: false, message: "Install failed." };
      return { ok: true, message: `Installed ${trimmed}.` };
    } catch (error) {
      const message = error instanceof Error ? error.message : translate("skills.unknown_error");
      options.setError(addOpencodeCacheHint(message));
      return { ok: false, message };
    } finally {
      options.setBusy(false);
    }
  }

  async function installCloudOrgSkill(skill: DenOrgSkillCard): Promise<{ ok: boolean; message: string }> {
    const existingImport = findImportedCloudSkill(skill.id);
    const installedNames = new Set(snapshot.skills.map((entry) => entry.name));
    const preferredName = existingImport?.installedName?.trim() ?? "";
    if (preferredName) installedNames.delete(preferredName);
    const installName = preferredName || uniqueSkillInstallName(slugifyOpencodeSkillName(skill.title), installedNames, skill.id);
    const rawDesc = (skill.description?.trim() || skill.title).trim();
    const description = rawDesc.slice(0, 1024) || skill.title.slice(0, 1024) || "Skill";
    const body = extractSkillBodyMarkdown(skill.skillText);
    const content = buildCloudSkillContent(installName, description, body);
    const action = existingImport ? "updated" : "added";

    options.setBusy(true);
    options.setError(null);
    setStateField("skillsStatus", null);

    try {
      await upsertWorkspaceSkill(installName, content, description, { overwrite: Boolean(existingImport) });
      await persistImportedCloudSkillRecord(skill, installName);
      options.markReloadRequired?.("skills", { type: "skill", name: installName, action });
      await refreshSkills({ force: true });
      await refreshCloudOrgSkills({ force: true });
      return {
        ok: true,
        message: t(existingImport ? "skills.cloud_updated" : "skills.cloud_installed", currentLocale(), { name: installName }),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : translate("skills.unknown_error");
      options.setError(addOpencodeCacheHint(message));
      return { ok: false, message };
    } finally {
      options.setBusy(false);
    }
  }

  async function syncCloudOrgSkill(skill: DenOrgSkillCard): Promise<{ ok: boolean; message: string }> {
    return installCloudOrgSkill(skill);
  }

  async function removeCloudOrgSkill(cloudSkillId: string): Promise<{ ok: boolean; message: string; removedName: string | null }> {
    const imported = findImportedCloudSkill(cloudSkillId);
    if (!imported) {
      return { ok: false, message: "This cloud skill has not been installed into the workspace.", removedName: null };
    }

    options.setBusy(true);
    options.setError(null);
    setStateField("skillsStatus", null);

    try {
      if (snapshot.skills.some((skill) => skill.name === imported.installedName)) {
        await deleteWorkspaceSkill(imported.installedName);
      }
      const nextImports = { ...snapshot.importedCloudSkills };
      delete nextImports[cloudSkillId];
      await persistImportedCloudSkills(nextImports);
      options.markReloadRequired?.("skills", { type: "skill", name: imported.installedName, action: "removed" });
      await refreshSkills({ force: true });
      await refreshCloudOrgSkills({ force: true });
      return {
        ok: true,
        message: t("skills.cloud_removed", currentLocale(), { name: imported.installedName }),
        removedName: imported.installedName,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : translate("skills.unknown_error");
      options.setError(addOpencodeCacheHint(message));
      return { ok: false, message, removedName: null };
    } finally {
      options.setBusy(false);
    }
  }

  const isPluginInstalledByName = (pluginName: string, aliases: string[] = []) =>
    isPluginInstalled(snapshot.pluginList, pluginName, aliases);

  const loadPluginsFromConfig = (config: OpencodeConfigFile | null) => {
    const nextPluginList: string[] = [];
    let nextPluginStatus: string | null = null;
    loadPluginsFromConfigHelpers(
      config,
      (value) => {
        nextPluginList.splice(0, nextPluginList.length, ...applyStateAction(nextPluginList, value));
      },
      (message) => {
        nextPluginStatus = message;
      },
    );
    mutateState((current) => ({
      ...current,
      pluginList: nextPluginList,
      pluginStatus: nextPluginStatus,
    }));
  };

  async function refreshSkills(optionsOverride?: { force?: boolean }) {
    const root = options.selectedWorkspaceRoot().trim();
    const isRemoteWorkspace = options.workspaceType() === "remote";
    const isLocalWorkspace = options.workspaceType() === "local";
    const openworkSnapshot = options.openworkServer.getSnapshot();
    const openworkClient = openworkSnapshot.openworkServerClient;
    const openworkWorkspaceId = options.runtimeWorkspaceId();
    const canUseOpenworkServer =
      openworkSnapshot.openworkServerStatus === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      openworkSnapshot.openworkServerCapabilities?.skills?.read;

    if (!root) {
      mutateState((current) => ({
        ...current,
        skills: [],
        skillsStatus: translate("skills.pick_workspace_first"),
      }));
      return;
    }

    if (canUseOpenworkServer) {
      if (root !== skillsRoot) skillsLoaded = false;
      if (!optionsOverride?.force && skillsLoaded) return;
      if (refreshSkillsInFlight) return;

      refreshSkillsInFlight = true;
      refreshSkillsAborted = false;
      try {
        setStateField("skillsStatus", null);
        const response = await openworkClient.listSkills(openworkWorkspaceId, { includeGlobal: isLocalWorkspace });
        if (refreshSkillsAborted) return;
        const next: SkillCard[] = Array.isArray(response.items)
          ? response.items.map((entry) => ({
              name: entry.name,
              description: entry.description,
              path: entry.path,
              trigger: entry.trigger,
            }))
          : [];
        mutateState((current) => ({
          ...current,
          skills: next,
          skillsStatus: next.length ? null : translate("skills.no_skills_found"),
          skillsContextKey: getWorkspaceContextKey(),
        }));
        skillsLoaded = true;
        skillsRoot = root;
      } catch (error) {
        if (refreshSkillsAborted) return;
        mutateState((current) => ({
          ...current,
          skills: [],
          skillsStatus: error instanceof Error ? error.message : translate("skills.failed_to_load"),
        }));
      } finally {
        refreshSkillsInFlight = false;
      }
      return;
    }

    if (isLocalWorkspace && isTauriRuntime()) {
      if (root !== skillsRoot) skillsLoaded = false;
      if (!optionsOverride?.force && skillsLoaded) return;
      if (refreshSkillsInFlight) return;

      refreshSkillsInFlight = true;
      refreshSkillsAborted = false;
      try {
        setStateField("skillsStatus", null);
        const local = await listLocalSkills(root);
        if (refreshSkillsAborted) return;
        const next: SkillCard[] = Array.isArray(local)
          ? local.map((entry) => ({
              name: entry.name,
              description: entry.description,
              path: entry.path,
              trigger: entry.trigger,
            }))
          : [];
        mutateState((current) => ({
          ...current,
          skills: next,
          skillsStatus: next.length ? null : translate("skills.no_skills_found"),
          skillsContextKey: getWorkspaceContextKey(),
        }));
        skillsLoaded = true;
        skillsRoot = root;
      } catch (error) {
        if (refreshSkillsAborted) return;
        mutateState((current) => ({
          ...current,
          skills: [],
          skillsStatus: error instanceof Error ? error.message : translate("skills.failed_to_load"),
        }));
      } finally {
        refreshSkillsInFlight = false;
      }
      return;
    }

    const client = options.client();
    if (!client) {
      mutateState((current) => ({
        ...current,
        skills: [],
        skillsStatus: "OpenWork server unavailable. Connect to load skills.",
      }));
      return;
    }

    if (root !== skillsRoot) skillsLoaded = false;
    if (!optionsOverride?.force && skillsLoaded) return;
    if (refreshSkillsInFlight) return;

    refreshSkillsInFlight = true;
    refreshSkillsAborted = false;
    try {
      setStateField("skillsStatus", null);
      const rawClient = client as unknown as { _client?: { get: (input: { url: string }) => Promise<unknown> } };
      if (!rawClient._client) throw new Error("OpenCode client unavailable.");
      const result = await rawClient._client.get({ url: "/skill" }) as {
        data?: Array<{ name: string; description: string; location: string }>;
        error?: unknown;
      };
      if (result?.data === undefined) {
        const err = result?.error;
        const message = err instanceof Error ? err.message : typeof err === "string" ? err : translate("skills.failed_to_load");
        throw new Error(message);
      }
      if (refreshSkillsAborted) return;
      const next: SkillCard[] = Array.isArray(result.data)
        ? result.data.map((entry) => ({
            name: entry.name,
            description: entry.description,
            path: formatSkillPath(entry.location),
          }))
        : [];
      mutateState((current) => ({
        ...current,
        skills: next,
        skillsStatus: next.length ? null : translate("skills.no_skills_found"),
        skillsContextKey: getWorkspaceContextKey(),
      }));
      skillsLoaded = true;
      skillsRoot = root;
    } catch (error) {
      if (refreshSkillsAborted) return;
      mutateState((current) => ({
        ...current,
        skills: [],
        skillsStatus: error instanceof Error ? error.message : translate("skills.failed_to_load"),
      }));
    } finally {
      refreshSkillsInFlight = false;
    }
  }

  async function refreshPlugins(scopeOverride?: PluginScope) {
    const isRemoteWorkspace = options.workspaceType() === "remote";
    const isLocalWorkspace = options.workspaceType() === "local";
    const openworkSnapshot = options.openworkServer.getSnapshot();
    const openworkClient = openworkSnapshot.openworkServerClient;
    const openworkWorkspaceId = options.runtimeWorkspaceId();
    const canUseOpenworkServer =
      openworkSnapshot.openworkServerStatus === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      openworkSnapshot.openworkServerCapabilities?.plugins?.read;

    if (refreshPluginsInFlight) return;
    refreshPluginsInFlight = true;
    refreshPluginsAborted = false;

    const scope = scopeOverride ?? snapshot.pluginScope;
    const targetDir = options.projectDir().trim();

    if (scope !== "project" && !isLocalWorkspace) {
      mutateState((current) => ({
        ...current,
        pluginStatus: "Global plugins are only available for local workers.",
        pluginList: [],
        sidebarPluginStatus: "Global plugins require a local worker.",
        sidebarPluginList: [],
      }));
      refreshPluginsInFlight = false;
      return;
    }

    if (scope === "project" && canUseOpenworkServer) {
      mutateState((current) => ({
        ...current,
        pluginConfig: null,
        pluginConfigPath: `opencode.json (${isRemoteWorkspace ? "remote" : "openwork"} server)`,
      }));

      try {
        mutateState((current) => ({ ...current, pluginStatus: null, sidebarPluginStatus: null }));
        if (refreshPluginsAborted) return;
        const result = await openworkClient.listPlugins(openworkWorkspaceId, { includeGlobal: false });
        if (refreshPluginsAborted) return;
        const configItems = result.items.filter((item) => item.source === "config" && item.scope === "project");
        const list = configItems.map((item) => item.spec);
        mutateState((current) => ({
          ...current,
          pluginList: list,
          sidebarPluginList: list,
          pluginStatus: list.length ? null : "No plugins configured yet.",
          sidebarPluginStatus: null,
          pluginsContextKey: getWorkspaceContextKey(),
        }));
      } catch (error) {
        if (refreshPluginsAborted) return;
        mutateState((current) => ({
          ...current,
          pluginList: [],
          sidebarPluginList: [],
          sidebarPluginStatus: "Failed to load plugins.",
          pluginStatus: error instanceof Error ? error.message : "Failed to load plugins.",
        }));
      } finally {
        refreshPluginsInFlight = false;
      }
      return;
    }

    if (!isTauriRuntime()) {
      mutateState((current) => ({
        ...current,
        pluginStatus: translate("skills.plugin_management_host_only"),
        pluginList: [],
        sidebarPluginStatus: translate("skills.plugins_host_only"),
        sidebarPluginList: [],
      }));
      refreshPluginsInFlight = false;
      return;
    }

    if (!isLocalWorkspace && !canUseOpenworkServer) {
      mutateState((current) => ({
        ...current,
        pluginStatus: "OpenWork server unavailable. Connect to manage plugins.",
        pluginList: [],
        sidebarPluginStatus: "Connect an OpenWork server to load plugins.",
        sidebarPluginList: [],
      }));
      refreshPluginsInFlight = false;
      return;
    }

    if (scope === "project" && !targetDir) {
      mutateState((current) => ({
        ...current,
        pluginStatus: translate("skills.pick_project_for_plugins"),
        pluginList: [],
        sidebarPluginStatus: translate("skills.pick_project_for_active"),
        sidebarPluginList: [],
      }));
      refreshPluginsInFlight = false;
      return;
    }

    try {
      mutateState((current) => ({ ...current, pluginStatus: null, sidebarPluginStatus: null }));
      if (refreshPluginsAborted) return;
      const config = await readOpencodeConfig(scope, targetDir);
      if (refreshPluginsAborted) return;
      mutateState((current) => ({ ...current, pluginConfig: config, pluginConfigPath: config.path ?? null }));

      if (!config.exists) {
        mutateState((current) => ({
          ...current,
          pluginList: [],
          pluginStatus: translate("skills.no_opencode_found"),
          sidebarPluginList: [],
          sidebarPluginStatus: translate("skills.no_opencode_workspace"),
        }));
        return;
      }

      let nextSidebarPluginList: string[] = [];
      let nextSidebarPluginStatus: string | null = null;
      try {
        nextSidebarPluginList = parsePluginListFromContent(config.content ?? "");
      } catch {
        nextSidebarPluginList = [];
        nextSidebarPluginStatus = translate("skills.failed_parse_opencode");
      }

      const nextPluginList: string[] = [];
      let nextPluginStatus: string | null = null;
      loadPluginsFromConfigHelpers(
        config,
        (value) => {
          nextPluginList.splice(0, nextPluginList.length, ...applyStateAction(nextPluginList, value));
        },
        (message) => {
          nextPluginStatus = message;
        },
      );

      mutateState((current) => ({
        ...current,
        pluginList: nextPluginList,
        pluginStatus: nextPluginStatus,
        sidebarPluginList: nextSidebarPluginList,
        sidebarPluginStatus: nextSidebarPluginStatus,
        pluginsContextKey: getWorkspaceContextKey(),
      }));
    } catch (error) {
      if (refreshPluginsAborted) return;
      mutateState((current) => ({
        ...current,
        pluginConfig: null,
        pluginConfigPath: null,
        pluginList: [],
        pluginStatus: error instanceof Error ? error.message : translate("skills.failed_load_opencode"),
        sidebarPluginStatus: translate("skills.failed_load_active"),
        sidebarPluginList: [],
      }));
    } finally {
      refreshPluginsInFlight = false;
    }
  }

  async function addPlugin(pluginNameOverride?: string) {
    const pluginName = (pluginNameOverride ?? snapshot.pluginInput).trim();
    const isManualInput = pluginNameOverride == null;
    const triggerName = stripPluginVersion(pluginName);

    const isRemoteWorkspace = options.workspaceType() === "remote";
    const isLocalWorkspace = options.workspaceType() === "local";
    const openworkSnapshot = options.openworkServer.getSnapshot();
    const openworkClient = openworkSnapshot.openworkServerClient;
    const openworkWorkspaceId = options.runtimeWorkspaceId();
    const canUseOpenworkServer =
      openworkSnapshot.openworkServerStatus === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      openworkSnapshot.openworkServerCapabilities?.plugins?.write;

    if (!pluginName) {
      if (isManualInput) setStateField("pluginStatus", translate("skills.enter_plugin_name"));
      return;
    }

    if (snapshot.pluginScope !== "project" && !isLocalWorkspace) {
      setStateField("pluginStatus", "Global plugins are only available for local workers.");
      return;
    }

    if (snapshot.pluginScope === "project" && canUseOpenworkServer) {
      try {
        setStateField("pluginStatus", null);
        await openworkClient.addPlugin(openworkWorkspaceId, pluginName);
        options.markReloadRequired?.("plugins", { type: "plugin", name: triggerName, action: "added" });
        if (isManualInput) setStateField("pluginInput", "");
        await refreshPlugins("project");
      } catch (error) {
        setStateField("pluginStatus", error instanceof Error ? error.message : "Failed to add plugin.");
      }
      return;
    }

    if (!isTauriRuntime()) {
      setStateField("pluginStatus", translate("skills.plugin_management_host_only"));
      return;
    }

    if (!isLocalWorkspace && !canUseOpenworkServer) {
      setStateField("pluginStatus", "OpenWork server unavailable. Connect to manage plugins.");
      return;
    }

    const scope = snapshot.pluginScope;
    const targetDir = options.projectDir().trim();

    if (scope === "project" && !targetDir) {
      setStateField("pluginStatus", translate("skills.pick_project_for_plugins"));
      return;
    }

    try {
      setStateField("pluginStatus", null);
      const config = await readOpencodeConfig(scope, targetDir);
      const raw = config.content ?? "";

      if (!raw.trim()) {
        const payload = { $schema: "https://opencode.ai/config.json", plugin: [pluginName] };
        await writeOpencodeConfig(scope, targetDir, `${JSON.stringify(payload, null, 2)}\n`);
        options.markReloadRequired?.("plugins", { type: "plugin", name: triggerName, action: "added" });
        if (isManualInput) setStateField("pluginInput", "");
        await refreshPlugins(scope);
        return;
      }

      const plugins = parsePluginListFromContent(raw);
      const desired = stripPluginVersion(pluginName).toLowerCase();
      if (plugins.some((entry) => stripPluginVersion(entry).toLowerCase() === desired)) {
        setStateField("pluginStatus", translate("skills.plugin_already_listed"));
        return;
      }

      const next = [...plugins, pluginName];
      const edits = modify(raw, ["plugin"], next, { formattingOptions: { insertSpaces: true, tabSize: 2 } });
      const updated = applyEdits(raw, edits);
      await writeOpencodeConfig(scope, targetDir, updated);
      options.markReloadRequired?.("plugins", { type: "plugin", name: triggerName, action: "added" });
      if (isManualInput) setStateField("pluginInput", "");
      await refreshPlugins(scope);
    } catch (error) {
      setStateField("pluginStatus", error instanceof Error ? error.message : translate("skills.failed_update_opencode"));
    }
  }

  async function removePlugin(pluginName: string) {
    const name = pluginName.trim();
    if (!name) return;
    const triggerName = stripPluginVersion(name);

    const isLocalWorkspace = options.workspaceType() === "local";
    const openworkSnapshot = options.openworkServer.getSnapshot();
    const openworkClient = openworkSnapshot.openworkServerClient;
    const openworkWorkspaceId = options.runtimeWorkspaceId();
    const canUseOpenworkServer =
      openworkSnapshot.openworkServerStatus === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      openworkSnapshot.openworkServerCapabilities?.plugins?.write;

    if (snapshot.pluginScope !== "project" && !isLocalWorkspace) {
      setStateField("pluginStatus", "Global plugins are only available for local workers.");
      return;
    }

    if (snapshot.pluginScope === "project" && canUseOpenworkServer) {
      try {
        setStateField("pluginStatus", null);
        await openworkClient.removePlugin(openworkWorkspaceId, name);
        options.markReloadRequired?.("plugins", { type: "plugin", name: triggerName, action: "removed" });
        await refreshPlugins("project");
      } catch (error) {
        setStateField("pluginStatus", error instanceof Error ? error.message : "Failed to remove plugin.");
      }
      return;
    }

    if (!isTauriRuntime()) {
      setStateField("pluginStatus", translate("skills.plugin_management_host_only"));
      return;
    }

    if (!isLocalWorkspace && !canUseOpenworkServer) {
      setStateField("pluginStatus", "OpenWork server unavailable. Connect to manage plugins.");
      return;
    }

    const scope = snapshot.pluginScope;
    const targetDir = options.projectDir().trim();
    if (scope === "project" && !targetDir) {
      setStateField("pluginStatus", translate("skills.pick_project_for_plugins"));
      return;
    }

    try {
      setStateField("pluginStatus", null);
      const config = await readOpencodeConfig(scope, targetDir);
      const raw = config.content ?? "";
      if (!raw.trim()) {
        setStateField("pluginStatus", "No plugins configured yet.");
        return;
      }

      const plugins = parsePluginListFromContent(raw);
      const desired = stripPluginVersion(name).toLowerCase();
      const next = plugins.filter((entry) => stripPluginVersion(entry).toLowerCase() !== desired);
      if (next.length === plugins.length) {
        setStateField("pluginStatus", "Plugin not found.");
        return;
      }

      const edits = modify(raw, ["plugin"], next, { formattingOptions: { insertSpaces: true, tabSize: 2 } });
      const updated = applyEdits(raw, edits);
      await writeOpencodeConfig(scope, targetDir, updated);
      options.markReloadRequired?.("plugins", { type: "plugin", name: triggerName, action: "removed" });
      await refreshPlugins(scope);
    } catch (error) {
      setStateField("pluginStatus", error instanceof Error ? error.message : translate("skills.failed_update_opencode"));
    }
  }

  async function importLocalSkill() {
    const isLocalWorkspace = options.workspaceType() === "local";
    if (!isTauriRuntime()) {
      options.setError(translate("skills.desktop_required"));
      return;
    }
    if (!isLocalWorkspace) {
      options.setError("Local workers are required to import skills.");
      return;
    }
    const targetDir = options.projectDir().trim();
    if (!targetDir) {
      options.setError(translate("skills.pick_project_first"));
      return;
    }

    options.setBusy(true);
    options.setError(null);
    setStateField("skillsStatus", null);
    try {
      const selection = await pickDirectory({ title: translate("skills.select_skill_folder") });
      const sourceDir = typeof selection === "string" ? selection : Array.isArray(selection) ? selection[0] : null;
      if (!sourceDir) return;
      const inferredName = sourceDir.split(/[\\/]/).filter(Boolean).pop();
      const result = await importSkill(targetDir, sourceDir, { overwrite: false });
      if (!result.ok) {
        setStateField("skillsStatus", result.stderr || result.stdout || translate("skills.import_failed").replace("{status}", String(result.status)));
      } else {
        setStateField("skillsStatus", result.stdout || translate("skills.imported"));
        options.markReloadRequired?.("skills", { type: "skill", name: inferredName, action: "added" });
      }
      await refreshSkills({ force: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : translate("skills.unknown_error");
      options.setError(addOpencodeCacheHint(message));
    } finally {
      options.setBusy(false);
    }
  }

  async function installSkillCreator(): Promise<{ ok: boolean; message: string }> {
    const isRemoteWorkspace = options.workspaceType() === "remote";
    const isLocalWorkspace = options.workspaceType() === "local";
    const openworkSnapshot = options.openworkServer.getSnapshot();
    const openworkClient = openworkSnapshot.openworkServerClient;
    const openworkWorkspaceId = options.runtimeWorkspaceId();
    const canUseOpenworkServer =
      openworkSnapshot.openworkServerStatus === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      openworkSnapshot.openworkServerCapabilities?.skills?.write;

    if (canUseOpenworkServer) {
      options.setBusy(true);
      options.setError(null);
      setStateField("skillsStatus", translate("skills.installing_skill_creator"));
      try {
        await openworkClient.upsertSkill(openworkWorkspaceId, { name: "skill-creator", content: skillCreatorTemplate });
        const message = translate("skills.skill_creator_installed");
        setStateField("skillsStatus", message);
        options.markReloadRequired?.("skills", { type: "skill", name: "skill-creator", action: "added" });
        await refreshSkills({ force: true });
        return { ok: true, message };
      } catch (error) {
        const raw = error instanceof Error ? error.message : translate("skills.unknown_error");
        const message = addOpencodeCacheHint(raw);
        setStateField("skillsStatus", message);
        options.setError(message);
        return { ok: false, message };
      } finally {
        options.setBusy(false);
      }
    }

    if (isRemoteWorkspace) {
      const message = "OpenWork server unavailable. Connect to install skills.";
      setStateField("skillsStatus", message);
      return { ok: false, message };
    }
    if (!isTauriRuntime()) {
      const message = translate("skills.desktop_required");
      setStateField("skillsStatus", message);
      return { ok: false, message };
    }
    if (!isLocalWorkspace) {
      const message = "Local workers are required to install skills.";
      options.setError(message);
      setStateField("skillsStatus", message);
      return { ok: false, message };
    }

    const targetDir = options.selectedWorkspaceRoot().trim();
    if (!targetDir) {
      const message = translate("skills.pick_workspace_first");
      setStateField("skillsStatus", message);
      return { ok: false, message };
    }

    options.setBusy(true);
    options.setError(null);
    setStateField("skillsStatus", translate("skills.installing_skill_creator"));
    try {
      const result = await installSkillTemplate(targetDir, "skill-creator", skillCreatorTemplate, { overwrite: false });
      if (!result.ok && /already exists/i.test(result.stderr)) {
        const message = translate("skills.skill_creator_already_installed");
        setStateField("skillsStatus", message);
        await refreshSkills({ force: true });
        return { ok: true, message };
      }
      if (!result.ok) {
        const message = result.stderr || result.stdout || translate("skills.install_failed");
        setStateField("skillsStatus", message);
        await refreshSkills({ force: true });
        return { ok: false, message };
      }
      const message = result.stdout || translate("skills.skill_creator_installed");
      setStateField("skillsStatus", message);
      options.markReloadRequired?.("skills", { type: "skill", name: "skill-creator", action: "added" });
      await refreshSkills({ force: true });
      return { ok: true, message };
    } catch (error) {
      const raw = error instanceof Error ? error.message : translate("skills.unknown_error");
      const message = addOpencodeCacheHint(raw);
      setStateField("skillsStatus", message);
      options.setError(message);
      return { ok: false, message };
    } finally {
      options.setBusy(false);
    }
  }

  async function revealSkillsFolder() {
    if (!isTauriRuntime()) {
      setStateField("skillsStatus", translate("skills.desktop_required"));
      return;
    }
    const root = options.selectedWorkspaceRoot().trim();
    if (!root) {
      setStateField("skillsStatus", translate("skills.pick_workspace_first"));
      return;
    }

    try {
      const { openPath, revealItemInDir } = await import("@tauri-apps/plugin-opener");
      const opencodeSkills = await join(root, ".opencode", "skills");
      const claudeSkills = await join(root, ".claude", "skills");
      const legacySkills = await join(root, ".opencode", "skill");
      const tryOpen = async (target: string) => {
        try {
          await openPath(target);
          return true;
        } catch {
          return false;
        }
      };
      if (await tryOpen(opencodeSkills)) return;
      if (await tryOpen(claudeSkills)) return;
      if (await tryOpen(legacySkills)) return;
      await revealItemInDir(opencodeSkills);
    } catch (error) {
      setStateField("skillsStatus", error instanceof Error ? error.message : translate("skills.reveal_failed"));
    }
  }

  async function uninstallSkill(name: string) {
    const root = options.selectedWorkspaceRoot().trim();
    if (!root) {
      setStateField("skillsStatus", translate("skills.pick_workspace_first"));
      return;
    }
    const trimmed = name.trim();
    if (!trimmed) return;

    options.setBusy(true);
    options.setError(null);
    setStateField("skillsStatus", null);
    try {
      await deleteWorkspaceSkill(trimmed);
      setStateField("skillsStatus", translate("skills.uninstalled"));
      options.markReloadRequired?.("skills", { type: "skill", name: trimmed, action: "removed" });
      await refreshSkills({ force: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : translate("skills.unknown_error");
      setStateField("skillsStatus", message);
      options.setError(addOpencodeCacheHint(message));
    } finally {
      options.setBusy(false);
    }
  }

  async function readSkill(name: string): Promise<{ name: string; path: string; content: string } | null> {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const root = options.selectedWorkspaceRoot().trim();
    if (!root) {
      setStateField("skillsStatus", translate("skills.pick_workspace_first"));
      return null;
    }

    const isRemoteWorkspace = options.workspaceType() === "remote";
    const isLocalWorkspace = options.workspaceType() === "local";
    const openworkSnapshot = options.openworkServer.getSnapshot();
    const openworkClient = openworkSnapshot.openworkServerClient;
    const openworkWorkspaceId = options.runtimeWorkspaceId();
    const canUseOpenworkServer =
      openworkSnapshot.openworkServerStatus === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      openworkSnapshot.openworkServerCapabilities?.skills?.read;

    if (canUseOpenworkServer) {
      try {
        setStateField("skillsStatus", null);
        const result = await openworkClient.getSkill(openworkWorkspaceId, trimmed, { includeGlobal: isLocalWorkspace });
        return { name: result.item.name, path: result.item.path, content: result.content };
      } catch (error) {
        setStateField("skillsStatus", error instanceof Error ? error.message : translate("skills.failed_to_load"));
        return null;
      }
    }

    if (isRemoteWorkspace) {
      setStateField("skillsStatus", "OpenWork server unavailable. Connect to view skills.");
      return null;
    }
    if (!isTauriRuntime()) {
      setStateField("skillsStatus", translate("skills.desktop_required"));
      return null;
    }
    if (!isLocalWorkspace) {
      setStateField("skillsStatus", "Local workers are required to view skills.");
      return null;
    }

    try {
      setStateField("skillsStatus", null);
      const result = await readLocalSkill(root, trimmed);
      return { name: trimmed, path: result.path, content: result.content };
    } catch (error) {
      setStateField("skillsStatus", error instanceof Error ? error.message : translate("skills.failed_to_load"));
      return null;
    }
  }

  async function saveSkill(input: { name: string; content: string; description?: string }) {
    const trimmed = input.name.trim();
    if (!trimmed) return;
    const root = options.selectedWorkspaceRoot().trim();
    if (!root) {
      setStateField("skillsStatus", translate("skills.pick_workspace_first"));
      return;
    }

    const isRemoteWorkspace = options.workspaceType() === "remote";
    const isLocalWorkspace = options.workspaceType() === "local";
    const openworkSnapshot = options.openworkServer.getSnapshot();
    const openworkClient = openworkSnapshot.openworkServerClient;
    const openworkWorkspaceId = options.runtimeWorkspaceId();
    const canUseOpenworkServer =
      openworkSnapshot.openworkServerStatus === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      openworkSnapshot.openworkServerCapabilities?.skills?.write;

    if (canUseOpenworkServer) {
      options.setBusy(true);
      options.setError(null);
      setStateField("skillsStatus", null);
      try {
        await openworkClient.upsertSkill(openworkWorkspaceId, {
          name: trimmed,
          content: input.content,
          description: input.description,
        });
        options.markReloadRequired?.("skills", { type: "skill", name: trimmed, action: "updated" });
        await refreshSkills({ force: true });
        setStateField("skillsStatus", "Saved.");
      } catch (error) {
        const message = error instanceof Error ? error.message : translate("skills.unknown_error");
        options.setError(addOpencodeCacheHint(message));
      } finally {
        options.setBusy(false);
      }
      return;
    }

    if (isRemoteWorkspace) {
      setStateField("skillsStatus", "OpenWork server unavailable. Connect to edit skills.");
      return;
    }
    if (!isTauriRuntime()) {
      setStateField("skillsStatus", translate("skills.desktop_required"));
      return;
    }
    if (!isLocalWorkspace) {
      setStateField("skillsStatus", "Local workers are required to edit skills.");
      return;
    }

    options.setBusy(true);
    options.setError(null);
    setStateField("skillsStatus", null);
    try {
      const result = await writeLocalSkill(root, trimmed, input.content);
      if (!result.ok) {
        setStateField("skillsStatus", result.stderr || result.stdout || translate("skills.unknown_error"));
      } else {
        setStateField("skillsStatus", result.stdout || "Saved.");
        options.markReloadRequired?.("skills", { type: "skill", name: trimmed, action: "updated" });
      }
      await refreshSkills({ force: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : translate("skills.unknown_error");
      options.setError(addOpencodeCacheHint(message));
    } finally {
      options.setBusy(false);
    }
  }

  function abortRefreshes() {
    refreshSkillsAborted = true;
    refreshPluginsAborted = true;
    refreshHubSkillsAborted = true;
    refreshCloudOrgSkillsAborted = true;
    refreshCloudOrgSkillHubsAborted = true;
  }

  function ensureSkillsFresh() {
    if (!snapshot.skillsStale) return;
    void refreshSkills({ force: true });
  }

  function ensurePluginsFresh(scopeOverride?: PluginScope) {
    if (!snapshot.pluginsStale) return;
    void refreshPlugins(scopeOverride);
  }

  function ensureHubSkillsFresh() {
    if (!snapshot.hubSkillsStale) return;
    void refreshHubSkills({ force: true });
  }

  function ensureCloudOrgSkillsFresh() {
    if (!snapshot.cloudOrgSkillsStale) return;
    void refreshCloudOrgSkills({ force: true });
  }

  const setHubRepo = (repoInput: Partial<HubSkillRepo> | null, optionsOverride?: { remember?: boolean }) => {
    const next = normalizeHubRepo(repoInput);
    mutateState((current) => ({ ...current, hubRepo: next }));
    hubSkillsLoaded = false;
    if (optionsOverride?.remember === false || !next) {
      persistHubRepos();
      return;
    }
    mutateState((current) => {
      const seen = new Set<string>();
      const merged = [next, ...current.hubRepos];
      const deduped: HubSkillRepo[] = [];
      for (const item of merged) {
        const key = hubRepoKey(item);
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(item);
      }
      return { ...current, hubRepos: deduped };
    });
    persistHubRepos();
  };

  const addHubRepo = (repoInput: Partial<HubSkillRepo>) => {
    const next = normalizeHubRepo(repoInput);
    if (!next) return;
    setHubRepo(next);
  };

  const removeHubRepo = (repoInput: Partial<HubSkillRepo>) => {
    const target = normalizeHubRepo(repoInput);
    if (!target) return;
    const targetKey = hubRepoKey(target);
    const nextRepos = snapshot.hubRepos.filter((item) => hubRepoKey(item) !== targetKey);
    mutateState((current) => ({ ...current, hubRepos: nextRepos }));
    const activeRepo = snapshot.hubRepo;
    if (activeRepo && hubRepoKey(activeRepo) === targetKey) {
      mutateState((current) => ({
        ...current,
        hubRepo: nextRepos[0] ?? null,
        hubSkills: nextRepos.length ? current.hubSkills : [],
        hubSkillsStatus: nextRepos.length ? current.hubSkillsStatus : "No hub repo selected. Add a GitHub repo to browse skills.",
      }));
      hubSkillsLoaded = false;
      if (!nextRepos.length) {
        hubSkillsLoadKey = "";
      }
    }
    persistHubRepos();
  };

  const start = () => {
    if (started || disposed) return;
    started = true;

    if (typeof window !== "undefined") {
      try {
        const raw = window.localStorage.getItem(HUB_REPOS_STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as { selected?: unknown; repos?: unknown[]; custom?: unknown[] };
          const storedRepos = Array.isArray(parsed?.repos)
            ? normalizeHubRepoList(parsed.repos)
            : Array.isArray(parsed?.custom)
              ? normalizeHubRepoList(parsed.custom)
              : [];
          const selected = parsed?.selected && typeof parsed.selected === "object"
            ? normalizeHubRepo(parsed.selected as Partial<HubSkillRepo>)
            : null;
          const selectedKey = selected ? hubRepoKey(selected) : null;
          const hasSelected = selectedKey ? storedRepos.some((item) => hubRepoKey(item) === selectedKey) : false;
          const nextRepos = selected && !hasSelected ? [selected, ...storedRepos] : storedRepos;
          mutateState((current) => ({
            ...current,
            hubRepos: nextRepos.length ? nextRepos : current.hubRepos,
            hubRepo: selected && nextRepos.length ? selected : nextRepos[0] ?? current.hubRepo,
          }));
        }
      } catch {
        // ignore
      }

      const onDenSessionUpdated = () => {
        cloudOrgSkillsLoaded = false;
        cloudOrgSkillHubsLoaded = false;
        mutateState((current) => ({ ...current, cloudOrgSkillsContextKey: "" }));
      };
      window.addEventListener("openwork-den-session-updated", onDenSessionUpdated);
      stopDenSessionListener = () => window.removeEventListener("openwork-den-session-updated", onDenSessionUpdated);
    }

    stopOpenworkSubscription = options.openworkServer.subscribe(() => {
      syncFromOptions();
    });

    syncFromOptions();
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    abortRefreshes();
    stopOpenworkSubscription?.();
    stopOpenworkSubscription = null;
    stopDenSessionListener?.();
    stopDenSessionListener = null;
    listeners.clear();
  };

  const syncFromOptions = () => {
    if (disposed) return;
    const key = getWorkspaceContextKey();
    if (key === lastWorkspaceContextKey) return;
    lastWorkspaceContextKey = key;
    invalidateWorkspaceCaches();
    touch();
    if (!key || key === "::::") return;
    void refreshSkills({ force: true });
    void refreshPlugins();
    void refreshImportedCloudSkills();
    void refreshImportedCloudSkillHubs();
  };

  refreshSnapshot();

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const getSnapshot = () => snapshot;

  return {
    subscribe,
    getSnapshot,
    start,
    dispose,
    syncFromOptions,
    skills: () => snapshot.skills,
    skillsStatus: () => snapshot.skillsStatus,
    hubSkills: () => snapshot.hubSkills,
    hubSkillsStatus: () => snapshot.hubSkillsStatus,
    cloudOrgSkills: () => snapshot.cloudOrgSkills,
    cloudOrgSkillsStatus: () => snapshot.cloudOrgSkillsStatus,
    importedCloudSkills: () => snapshot.importedCloudSkills,
    cloudOrgSkillHubs: () => snapshot.cloudOrgSkillHubs,
    cloudOrgSkillHubsStatus: () => snapshot.cloudOrgSkillHubsStatus,
    importedCloudSkillHubs: () => snapshot.importedCloudSkillHubs,
    hubRepo: () => snapshot.hubRepo,
    hubRepos: () => snapshot.hubRepos,
    get pluginScope() {
      return snapshot.pluginScope;
    },
    setPluginScope(value: SetStateAction<PluginScope>) {
      const resolved = applyStateAction(state.pluginScope, value);
      setStateField("pluginScope", resolved);
    },
    pluginConfig: () => snapshot.pluginConfig,
    pluginConfigPath: () => snapshot.pluginConfigPath,
    pluginList: () => snapshot.pluginList,
    pluginInput: () => snapshot.pluginInput,
    setPluginInput(value: SetStateAction<string>) {
      const resolved = applyStateAction(state.pluginInput, value);
      setStateField("pluginInput", resolved);
    },
    pluginStatus: () => snapshot.pluginStatus,
    activePluginGuide: () => snapshot.activePluginGuide,
    setActivePluginGuide(value: SetStateAction<string | null>) {
      const resolved = applyStateAction(state.activePluginGuide, value);
      setStateField("activePluginGuide", resolved);
    },
    sidebarPluginList: () => snapshot.sidebarPluginList,
    sidebarPluginStatus: () => snapshot.sidebarPluginStatus,
    workspaceContextKey: () => snapshot.workspaceContextKey,
    skillsStale: () => snapshot.skillsStale,
    pluginsStale: () => snapshot.pluginsStale,
    hubSkillsStale: () => snapshot.hubSkillsStale,
    cloudOrgSkillsStale: () => snapshot.cloudOrgSkillsStale,
    isPluginInstalledByName,
    refreshSkills,
    refreshHubSkills,
    refreshCloudOrgSkills,
    refreshCloudOrgSkillHubs,
    setHubRepo,
    addHubRepo,
    removeHubRepo,
    refreshPlugins,
    addPlugin,
    removePlugin,
    importLocalSkill,
    installSkillCreator,
    installHubSkill,
    installCloudOrgSkill,
    syncCloudOrgSkill,
    removeCloudOrgSkill,
    importCloudOrgSkillHub,
    syncCloudOrgSkillHub,
    removeCloudOrgSkillHub,
    revealSkillsFolder,
    uninstallSkill,
    readSkill,
    saveSkill,
    abortRefreshes,
    ensureSkillsFresh,
    ensurePluginsFresh,
    ensureHubSkillsFresh,
    ensureCloudOrgSkillsFresh,
  };
}

export function useExtensionsStoreSnapshot(store: ExtensionsStore) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
