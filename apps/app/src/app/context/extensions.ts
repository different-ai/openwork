import { createEffect, createMemo, createSignal } from "solid-js";

import { applyEdits, modify } from "jsonc-parser";
import { join } from "@tauri-apps/api/path";
import { currentLocale, t } from "../../i18n";

import type { Client, DenOrgSkillCard, HubSkillCard, HubSkillRepo, PluginScope, ReloadReason, ReloadTrigger, SkillCard } from "../types";
import { addOpencodeCacheHint, isTauriRuntime } from "../utils";
import skillCreatorTemplate from "../data/skill-creator.md?raw";
import {
  isPluginInstalled,
  loadPluginsFromConfig as loadPluginsFromConfigHelpers,
  parsePluginListFromContent,
  stripPluginVersion,
} from "../utils/plugins";
import {
  importSkill,
  installSkillTemplate,
  listLocalSkills,
  readLocalSkill,
  uninstallSkill as uninstallSkillCommand,
  writeLocalSkill,
  pickDirectory,
  readOpencodeConfig,
  writeOpencodeConfig,
  workspaceOpenworkRead,
  workspaceOpenworkWrite,
  type OpencodeConfigFile,
} from "../lib/tauri";
import type { OpenworkHubRepo, OpenworkServerClient } from "../lib/openwork-server";
import {
  createDenClient,
  fetchDenOrgSkillsCatalog,
  readDenSettings,
  type DenOrgSkillHub,
} from "../lib/den";
import {
  readWorkspaceCloudImports,
  withWorkspaceCloudImports,
  type CloudImportedSkill,
  type CloudImportedSkillHub,
} from "../cloud/import-state";
import { createWorkspaceContextKey } from "./workspace-context";
import type { OpenworkServerStore } from "../connections/openwork-server-store";


const OPENCODE_SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

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

export type ExtensionsStore = ReturnType<typeof createExtensionsStore>;

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
  // Translation helper that uses current language from i18n
  const translate = (key: string) => t(key, currentLocale());

  // ── Workspace context tracking ──────────────────────
  const workspaceContextKey = createWorkspaceContextKey({
    selectedWorkspaceId: options.selectedWorkspaceId,
    selectedWorkspaceRoot: options.selectedWorkspaceRoot,
    runtimeWorkspaceId: options.runtimeWorkspaceId,
    workspaceType: options.workspaceType,
  });

  // Per-resource staleness: tracks the context key each resource was last loaded for.
  const [skillsContextKey, setSkillsContextKey] = createSignal("");
  const [pluginsContextKey, setPluginsContextKey] = createSignal("");
  const [hubSkillsContextKey, setHubSkillsContextKey] = createSignal("");
  const [cloudOrgSkillsContextKey, setCloudOrgSkillsContextKey] = createSignal("");

  const skillsStale = createMemo(() => skillsContextKey() !== workspaceContextKey());
  const pluginsStale = createMemo(() => pluginsContextKey() !== workspaceContextKey());
  const hubSkillsStale = createMemo(() => hubSkillsContextKey() !== workspaceContextKey());
  const cloudOrgSkillsStale = createMemo(() => {
    const orgId = readDenSettings().activeOrgId?.trim() ?? "";
    return cloudOrgSkillsContextKey() !== `${workspaceContextKey()}::${orgId}`;
  });

  const [skills, setSkills] = createSignal<SkillCard[]>([]);
  const [skillsStatus, setSkillsStatus] = createSignal<string | null>(null);

  const [hubSkills, setHubSkills] = createSignal<HubSkillCard[]>([]);
  const [hubSkillsStatus, setHubSkillsStatus] = createSignal<string | null>(null);

  const [cloudOrgSkills, setCloudOrgSkills] = createSignal<DenOrgSkillCard[]>([]);
  const [cloudOrgSkillsStatus, setCloudOrgSkillsStatus] = createSignal<string | null>(null);
  const [importedCloudSkills, setImportedCloudSkills] = createSignal<Record<string, CloudImportedSkill>>({});

  const [cloudOrgSkillHubs, setCloudOrgSkillHubs] = createSignal<DenOrgSkillHub[]>([]);
  const [cloudOrgSkillHubsStatus, setCloudOrgSkillHubsStatus] = createSignal<string | null>(null);
  const [importedCloudSkillHubs, setImportedCloudSkillHubs] = createSignal<Record<string, CloudImportedSkillHub>>({});

  const formatSkillPath = (location: string) => location.replace(/[/\\]SKILL\.md$/i, "");

  const DEFAULT_HUB_REPO: HubSkillRepo = {
    owner: "different-ai",
    repo: "openwork-hub",
    ref: "main",
  };

  const [hubRepo, setHubRepoSignal] = createSignal<HubSkillRepo | null>(DEFAULT_HUB_REPO);
  const [hubRepos, setHubRepos] = createSignal<HubSkillRepo[]>([DEFAULT_HUB_REPO]);

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

  const [pluginScope, setPluginScope] = createSignal<PluginScope>("project");
  const [pluginConfig, setPluginConfig] = createSignal<OpencodeConfigFile | null>(null);
  const [pluginConfigPath, setPluginConfigPath] = createSignal<string | null>(null);
  const [pluginList, setPluginList] = createSignal<string[]>([]);
  const [pluginInput, setPluginInput] = createSignal("");
  const [pluginStatus, setPluginStatus] = createSignal<string | null>(null);
  const [activePluginGuide, setActivePluginGuide] = createSignal<string | null>(null);

  const [sidebarPluginList, setSidebarPluginList] = createSignal<string[]>([]);
  const [sidebarPluginStatus, setSidebarPluginStatus] = createSignal<string | null>(null);

  // Track in-flight requests to prevent duplicate calls
  let refreshSkillsInFlight = false;
  let refreshPluginsInFlight = false;
  let refreshHubSkillsInFlight = false;
  let refreshSkillsAborted = false;
  let refreshPluginsAborted = false;
  let refreshHubSkillsAborted = false;
  let skillsLoaded = false;
  let hubSkillsLoaded = false;
  let cloudOrgSkillsLoaded = false;
  let cloudOrgSkillHubsLoaded = false;
  let skillsRoot = "";
  let hubSkillsLoadKey = "";
  let cloudOrgSkillsLoadKey = "";
  let cloudOrgSkillHubsLoadKey = "";
  let refreshCloudOrgSkillsInFlight = false;
  let refreshCloudOrgSkillsAborted = false;
  let refreshCloudOrgSkillHubsInFlight = false;
  let refreshCloudOrgSkillHubsAborted = false;

  const HUB_REPOS_STORAGE_KEY = "openwork.skills.hubRepos.v1";

  const readWorkspaceOpenworkConfigRecord = async (): Promise<Record<string, unknown>> => {
    const root = options.selectedWorkspaceRoot().trim();
    const isLocalWorkspace = options.workspaceType() === "local";
    const openworkClient = options.openworkServer.openworkServerClient();
    const openworkWorkspaceId = options.runtimeWorkspaceId();
    const openworkCapabilities = options.openworkServer.openworkServerCapabilities();
    const canUseOpenworkServer =
      options.openworkServer.openworkServerStatus() === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      openworkCapabilities?.config?.read;

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
    const openworkClient = options.openworkServer.openworkServerClient();
    const openworkWorkspaceId = options.runtimeWorkspaceId();
    const openworkCapabilities = options.openworkServer.openworkServerCapabilities();
    const canUseOpenworkServer =
      options.openworkServer.openworkServerStatus() === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      openworkCapabilities?.config?.write;

    if (canUseOpenworkServer) {
      await openworkClient.patchConfig(openworkWorkspaceId, { openwork: config });
      return true;
    }

    if (isLocalWorkspace && isTauriRuntime() && root) {
      const result = await workspaceOpenworkWrite({
        workspacePath: root,
        config: config as any,
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
      setImportedCloudSkillHubs(cloudImports.skillHubs);
      return cloudImports.skillHubs;
    } catch {
      setImportedCloudSkillHubs({});
      return {};
    }
  };

  const refreshImportedCloudSkills = async () => {
    try {
      const config = await readWorkspaceOpenworkConfigRecord();
      const cloudImports = readWorkspaceCloudImports(config);
      setImportedCloudSkills(cloudImports.skills);
      return cloudImports.skills;
    } catch {
      setImportedCloudSkills({});
      return {};
    }
  };

  const persistImportedCloudSkillHubs = async (
    nextSkillHubs: Record<string, CloudImportedSkillHub>,
  ) => {
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
    setImportedCloudSkillHubs(nextSkillHubs);
  };

  const persistImportedCloudSkills = async (
    nextSkills: Record<string, CloudImportedSkill>,
  ) => {
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
    setImportedCloudSkills(nextSkills);
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
    const openworkClient = options.openworkServer.openworkServerClient();
    const openworkWorkspaceId = options.runtimeWorkspaceId();
    const openworkCapabilities = options.openworkServer.openworkServerCapabilities();
    const canUseOpenworkServer =
      options.openworkServer.openworkServerStatus() === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      openworkCapabilities?.skills?.write;

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

  const findImportedCloudSkill = (cloudSkillId: string) => importedCloudSkills()[cloudSkillId] ?? null;

  const persistImportedCloudSkillRecord = async (skill: DenOrgSkillCard, installedName: string) => {
    const imported = findImportedCloudSkill(skill.id);
    const nextSkills = {
      ...importedCloudSkills(),
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

  const applyCloudOrgSkillHubImport = async (
    hub: DenOrgSkillHub,
    imported?: CloudImportedSkillHub | null,
  ) => {
    const importedNameMap = buildImportedSkillNameMap(imported);
    const taken = new Set(skills().map((skill) => skill.name));
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

  const deleteWorkspaceSkill = async (name: string) => {
    const isRemoteWorkspace = options.workspaceType() === "remote";
    const isLocalWorkspace = options.workspaceType() === "local";
    const root = options.selectedWorkspaceRoot().trim();
    const openworkClient = options.openworkServer.openworkServerClient() as
      | (OpenworkServerClient & { deleteSkill?: (workspaceId: string, skillName: string) => Promise<unknown> })
      | null;
    const openworkWorkspaceId = options.runtimeWorkspaceId();
    const openworkCapabilities = options.openworkServer.openworkServerCapabilities();
    const canUseOpenworkServer =
      options.openworkServer.openworkServerStatus() === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      openworkCapabilities?.skills?.write &&
      typeof openworkClient.deleteSkill === "function";

    if (canUseOpenworkServer) {
      await openworkClient.deleteSkill!(openworkWorkspaceId, name);
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

  const persistHubRepos = () => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        HUB_REPOS_STORAGE_KEY,
        JSON.stringify({ selected: hubRepo(), repos: hubRepos() }),
      );
    } catch {
      // ignore
    }
  };

  const setHubRepo = (repoInput: Partial<HubSkillRepo> | null, optionsOverride?: { remember?: boolean }) => {
    const next = normalizeHubRepo(repoInput);
    setHubRepoSignal(next);
    hubSkillsLoaded = false;
    if (optionsOverride?.remember === false || !next) {
      persistHubRepos();
      return;
    }
    setHubRepos((prev) => {
      const seen = new Set<string>();
      const merged = [next, ...prev];
      const deduped: HubSkillRepo[] = [];
      for (const item of merged) {
        const key = hubRepoKey(item);
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(item);
      }
      return deduped;
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
    const nextRepos = hubRepos().filter((item) => hubRepoKey(item) !== targetKey);
    setHubRepos(nextRepos);
    const activeRepo = hubRepo();
    if (activeRepo && hubRepoKey(activeRepo) === targetKey) {
      setHubRepoSignal(nextRepos[0] ?? null);
      hubSkillsLoaded = false;
      if (!nextRepos.length) {
        setHubSkills([]);
        setHubSkillsStatus("No hub repo selected. Add a GitHub repo to browse skills.");
        hubSkillsLoadKey = "";
      }
    }
    persistHubRepos();
  };

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
        const selected =
          parsed?.selected && typeof parsed.selected === "object"
            ? normalizeHubRepo(parsed.selected as Partial<HubSkillRepo>)
            : null;
        const selectedKey = selected ? hubRepoKey(selected) : null;
        const hasSelected = selectedKey ? storedRepos.some((item) => hubRepoKey(item) === selectedKey) : false;
        const nextRepos = selected && !hasSelected ? [selected, ...storedRepos] : storedRepos;
        setHubRepos(nextRepos);
        setHubRepoSignal(selected && nextRepos.length ? selected : nextRepos[0] ?? null);
      }
    } catch {
      // ignore
    }
  }

  async function refreshHubSkills(optionsOverride?: { force?: boolean }) {
    const root = options.selectedWorkspaceRoot().trim();
    const repo = hubRepo();
    const loadKey = `${root}::${repo ? hubRepoKey(repo) : "none"}`;
    const openworkClient = options.openworkServer.openworkServerClient();
    const openworkCapabilities = options.openworkServer.openworkServerCapabilities();
    const canUseOpenworkServer =
      options.openworkServer.openworkServerStatus() === "connected" &&
      openworkClient &&
      openworkCapabilities?.hub?.skills?.read &&
      typeof (openworkClient as any).listHubSkills === "function";

    if (loadKey !== hubSkillsLoadKey) {
      hubSkillsLoaded = false;
    }

    if (!optionsOverride?.force && hubSkillsLoaded) return;
    if (refreshHubSkillsInFlight) return;

    refreshHubSkillsInFlight = true;
    refreshHubSkillsAborted = false;

    try {
      setHubSkillsStatus(null);

      if (!repo) {
        setHubSkills([]);
        setHubSkillsStatus("No hub repo selected. Add a GitHub repo to browse skills.");
        hubSkillsLoaded = true;
        hubSkillsLoadKey = loadKey;
        return;
      }

      if (canUseOpenworkServer) {
        const response = await (openworkClient as any).listHubSkills({
          repo: {
            owner: repo.owner,
            repo: repo.repo,
            ref: repo.ref,
          },
        });
        if (refreshHubSkillsAborted) return;
        const next: HubSkillCard[] = Array.isArray(response?.items)
          ? response.items.map((entry: any) => ({
              name: String(entry.name ?? ""),
              description: typeof entry.description === "string" ? entry.description : undefined,
              trigger: typeof entry.trigger === "string" ? entry.trigger : undefined,
              source: entry.source,
            }))
          : [];
        setHubSkills(next);
        if (!next.length) setHubSkillsStatus("No hub skills found.");
        hubSkillsLoaded = true;
        hubSkillsLoadKey = loadKey;
        setHubSkillsContextKey(workspaceContextKey());
        return;
      }

      // Browser fallback: fetch directly from GitHub (public catalog).
      const listingRes = await fetch(
        `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/contents/skills?ref=${encodeURIComponent(repo.ref)}`,
        {
        headers: { Accept: "application/vnd.github+json" },
        },
      );
      if (!listingRes.ok) {
        throw new Error(`Failed to fetch hub catalog (${listingRes.status})`);
      }
      const listing = (await listingRes.json()) as any;
      const dirs: string[] = Array.isArray(listing)
        ? listing
            .filter((entry) => entry && entry.type === "dir" && typeof entry.name === "string")
            .map((entry) => String(entry.name))
        : [];

      const next: HubSkillCard[] = dirs.map((dirName) => ({
        name: dirName,
        source: { owner: repo.owner, repo: repo.repo, ref: repo.ref, path: `skills/${dirName}` },
      }));

      if (refreshHubSkillsAborted) return;
      const sorted = next.slice().sort((a, b) => a.name.localeCompare(b.name));
      setHubSkills(sorted);
      if (!sorted.length) setHubSkillsStatus("No hub skills found.");
      hubSkillsLoaded = true;
      hubSkillsLoadKey = loadKey;
      setHubSkillsContextKey(workspaceContextKey());
    } catch (e) {
      if (refreshHubSkillsAborted) return;
      setHubSkills([]);
      setHubSkillsStatus(e instanceof Error ? e.message : "Failed to load hub skills.");
    } finally {
      refreshHubSkillsInFlight = false;
    }
  }

  async function refreshCloudOrgSkills(optionsOverride?: { force?: boolean }) {
    const root = options.selectedWorkspaceRoot().trim();
    const wk = workspaceContextKey();
    const settings = readDenSettings();
    const token = settings.authToken?.trim() ?? "";
    const orgId = settings.activeOrgId?.trim() ?? "";
    const loadKey = `${wk}::${orgId}`;

    if (!root) {
      setCloudOrgSkills([]);
      setCloudOrgSkillsStatus(null);
      cloudOrgSkillsLoaded = true;
      cloudOrgSkillsLoadKey = loadKey;
      setCloudOrgSkillsContextKey(loadKey);
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
      setCloudOrgSkillsStatus(null);

      if (!token || !orgId) {
        setCloudOrgSkills([]);
        setCloudOrgSkillsStatus(null);
        cloudOrgSkillsLoaded = true;
        cloudOrgSkillsLoadKey = loadKey;
        setCloudOrgSkillsContextKey(loadKey);
        await refreshImportedCloudSkills();
        return;
      }

      const client = createDenClient({ baseUrl: settings.baseUrl, token });
      const catalog = await fetchDenOrgSkillsCatalog(client, orgId);
      if (refreshCloudOrgSkillsAborted) return;
      setCloudOrgSkills(catalog);
      if (!catalog.length) {
        setCloudOrgSkillsStatus(translate("skills.cloud_org_empty"));
      }
      cloudOrgSkillsLoaded = true;
      cloudOrgSkillsLoadKey = loadKey;
      setCloudOrgSkillsContextKey(loadKey);
      await refreshImportedCloudSkills();
    } catch (e) {
      if (refreshCloudOrgSkillsAborted) return;
      setCloudOrgSkills([]);
      setCloudOrgSkillsStatus(e instanceof Error ? e.message : translate("skills.cloud_org_load_failed"));
    } finally {
      refreshCloudOrgSkillsInFlight = false;
    }
  }

  async function refreshCloudOrgSkillHubs(optionsOverride?: { force?: boolean }) {
    const wk = workspaceContextKey();
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
      setCloudOrgSkillHubsStatus(null);

      if (!token || !orgId) {
        setCloudOrgSkillHubs([]);
        setCloudOrgSkillHubsStatus(null);
        cloudOrgSkillHubsLoaded = true;
        cloudOrgSkillHubsLoadKey = loadKey;
        await refreshImportedCloudSkillHubs();
        return;
      }

      const client = createDenClient({ baseUrl: settings.baseUrl, token });
      const hubs = await client.listOrgSkillHubs(orgId);
      if (refreshCloudOrgSkillHubsAborted) return;
      setCloudOrgSkillHubs(hubs);
      if (!hubs.length) {
        setCloudOrgSkillHubsStatus("No organization skill hubs are available yet.");
      }
      cloudOrgSkillHubsLoaded = true;
      cloudOrgSkillHubsLoadKey = loadKey;
      await refreshImportedCloudSkillHubs();
    } catch (e) {
      if (refreshCloudOrgSkillHubsAborted) return;
      setCloudOrgSkillHubs([]);
      setCloudOrgSkillHubsStatus(
        e instanceof Error ? e.message : "Failed to load organization skill hubs.",
      );
    } finally {
      refreshCloudOrgSkillHubsInFlight = false;
    }
  }

  async function importCloudOrgSkillHub(
    hub: DenOrgSkillHub,
  ): Promise<{ ok: boolean; message: string; importedNames: string[] }> {
    const importedNames: string[] = [];

    options.setBusy(true);
    options.setError(null);
    setSkillsStatus(null);

    try {
      const applied = await applyCloudOrgSkillHubImport(hub, importedCloudSkillHubs()[hub.id]);
      importedNames.push(...applied.nextSkillNames);

      const nextImports = {
        ...importedCloudSkillHubs(),
        [hub.id]: {
          hubId: hub.id,
          name: hub.name,
          skillNames: applied.nextSkillNames,
          skillIds: applied.nextSkillIds,
          importedAt: Date.now(),
        },
      };
      await persistImportedCloudSkillHubs(nextImports);
      options.markReloadRequired?.("skills", {
        type: "skill",
        name: hub.name,
        action: "added",
      });
      await refreshSkills({ force: true });
      await refreshCloudOrgSkills({ force: true });
      await refreshCloudOrgSkillHubs({ force: true });
      return {
        ok: true,
        message: `Imported ${hub.skills.length} skill${hub.skills.length === 1 ? "" : "s"} from ${hub.name}.`,
        importedNames,
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : translate("skills.unknown_error");
      options.setError(addOpencodeCacheHint(message));
      return { ok: false, message, importedNames };
    } finally {
      options.setBusy(false);
    }
  }

  async function syncCloudOrgSkillHub(
    hub: DenOrgSkillHub,
  ): Promise<{ ok: boolean; message: string; importedNames: string[] }> {
    const imported = importedCloudSkillHubs()[hub.id];
    if (!imported) {
      return await importCloudOrgSkillHub(hub);
    }

    options.setBusy(true);
    options.setError(null);
    setSkillsStatus(null);

    try {
      const applied = await applyCloudOrgSkillHubImport(hub, imported);
      const nextImports = {
        ...importedCloudSkillHubs(),
        [hub.id]: {
          hubId: hub.id,
          name: hub.name,
          skillNames: applied.nextSkillNames,
          skillIds: applied.nextSkillIds,
          importedAt: imported.importedAt ?? Date.now(),
        },
      };
      await persistImportedCloudSkillHubs(nextImports);
      options.markReloadRequired?.("skills", {
        type: "skill",
        name: hub.name,
        action: "added",
      });
      await refreshSkills({ force: true });
      await refreshCloudOrgSkills({ force: true });
      await refreshCloudOrgSkillHubs({ force: true });
      return {
        ok: true,
        message: `Synced ${hub.name} from cloud.`,
        importedNames: applied.nextSkillNames,
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : translate("skills.unknown_error");
      options.setError(addOpencodeCacheHint(message));
      return { ok: false, message, importedNames: [] };
    } finally {
      options.setBusy(false);
    }
  }

  async function removeCloudOrgSkillHub(
    hubId: string,
  ): Promise<{ ok: boolean; message: string; removedNames: string[] }> {
    const imported = importedCloudSkillHubs()[hubId];
    if (!imported) {
      return { ok: false, message: "This skill hub has not been imported into the workspace.", removedNames: [] };
    }

    options.setBusy(true);
    options.setError(null);
    setSkillsStatus(null);

    try {
      for (const name of imported.skillNames) {
        await deleteWorkspaceSkill(name);
        options.markReloadRequired?.("skills", {
          type: "skill",
          name,
          action: "removed",
        });
      }

      const nextImports = { ...importedCloudSkillHubs() };
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
    } catch (e) {
      const message = e instanceof Error ? e.message : translate("skills.unknown_error");
      options.setError(addOpencodeCacheHint(message));
      return { ok: false, message, removedNames: [] };
    } finally {
      options.setBusy(false);
    }
  }

  async function installHubSkill(name: string): Promise<{ ok: boolean; message: string }> {
    const trimmed = name.trim();
    if (!trimmed) return { ok: false, message: "Skill name is required." };
    const repo = hubRepo();
    if (!repo) {
      return { ok: false, message: "Select a hub repo before installing skills." };
    }

    const isRemoteWorkspace = options.workspaceType() === "remote";
    const openworkClient = options.openworkServer.openworkServerClient();
    const openworkWorkspaceId = options.runtimeWorkspaceId();
    const openworkCapabilities = options.openworkServer.openworkServerCapabilities();
    const canUseOpenworkServer =
      options.openworkServer.openworkServerStatus() === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      openworkCapabilities?.hub?.skills?.install &&
      typeof (openworkClient as any).installHubSkill === "function";

    if (!canUseOpenworkServer) {
      if (isRemoteWorkspace) {
        return { ok: false, message: "OpenWork server unavailable. Connect to install skills." };
      }
      return { ok: false, message: "Hub install requires OpenWork server." };
    }

    options.setBusy(true);
    options.setError(null);
    setSkillsStatus(null);

    try {
      const repoOverride: OpenworkHubRepo = {
        owner: repo.owner,
        repo: repo.repo,
        ref: repo.ref,
      };
      const result = await (openworkClient as any).installHubSkill(openworkWorkspaceId, trimmed, {
        repo: repoOverride,
      });
      await refreshSkills({ force: true });
      await refreshHubSkills({ force: true });
      if (!result?.ok) {
        return { ok: false, message: "Install failed." };
      }
      return { ok: true, message: `Installed ${trimmed}.` };
    } catch (e) {
      const message = e instanceof Error ? e.message : translate("skills.unknown_error");
      options.setError(addOpencodeCacheHint(message));
      return { ok: false, message };
    } finally {
      options.setBusy(false);
    }
  }

  async function installCloudOrgSkill(skill: DenOrgSkillCard): Promise<{ ok: boolean; message: string }> {
    const existingImport = findImportedCloudSkill(skill.id);
    const installedNames = new Set(skills().map((s) => s.name));
    const preferredName = existingImport?.installedName?.trim() ?? "";
    if (preferredName) {
      installedNames.delete(preferredName);
    }
    const base = slugifyOpencodeSkillName(skill.title);
    const installName = preferredName || uniqueSkillInstallName(base, installedNames, skill.id);
    const rawDesc = (skill.description?.trim() || skill.title).trim();
    const description = rawDesc.slice(0, 1024) || skill.title.slice(0, 1024) || "Skill";
    const body = extractSkillBodyMarkdown(skill.skillText);
    const content = buildCloudSkillContent(installName, description, body);
    const action = existingImport ? "updated" : "added";

    options.setBusy(true);
    options.setError(null);
    setSkillsStatus(null);

    try {
      await upsertWorkspaceSkill(installName, content, description, { overwrite: Boolean(existingImport) });
      await persistImportedCloudSkillRecord(skill, installName);
      options.markReloadRequired?.("skills", {
        type: "skill",
        name: installName,
        action,
      });
      await refreshSkills({ force: true });
      await refreshCloudOrgSkills({ force: true });
      return {
        ok: true,
        message: t(
          existingImport ? "skills.cloud_updated" : "skills.cloud_installed",
          currentLocale(),
          { name: installName },
        ),
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : translate("skills.unknown_error");
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
    setSkillsStatus(null);

    try {
      if (skills().some((skill) => skill.name === imported.installedName)) {
        await deleteWorkspaceSkill(imported.installedName);
      }
      const nextImports = { ...importedCloudSkills() };
      delete nextImports[cloudSkillId];
      await persistImportedCloudSkills(nextImports);
      options.markReloadRequired?.("skills", {
        type: "skill",
        name: imported.installedName,
        action: "removed",
      });
      await refreshSkills({ force: true });
      await refreshCloudOrgSkills({ force: true });
      return {
        ok: true,
        message: t("skills.cloud_removed", currentLocale(), { name: imported.installedName }),
        removedName: imported.installedName,
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : translate("skills.unknown_error");
      options.setError(addOpencodeCacheHint(message));
      return { ok: false, message, removedName: null };
    } finally {
      options.setBusy(false);
    }
  }

  const isPluginInstalledByName = (pluginName: string, aliases: string[] = []) =>
    isPluginInstalled(pluginList(), pluginName, aliases);

  const loadPluginsFromConfig = (config: OpencodeConfigFile | null) => {
    loadPluginsFromConfigHelpers(config, setPluginList, (message) => setPluginStatus(message));
  };

  async function refreshSkills(optionsOverride?: { force?: boolean }) {
    const root = options.selectedWorkspaceRoot().trim();
    const isRemoteWorkspace = options.workspaceType() === "remote";
    const isLocalWorkspace = options.workspaceType() === "local";
    const openworkClient = options.openworkServer.openworkServerClient();
    const openworkWorkspaceId = options.runtimeWorkspaceId();
    const openworkCapabilities = options.openworkServer.openworkServerCapabilities();
    const canUseOpenworkServer =
      options.openworkServer.openworkServerStatus() === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      openworkCapabilities?.skills?.read;

    if (!root) {
      setSkills([]);
      setSkillsStatus(translate("skills.pick_workspace_first"));
      return;
    }

    // Prefer OpenWork server when available
    if (canUseOpenworkServer) {
      if (root !== skillsRoot) {
        skillsLoaded = false;
      }

      if (!optionsOverride?.force && skillsLoaded) {
        return;
      }

      if (refreshSkillsInFlight) {
        return;
      }

      refreshSkillsInFlight = true;
      refreshSkillsAborted = false;

      try {
        setSkillsStatus(null);
        const response = await openworkClient.listSkills(openworkWorkspaceId, {
          includeGlobal: isLocalWorkspace,
        });
        if (refreshSkillsAborted) return;
        const next: SkillCard[] = Array.isArray(response.items)
          ? response.items.map((entry) => ({
              name: entry.name,
              description: entry.description,
              path: entry.path,
              trigger: entry.trigger,
            }))
          : [];
        setSkills(next);
        if (!next.length) {
          setSkillsStatus(translate("skills.no_skills_found"));
        }
        skillsLoaded = true;
        skillsRoot = root;
        setSkillsContextKey(workspaceContextKey());
      } catch (e) {
        if (refreshSkillsAborted) return;
        setSkills([]);
        setSkillsStatus(e instanceof Error ? e.message : translate("skills.failed_to_load"));
      } finally {
        refreshSkillsInFlight = false;
      }

      return;
    }

    // Host/Tauri mode fallback: read directly from `.opencode/skills` or `.claude/skills`
    // so the UI still works even if the OpenCode engine is stopped or unreachable.
    if (isLocalWorkspace && isTauriRuntime()) {
      if (root !== skillsRoot) {
        skillsLoaded = false;
      }

      if (!optionsOverride?.force && skillsLoaded) {
        return;
      }

      if (refreshSkillsInFlight) {
        return;
      }

      refreshSkillsInFlight = true;
      refreshSkillsAborted = false;

      try {
        setSkillsStatus(null);
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

        setSkills(next);
        if (!next.length) {
          setSkillsStatus(translate("skills.no_skills_found"));
        }
        skillsLoaded = true;
        skillsRoot = root;
        setSkillsContextKey(workspaceContextKey());
      } catch (e) {
        if (refreshSkillsAborted) return;
        setSkills([]);
        setSkillsStatus(e instanceof Error ? e.message : translate("skills.failed_to_load"));
      } finally {
        refreshSkillsInFlight = false;
      }

      return;
    }

    const c = options.client();
    if (!c) {
      setSkills([]);
      setSkillsStatus("OpenWork server unavailable. Connect to load skills.");
      return;
    }

    if (root !== skillsRoot) {
      skillsLoaded = false;
    }

    if (!optionsOverride?.force && skillsLoaded) {
      return;
    }

    if (refreshSkillsInFlight) {
      return;
    }

    refreshSkillsInFlight = true;
    refreshSkillsAborted = false;

    try {
      setSkillsStatus(null);

      if (refreshSkillsAborted) return;

      const rawClient = c as unknown as { _client?: { get: (input: { url: string }) => Promise<any> } };
      if (!rawClient._client) {
        throw new Error("OpenCode client unavailable.");
      }

      const result = await rawClient._client.get({ url: "/skill" });
      if (result?.data === undefined) {
        const err = result?.error;
        const message =
          err instanceof Error ? err.message : typeof err === "string" ? err : translate("skills.failed_to_load");
        throw new Error(message);
      }
      const data = result.data as Array<{
        name: string;
        description: string;
        location: string;
      }>;

      if (refreshSkillsAborted) return;

      const next: SkillCard[] = Array.isArray(data)
        ? data.map((entry) => ({
            name: entry.name,
            description: entry.description,
            path: formatSkillPath(entry.location),
          }))
        : [];

      setSkills(next);
      if (!next.length) {
        setSkillsStatus(translate("skills.no_skills_found"));
      }
      skillsLoaded = true;
      skillsRoot = root;
      setSkillsContextKey(workspaceContextKey());
    } catch (e) {
      if (refreshSkillsAborted) return;
      setSkills([]);
      setSkillsStatus(e instanceof Error ? e.message : translate("skills.failed_to_load"));
    } finally {
      refreshSkillsInFlight = false;
    }
  }

  async function refreshPlugins(scopeOverride?: PluginScope) {
    const isRemoteWorkspace = options.workspaceType() === "remote";
    const isLocalWorkspace = options.workspaceType() === "local";
    const openworkClient = options.openworkServer.openworkServerClient();
    const openworkWorkspaceId = options.runtimeWorkspaceId();
    const openworkCapabilities = options.openworkServer.openworkServerCapabilities();
    const canUseOpenworkServer =
      options.openworkServer.openworkServerStatus() === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      openworkCapabilities?.plugins?.read;

    // Skip if already in flight
    if (refreshPluginsInFlight) {
      return;
    }

    refreshPluginsInFlight = true;
    refreshPluginsAborted = false;

    const scope = scopeOverride ?? pluginScope();
    const targetDir = options.projectDir().trim();

    if (scope !== "project" && !isLocalWorkspace) {
      setPluginStatus("Global plugins are only available for local workers.");
      setPluginList([]);
      setSidebarPluginStatus("Global plugins require a local worker.");
      setSidebarPluginList([]);
      refreshPluginsInFlight = false;
      return;
    }

    if (scope === "project" && canUseOpenworkServer) {
      setPluginConfig(null);
      setPluginConfigPath(`opencode.json (${isRemoteWorkspace ? "remote" : "openwork"} server)`);

      try {
        setPluginStatus(null);
        setSidebarPluginStatus(null);

        if (refreshPluginsAborted) return;

        const result = await openworkClient.listPlugins(openworkWorkspaceId, { includeGlobal: false });
        if (refreshPluginsAborted) return;

        const configItems = result.items.filter((item) => item.source === "config" && item.scope === "project");
        const list = configItems.map((item) => item.spec);
        setPluginList(list);
        setSidebarPluginList(list);
        setPluginsContextKey(workspaceContextKey());

        if (!list.length) {
          setPluginStatus("No plugins configured yet.");
        }
      } catch (e) {
        if (refreshPluginsAborted) return;
        setPluginList([]);
        setSidebarPluginStatus("Failed to load plugins.");
        setSidebarPluginList([]);
        setPluginStatus(e instanceof Error ? e.message : "Failed to load plugins.");
      } finally {
        refreshPluginsInFlight = false;
      }

      return;
    }

    if (!isTauriRuntime()) {
      setPluginStatus(translate("skills.plugin_management_host_only"));
      setPluginList([]);
      setSidebarPluginStatus(translate("skills.plugins_host_only"));
      setSidebarPluginList([]);
      refreshPluginsInFlight = false;
      return;
    }

    if (!isLocalWorkspace && !canUseOpenworkServer) {
      setPluginStatus("OpenWork server unavailable. Connect to manage plugins.");
      setPluginList([]);
      setSidebarPluginStatus("Connect an OpenWork server to load plugins.");
      setSidebarPluginList([]);
      refreshPluginsInFlight = false;
      return;
    }

    if (scope === "project" && !targetDir) {
      setPluginStatus(translate("skills.pick_project_for_plugins"));
      setPluginList([]);
      setSidebarPluginStatus(translate("skills.pick_project_for_active"));
      setSidebarPluginList([]);
      refreshPluginsInFlight = false;
      return;
    }

    try {
      setPluginStatus(null);
      setSidebarPluginStatus(null);

      if (refreshPluginsAborted) return;

      const config = await readOpencodeConfig(scope, targetDir);

      if (refreshPluginsAborted) return;

      setPluginConfig(config);
      setPluginConfigPath(config.path ?? null);

      if (!config.exists) {
        setPluginList([]);
        setPluginStatus(translate("skills.no_opencode_found"));
        setSidebarPluginList([]);
        setSidebarPluginStatus(translate("skills.no_opencode_workspace"));
        return;
      }

      try {
        const next = parsePluginListFromContent(config.content ?? "");
        setSidebarPluginList(next);
      } catch {
        setSidebarPluginList([]);
        setSidebarPluginStatus(translate("skills.failed_parse_opencode"));
      }

      loadPluginsFromConfig(config);
      setPluginsContextKey(workspaceContextKey());
    } catch (e) {
      if (refreshPluginsAborted) return;
      setPluginConfig(null);
      setPluginConfigPath(null);
      setPluginList([]);
      setPluginStatus(e instanceof Error ? e.message : translate("skills.failed_load_opencode"));
      setSidebarPluginStatus(translate("skills.failed_load_active"));
      setSidebarPluginList([]);
    } finally {
      refreshPluginsInFlight = false;
    }
  }

  async function addPlugin(pluginNameOverride?: string) {
    const pluginName = (pluginNameOverride ?? pluginInput()).trim();
    const isManualInput = pluginNameOverride == null;
    const triggerName = stripPluginVersion(pluginName);

    const isRemoteWorkspace = options.workspaceType() === "remote";
    const isLocalWorkspace = options.workspaceType() === "local";
    const openworkClient = options.openworkServer.openworkServerClient();
    const openworkWorkspaceId = options.runtimeWorkspaceId();
    const openworkCapabilities = options.openworkServer.openworkServerCapabilities();
    const canUseOpenworkServer =
      options.openworkServer.openworkServerStatus() === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      openworkCapabilities?.plugins?.write;

    if (!pluginName) {
      if (isManualInput) {
        setPluginStatus(translate("skills.enter_plugin_name"));
      }
      return;
    }

    if (pluginScope() !== "project" && !isLocalWorkspace) {
      setPluginStatus("Global plugins are only available for local workers.");
      return;
    }

    if (pluginScope() === "project" && canUseOpenworkServer) {
      try {
        setPluginStatus(null);
        await openworkClient.addPlugin(openworkWorkspaceId, pluginName);
        options.markReloadRequired?.("plugins", { type: "plugin", name: triggerName, action: "added" });
        if (isManualInput) {
          setPluginInput("");
        }
        await refreshPlugins("project");
      } catch (e) {
        setPluginStatus(e instanceof Error ? e.message : "Failed to add plugin.");
      }
      return;
    }

    if (!isTauriRuntime()) {
      setPluginStatus(translate("skills.plugin_management_host_only"));
      return;
    }

    if (!isLocalWorkspace && !canUseOpenworkServer) {
      setPluginStatus("OpenWork server unavailable. Connect to manage plugins.");
      return;
    }

    const scope = pluginScope();
    const targetDir = options.projectDir().trim();

    if (scope === "project" && !targetDir) {
      setPluginStatus(translate("skills.pick_project_for_plugins"));
      return;
    }

    try {
      setPluginStatus(null);
      const config = await readOpencodeConfig(scope, targetDir);
      const raw = config.content ?? "";

      if (!raw.trim()) {
        const payload = {
          $schema: "https://opencode.ai/config.json",
          plugin: [pluginName],
        };
        await writeOpencodeConfig(scope, targetDir, `${JSON.stringify(payload, null, 2)}\n`);
        options.markReloadRequired?.("plugins", { type: "plugin", name: triggerName, action: "added" });
        if (isManualInput) {
          setPluginInput("");
        }
        await refreshPlugins(scope);
        return;
      }

      const plugins = parsePluginListFromContent(raw);

      const desired = stripPluginVersion(pluginName).toLowerCase();
      if (plugins.some((entry) => stripPluginVersion(entry).toLowerCase() === desired)) {
        setPluginStatus(translate("skills.plugin_already_listed"));
        return;
      }

      const next = [...plugins, pluginName];
      const edits = modify(raw, ["plugin"], next, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      });
      const updated = applyEdits(raw, edits);

      await writeOpencodeConfig(scope, targetDir, updated);
      options.markReloadRequired?.("plugins", { type: "plugin", name: triggerName, action: "added" });
      if (isManualInput) {
        setPluginInput("");
      }
      await refreshPlugins(scope);
    } catch (e) {
      setPluginStatus(e instanceof Error ? e.message : translate("skills.failed_update_opencode"));
    }
  }

  async function removePlugin(pluginName: string) {
    const name = pluginName.trim();
    if (!name) return;
    const triggerName = stripPluginVersion(name);

    const isRemoteWorkspace = options.workspaceType() === "remote";
    const isLocalWorkspace = options.workspaceType() === "local";
    const openworkClient = options.openworkServer.openworkServerClient();
    const openworkWorkspaceId = options.runtimeWorkspaceId();
    const openworkCapabilities = options.openworkServer.openworkServerCapabilities();
    const canUseOpenworkServer =
      options.openworkServer.openworkServerStatus() === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      openworkCapabilities?.plugins?.write;

    if (pluginScope() !== "project" && !isLocalWorkspace) {
      setPluginStatus("Global plugins are only available for local workers.");
      return;
    }

    if (pluginScope() === "project" && canUseOpenworkServer) {
      try {
        setPluginStatus(null);
        await openworkClient.removePlugin(openworkWorkspaceId, name);
        options.markReloadRequired?.("plugins", { type: "plugin", name: triggerName, action: "removed" });
        await refreshPlugins("project");
      } catch (e) {
        setPluginStatus(e instanceof Error ? e.message : "Failed to remove plugin.");
      }
      return;
    }

    if (!isTauriRuntime()) {
      setPluginStatus(translate("skills.plugin_management_host_only"));
      return;
    }

    if (!isLocalWorkspace && !canUseOpenworkServer) {
      setPluginStatus("OpenWork server unavailable. Connect to manage plugins.");
      return;
    }

    const scope = pluginScope();
    const targetDir = options.projectDir().trim();

    if (scope === "project" && !targetDir) {
      setPluginStatus(translate("skills.pick_project_for_plugins"));
      return;
    }

    try {
      setPluginStatus(null);
      const config = await readOpencodeConfig(scope, targetDir);
      const raw = config.content ?? "";
      if (!raw.trim()) {
        setPluginStatus("No plugins configured yet.");
        return;
      }

      const plugins = parsePluginListFromContent(raw);
      const desired = stripPluginVersion(name).toLowerCase();
      const next = plugins.filter((entry) => stripPluginVersion(entry).toLowerCase() !== desired);
      if (next.length === plugins.length) {
        setPluginStatus("Plugin not found.");
        return;
      }

      const edits = modify(raw, ["plugin"], next, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      });
      const updated = applyEdits(raw, edits);
      await writeOpencodeConfig(scope, targetDir, updated);
      options.markReloadRequired?.("plugins", { type: "plugin", name: triggerName, action: "removed" });
      await refreshPlugins(scope);
    } catch (e) {
      setPluginStatus(e instanceof Error ? e.message : translate("skills.failed_update_opencode"));
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
    setSkillsStatus(null);

    try {
      const selection = await pickDirectory({ title: translate("skills.select_skill_folder") });
      const sourceDir = typeof selection === "string" ? selection : Array.isArray(selection) ? selection[0] : null;

      if (!sourceDir) {
        return;
      }

      const inferredName = sourceDir.split(/[\\/]/).filter(Boolean).pop();
      const result = await importSkill(targetDir, sourceDir, { overwrite: false });
      if (!result.ok) {
        setSkillsStatus(result.stderr || result.stdout || translate("skills.import_failed").replace("{status}", String(result.status)));
      } else {
        setSkillsStatus(result.stdout || translate("skills.imported"));
        options.markReloadRequired?.("skills", {
          type: "skill",
          name: inferredName,
          action: "added",
        });
      }

      await refreshSkills({ force: true });
    } catch (e) {
      const message = e instanceof Error ? e.message : translate("skills.unknown_error");
      options.setError(addOpencodeCacheHint(message));
    } finally {
      options.setBusy(false);
    }
  }

  async function installSkillCreator(): Promise<{ ok: boolean; message: string }> {
    const isRemoteWorkspace = options.workspaceType() === "remote";
    const isLocalWorkspace = options.workspaceType() === "local";
    const openworkClient = options.openworkServer.openworkServerClient();
    const openworkWorkspaceId = options.runtimeWorkspaceId();
    const openworkCapabilities = options.openworkServer.openworkServerCapabilities();
    const canUseOpenworkServer =
      options.openworkServer.openworkServerStatus() === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      openworkCapabilities?.skills?.write;

    // Use OpenWork server when available
    if (canUseOpenworkServer) {
      options.setBusy(true);
      options.setError(null);
      setSkillsStatus(translate("skills.installing_skill_creator"));

      try {
        await openworkClient.upsertSkill(openworkWorkspaceId, {
          name: "skill-creator",
          content: skillCreatorTemplate,
        });
        const message = translate("skills.skill_creator_installed");
        setSkillsStatus(message);
        options.markReloadRequired?.("skills", { type: "skill", name: "skill-creator", action: "added" });
        await refreshSkills({ force: true });
        return { ok: true, message };
      } catch (e) {
        const raw = e instanceof Error ? e.message : translate("skills.unknown_error");
        const message = addOpencodeCacheHint(raw);
        // Ensure we show feedback on the Skills page (not just the global error banner).
        setSkillsStatus(message);
        options.setError(message);
        return { ok: false, message };
      } finally {
        options.setBusy(false);
      }
    }

    // Remote workspace without server
    if (isRemoteWorkspace) {
      const message = "OpenWork server unavailable. Connect to install skills.";
      setSkillsStatus(message);
      return { ok: false, message };
    }

    if (!isTauriRuntime()) {
      const message = translate("skills.desktop_required");
      setSkillsStatus(message);
      return { ok: false, message };
    }

    if (!isLocalWorkspace) {
      const message = "Local workers are required to install skills.";
      options.setError(message);
      setSkillsStatus(message);
      return { ok: false, message };
    }

    const targetDir = options.selectedWorkspaceRoot().trim();
    if (!targetDir) {
      const message = translate("skills.pick_workspace_first");
      setSkillsStatus(message);
      return { ok: false, message };
    }

    options.setBusy(true);
    options.setError(null);
    setSkillsStatus(translate("skills.installing_skill_creator"));

    try {
      const result = await installSkillTemplate(targetDir, "skill-creator", skillCreatorTemplate, { overwrite: false });

      if (!result.ok && /already exists/i.test(result.stderr)) {
        const message = translate("skills.skill_creator_already_installed");
        setSkillsStatus(message);
        await refreshSkills({ force: true });
        return { ok: true, message };
      } else if (!result.ok) {
        const message = result.stderr || result.stdout || translate("skills.install_failed");
        setSkillsStatus(message);
        await refreshSkills({ force: true });
        return { ok: false, message };
      } else {
        const message = result.stdout || translate("skills.skill_creator_installed");
        setSkillsStatus(message);
        options.markReloadRequired?.("skills", { type: "skill", name: "skill-creator", action: "added" });
        await refreshSkills({ force: true });
        return { ok: true, message };
      }
    } catch (e) {
      const raw = e instanceof Error ? e.message : translate("skills.unknown_error");
      const message = addOpencodeCacheHint(raw);
      setSkillsStatus(message);
      options.setError(message);
      return { ok: false, message };
    } finally {
      options.setBusy(false);
    }

    // Should be unreachable, but keep TS happy.
    return { ok: false, message: translate("skills.install_failed") };
  }

  async function revealSkillsFolder() {
    if (!isTauriRuntime()) {
      setSkillsStatus(translate("skills.desktop_required"));
      return;
    }

    const root = options.selectedWorkspaceRoot().trim();
    if (!root) {
      setSkillsStatus(translate("skills.pick_workspace_first"));
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

      // Prefer opening the folder. `revealItemInDir` expects a file path on macOS.
      if (await tryOpen(opencodeSkills)) return;
      if (await tryOpen(claudeSkills)) return;
      if (await tryOpen(legacySkills)) return;
      await revealItemInDir(opencodeSkills);
    } catch (e) {
      setSkillsStatus(e instanceof Error ? e.message : translate("skills.reveal_failed"));
    }
  }

  async function uninstallSkill(name: string) {
    const root = options.selectedWorkspaceRoot().trim();
    if (!root) {
      setSkillsStatus(translate("skills.pick_workspace_first"));
      return;
    }

    const trimmed = name.trim();
    if (!trimmed) {
      return;
    }

    options.setBusy(true);
    options.setError(null);
    setSkillsStatus(null);

    try {
      await deleteWorkspaceSkill(trimmed);
      setSkillsStatus(translate("skills.uninstalled"));
      options.markReloadRequired?.("skills", { type: "skill", name: trimmed, action: "removed" });
      await refreshSkills({ force: true });
    } catch (e) {
      const message = e instanceof Error ? e.message : translate("skills.unknown_error");
      setSkillsStatus(message);
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
      setSkillsStatus(translate("skills.pick_workspace_first"));
      return null;
    }

    const isRemoteWorkspace = options.workspaceType() === "remote";
    const isLocalWorkspace = options.workspaceType() === "local";
    const openworkClient = options.openworkServer.openworkServerClient();
    const openworkWorkspaceId = options.runtimeWorkspaceId();
    const openworkCapabilities = options.openworkServer.openworkServerCapabilities();
    const canUseOpenworkServer =
      options.openworkServer.openworkServerStatus() === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      openworkCapabilities?.skills?.read &&
      typeof (openworkClient as any).getSkill === "function";

    if (canUseOpenworkServer) {
      try {
        setSkillsStatus(null);
        const result = await (openworkClient as OpenworkServerClient & { getSkill: any }).getSkill(
          openworkWorkspaceId,
          trimmed,
          { includeGlobal: isLocalWorkspace },
        );
        return {
          name: result.item.name,
          path: result.item.path,
          content: result.content,
        };
      } catch (e) {
        setSkillsStatus(e instanceof Error ? e.message : translate("skills.failed_to_load"));
        return null;
      }
    }

    if (isRemoteWorkspace) {
      setSkillsStatus("OpenWork server unavailable. Connect to view skills.");
      return null;
    }

    if (!isTauriRuntime()) {
      setSkillsStatus(translate("skills.desktop_required"));
      return null;
    }

    if (!isLocalWorkspace) {
      setSkillsStatus("Local workers are required to view skills.");
      return null;
    }

    try {
      setSkillsStatus(null);
      const result = await readLocalSkill(root, trimmed);
      return { name: trimmed, path: result.path, content: result.content };
    } catch (e) {
      setSkillsStatus(e instanceof Error ? e.message : translate("skills.failed_to_load"));
      return null;
    }
  }

  async function saveSkill(input: { name: string; content: string; description?: string }) {
    const trimmed = input.name.trim();
    if (!trimmed) return;

    const root = options.selectedWorkspaceRoot().trim();
    if (!root) {
      setSkillsStatus(translate("skills.pick_workspace_first"));
      return;
    }

    const isRemoteWorkspace = options.workspaceType() === "remote";
    const isLocalWorkspace = options.workspaceType() === "local";
    const openworkClient = options.openworkServer.openworkServerClient();
    const openworkWorkspaceId = options.runtimeWorkspaceId();
    const openworkCapabilities = options.openworkServer.openworkServerCapabilities();
    const canUseOpenworkServer =
      options.openworkServer.openworkServerStatus() === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      openworkCapabilities?.skills?.write;

    if (canUseOpenworkServer) {
      options.setBusy(true);
      options.setError(null);
      setSkillsStatus(null);
      try {
        await openworkClient.upsertSkill(openworkWorkspaceId, {
          name: trimmed,
          content: input.content,
          description: input.description,
        });
        options.markReloadRequired?.("skills", { type: "skill", name: trimmed, action: "updated" });
        await refreshSkills({ force: true });
        setSkillsStatus("Saved.");
      } catch (e) {
        const message = e instanceof Error ? e.message : translate("skills.unknown_error");
        options.setError(addOpencodeCacheHint(message));
      } finally {
        options.setBusy(false);
      }
      return;
    }

    if (isRemoteWorkspace) {
      setSkillsStatus("OpenWork server unavailable. Connect to edit skills.");
      return;
    }

    if (!isTauriRuntime()) {
      setSkillsStatus(translate("skills.desktop_required"));
      return;
    }

    if (!isLocalWorkspace) {
      setSkillsStatus("Local workers are required to edit skills.");
      return;
    }

    options.setBusy(true);
    options.setError(null);
    setSkillsStatus(null);
    try {
      const result = await writeLocalSkill(root, trimmed, input.content);
      if (!result.ok) {
        setSkillsStatus(result.stderr || result.stdout || translate("skills.unknown_error"));
      } else {
        setSkillsStatus(result.stdout || "Saved.");
        options.markReloadRequired?.("skills", { type: "skill", name: trimmed, action: "updated" });
      }
      await refreshSkills({ force: true });
    } catch (e) {
      const message = e instanceof Error ? e.message : translate("skills.unknown_error");
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
  }

  /**
   * Ensure skills are fresh for the current workspace context.
   * Call this from any visible surface that needs skills data.
   * It will only fetch if data is stale or missing.
   */
  function ensureSkillsFresh() {
    if (!skillsStale()) return;
    void refreshSkills({ force: true });
  }

  /**
   * Ensure plugins are fresh for the current workspace context.
   */
  function ensurePluginsFresh(scopeOverride?: PluginScope) {
    if (!pluginsStale()) return;
    void refreshPlugins(scopeOverride);
  }

  /**
   * Ensure hub skills are fresh for the current workspace context.
   */
  function ensureHubSkillsFresh() {
    if (!hubSkillsStale()) return;
    void refreshHubSkills({ force: true });
  }

  function ensureCloudOrgSkillsFresh() {
    if (!cloudOrgSkillsStale()) return;
    void refreshCloudOrgSkills({ force: true });
  }

  // When workspace context changes, invalidate caches and refresh core
  // resources (skills + plugins) that are visible across many surfaces
  // (sidebar context panel, session view, dashboard panels).
  // Hub skills are deferred — only refreshed when the skills panel opens.
  //
  // Placed after all function definitions to avoid uninitialized variable
  // references (ES module strict mode does not hoist function declarations
  // past their lexical position during the initial synchronous pass).
  createEffect(() => {
    const key = workspaceContextKey();
    // Reset in-memory cache flags so the next refresh actually fetches.
    skillsLoaded = false;
    hubSkillsLoaded = false;
    cloudOrgSkillsLoaded = false;
    cloudOrgSkillHubsLoaded = false;
    skillsRoot = "";
    hubSkillsLoadKey = "";
    cloudOrgSkillsLoadKey = "";
    cloudOrgSkillHubsLoadKey = "";

    // Skip the very first run (empty key = no workspace selected yet).
    if (!key || key === "::::") return;

    // Refresh core resources that are needed across many surfaces.
    void refreshSkills({ force: true });
    void refreshPlugins();
    void refreshImportedCloudSkills();
    void refreshImportedCloudSkillHubs();
  });

  if (typeof window !== "undefined") {
    window.addEventListener("openwork-den-session-updated", () => {
      cloudOrgSkillsLoaded = false;
      cloudOrgSkillHubsLoaded = false;
      setCloudOrgSkillsContextKey("");
    });
  }

  return {
    skills,
    skillsStatus,
    hubSkills,
    hubSkillsStatus,
    cloudOrgSkills,
    cloudOrgSkillsStatus,
    importedCloudSkills,
    cloudOrgSkillHubs,
    cloudOrgSkillHubsStatus,
    importedCloudSkillHubs,
    hubRepo,
    hubRepos,
    pluginScope,
    setPluginScope,
    pluginConfig,
    pluginConfigPath,
    pluginList,
    pluginInput,
    setPluginInput,
    pluginStatus,
    activePluginGuide,
    setActivePluginGuide,
    sidebarPluginList,
    sidebarPluginStatus,
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
    // Freshness model
    workspaceContextKey,
    skillsStale,
    pluginsStale,
    hubSkillsStale,
    cloudOrgSkillsStale,
    ensureSkillsFresh,
    ensurePluginsFresh,
    ensureHubSkillsFresh,
    ensureCloudOrgSkillsFresh,
  };
}
