import { createSignal } from "solid-js";

import { applyEdits, modify } from "jsonc-parser";
import { join } from "@tauri-apps/api/path";
import { currentLocale, t } from "../../i18n";

import type { Client, HubSkillCard, PluginScope, ReloadReason, ReloadTrigger, SkillCard } from "../types";
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
  type OpencodeConfigFile,
} from "../lib/tauri";
import type {
  OpenworkServerCapabilities,
  OpenworkServerClient,
  OpenworkServerStatus,
} from "../lib/openwork-server";

export type ExtensionsStore = ReturnType<typeof createExtensionsStore>;

export function createExtensionsStore(options: {
  client: () => Client | null;
  projectDir: () => string;
  activeWorkspaceRoot: () => string;
  workspaceType: () => "local" | "remote";
  openworkServerClient: () => OpenworkServerClient | null;
  openworkServerStatus: () => OpenworkServerStatus;
  openworkServerCapabilities: () => OpenworkServerCapabilities | null;
  openworkServerWorkspaceId: () => string | null;
  setBusy: (value: boolean) => void;
  setBusyLabel: (value: string | null) => void;
  setBusyStartedAt: (value: number | null) => void;
  setError: (value: string | null) => void;
  markReloadRequired?: (reason: ReloadReason, trigger?: ReloadTrigger) => void;
  onNotionSkillInstalled?: () => void;
}) {
  // Translation helper that uses current language from i18n
  const translate = (key: string) => t(key, currentLocale());

  const [skills, setSkills] = createSignal<SkillCard[]>([]);
  const [skillsStatus, setSkillsStatus] = createSignal<string | null>(null);

  const [hubSkills, setHubSkills] = createSignal<HubSkillCard[]>([]);
  const [hubSkillsStatus, setHubSkillsStatus] = createSignal<string | null>(null);

  const formatSkillPath = (location: string) => location.replace(/[/\\]SKILL\.md$/i, "");

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
  let skillsRoot = "";
  let hubSkillsRoot = "";

  async function refreshHubSkills(optionsOverride?: { force?: boolean }) {
    const root = options.activeWorkspaceRoot().trim();
    const openworkClient = options.openworkServerClient();
    const openworkCapabilities = options.openworkServerCapabilities();
    const canUseOpenworkServer =
      options.openworkServerStatus() === "connected" &&
      openworkClient &&
      openworkCapabilities?.hub?.skills?.read &&
      typeof (openworkClient as any).listHubSkills === "function";

    if (root !== hubSkillsRoot) {
      hubSkillsLoaded = false;
    }

    if (!optionsOverride?.force && hubSkillsLoaded) return;
    if (refreshHubSkillsInFlight) return;

    refreshHubSkillsInFlight = true;
    refreshHubSkillsAborted = false;

    try {
      setHubSkillsStatus(null);

      if (canUseOpenworkServer) {
        const response = await (openworkClient as any).listHubSkills();
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
        hubSkillsRoot = root;
        return;
      }

      // Browser fallback: fetch directly from GitHub (public catalog).
      const listingRes = await fetch("https://api.github.com/repos/different-ai/openwork-hub/contents/skills?ref=main", {
        headers: { Accept: "application/vnd.github+json" },
      });
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
        source: { owner: "different-ai", repo: "openwork-hub", ref: "main", path: `skills/${dirName}` },
      }));

      if (refreshHubSkillsAborted) return;
      const sorted = next.slice().sort((a, b) => a.name.localeCompare(b.name));
      setHubSkills(sorted);
      if (!sorted.length) setHubSkillsStatus("No hub skills found.");
      hubSkillsLoaded = true;
      hubSkillsRoot = root;
    } catch (e) {
      if (refreshHubSkillsAborted) return;
      setHubSkills([]);
      setHubSkillsStatus(e instanceof Error ? e.message : "Failed to load hub skills.");
    } finally {
      refreshHubSkillsInFlight = false;
    }
  }

  async function installHubSkill(name: string): Promise<{ ok: boolean; message: string }> {
    const trimmed = name.trim();
    if (!trimmed) return { ok: false, message: "Skill name is required." };

    const isRemoteWorkspace = options.workspaceType() === "remote";
    const openworkClient = options.openworkServerClient();
    const openworkWorkspaceId = options.openworkServerWorkspaceId();
    const openworkCapabilities = options.openworkServerCapabilities();
    const canUseOpenworkServer =
      options.openworkServerStatus() === "connected" &&
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
      const result = await (openworkClient as any).installHubSkill(openworkWorkspaceId, trimmed);
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

  const isPluginInstalledByName = (pluginName: string, aliases: string[] = []) =>
    isPluginInstalled(pluginList(), pluginName, aliases);

  const loadPluginsFromConfig = (config: OpencodeConfigFile | null) => {
    loadPluginsFromConfigHelpers(config, setPluginList, (message) => setPluginStatus(message));
  };

  async function refreshSkills(optionsOverride?: { force?: boolean }) {
    const root = options.activeWorkspaceRoot().trim();
    const isRemoteWorkspace = options.workspaceType() === "remote";
    const isLocalWorkspace = options.workspaceType() === "local";
    const openworkClient = options.openworkServerClient();
    const openworkWorkspaceId = options.openworkServerWorkspaceId();
    const openworkCapabilities = options.openworkServerCapabilities();
    const canUseOpenworkServer =
      options.openworkServerStatus() === "connected" &&
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
    const openworkClient = options.openworkServerClient();
    const openworkWorkspaceId = options.openworkServerWorkspaceId();
    const openworkCapabilities = options.openworkServerCapabilities();
    const canUseOpenworkServer =
      options.openworkServerStatus() === "connected" &&
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
    const openworkClient = options.openworkServerClient();
    const openworkWorkspaceId = options.openworkServerWorkspaceId();
    const openworkCapabilities = options.openworkServerCapabilities();
    const canUseOpenworkServer =
      options.openworkServerStatus() === "connected" &&
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
    const openworkClient = options.openworkServerClient();
    const openworkWorkspaceId = options.openworkServerWorkspaceId();
    const openworkCapabilities = options.openworkServerCapabilities();
    const canUseOpenworkServer =
      options.openworkServerStatus() === "connected" &&
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

    const targetDir = options.activeWorkspaceRoot().trim();
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

    const root = options.activeWorkspaceRoot().trim();
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
    if (!isTauriRuntime()) {
      setSkillsStatus(translate("skills.desktop_required"));
      return;
    }

    if (options.workspaceType() !== "local") {
      options.setError("Local workers are required to uninstall skills.");
      return;
    }

    const root = options.activeWorkspaceRoot().trim();
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
      const result = await uninstallSkillCommand(root, trimmed);
      if (!result.ok) {
        setSkillsStatus(result.stderr || result.stdout || translate("skills.uninstall_failed"));
      } else {
        setSkillsStatus(result.stdout || translate("skills.uninstalled"));
        options.markReloadRequired?.("skills", { type: "skill", name: trimmed, action: "removed" });
      }

      await refreshSkills({ force: true });
    } catch (e) {
      const message = e instanceof Error ? e.message : translate("skills.unknown_error");
      options.setError(addOpencodeCacheHint(message));
    } finally {
      options.setBusy(false);
    }
  }

  async function readSkill(name: string): Promise<{ name: string; path: string; content: string } | null> {
    const trimmed = name.trim();
    if (!trimmed) return null;

    const root = options.activeWorkspaceRoot().trim();
    if (!root) {
      setSkillsStatus(translate("skills.pick_workspace_first"));
      return null;
    }

    const isRemoteWorkspace = options.workspaceType() === "remote";
    const isLocalWorkspace = options.workspaceType() === "local";
    const openworkClient = options.openworkServerClient();
    const openworkWorkspaceId = options.openworkServerWorkspaceId();
    const openworkCapabilities = options.openworkServerCapabilities();
    const canUseOpenworkServer =
      options.openworkServerStatus() === "connected" &&
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

    const root = options.activeWorkspaceRoot().trim();
    if (!root) {
      setSkillsStatus(translate("skills.pick_workspace_first"));
      return;
    }

    const isRemoteWorkspace = options.workspaceType() === "remote";
    const isLocalWorkspace = options.workspaceType() === "local";
    const openworkClient = options.openworkServerClient();
    const openworkWorkspaceId = options.openworkServerWorkspaceId();
    const openworkCapabilities = options.openworkServerCapabilities();
    const canUseOpenworkServer =
      options.openworkServerStatus() === "connected" &&
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
  }

  return {
    skills,
    skillsStatus,
    hubSkills,
    hubSkillsStatus,
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
    refreshPlugins,
    addPlugin,
    importLocalSkill,
    installSkillCreator,
    installHubSkill,
    revealSkillsFolder,
    uninstallSkill,
    readSkill,
    saveSkill,
    abortRefreshes,
  };
}
