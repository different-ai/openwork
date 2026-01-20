import { createSignal } from "solid-js";

import { applyEdits, modify } from "jsonc-parser";

import type { Client, CuratedPackage, Mode, PluginScope, ReloadReason, SkillCard } from "../types";
import { addOpencodeCacheHint, isTauriRuntime } from "../utils";
import {
  isPluginInstalled,
  loadPluginsFromConfig as loadPluginsFromConfigHelpers,
  parsePluginListFromContent,
  stripPluginVersion,
} from "../utils/plugins";
import {
  importSkill,
  opkgInstall,
  pickDirectory,
  readOpencodeConfig,
  writeOpencodeConfig,
  type OpencodeConfigFile,
} from "../lib/tauri";
import { unwrap } from "../lib/opencode";

export type ExtensionsStore = ReturnType<typeof createExtensionsStore>;

export function createExtensionsStore(options: {
  client: () => Client | null;
  mode: () => Mode | null;
  projectDir: () => string;
  activeWorkspaceRoot: () => string;
  setBusy: (value: boolean) => void;
  setBusyLabel: (value: string | null) => void;
  setBusyStartedAt: (value: number | null) => void;
  setError: (value: string | null) => void;
  markReloadRequired: (reason: ReloadReason) => void;
  onNotionSkillInstalled?: () => void;
}) {
  const [skills, setSkills] = createSignal<SkillCard[]>([]);
  const [skillsStatus, setSkillsStatus] = createSignal<string | null>(null);
  const [openPackageSource, setOpenPackageSource] = createSignal("");
  const [packageSearch, setPackageSearch] = createSignal("");

  const formatSkillPath = (location: string) => location.replace(/[/\\]SKILL\.md$/i, "");

  const [pluginScope, setPluginScope] = createSignal<PluginScope>("project");
  const [pluginConfig, setPluginConfig] = createSignal<OpencodeConfigFile | null>(null);
  const [pluginList, setPluginList] = createSignal<string[]>([]);
  const [pluginInput, setPluginInput] = createSignal("");
  const [pluginStatus, setPluginStatus] = createSignal<string | null>(null);
  const [activePluginGuide, setActivePluginGuide] = createSignal<string | null>(null);

  const [sidebarPluginList, setSidebarPluginList] = createSignal<string[]>([]);
  const [sidebarPluginStatus, setSidebarPluginStatus] = createSignal<string | null>(null);

  // Track in-flight requests to prevent duplicate calls
  let refreshSkillsInFlight = false;
  let refreshPluginsInFlight = false;
  let refreshSkillsAborted = false;
  let refreshPluginsAborted = false;
  let skillsLoaded = false;
  let skillsRoot = "";

  const isPluginInstalledByName = (pluginName: string, aliases: string[] = []) =>
    isPluginInstalled(pluginList(), pluginName, aliases);

  const loadPluginsFromConfig = (config: OpencodeConfigFile | null) => {
    loadPluginsFromConfigHelpers(config, setPluginList, (message) => setPluginStatus(message));
  };

  async function refreshSkills(optionsOverride?: { force?: boolean }) {
    const c = options.client();
    if (!c) {
      setSkills([]);
      setSkillsStatus("Connect to a host to load skills.");
      return;
    }

    const root = options.activeWorkspaceRoot().trim();
    if (!root) {
      setSkills([]);
      setSkillsStatus("Pick a workspace folder first.");
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
          err instanceof Error ? err.message : typeof err === "string" ? err : "Failed to load skills";
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
        setSkillsStatus("No skills found yet.");
      }
      skillsLoaded = true;
      skillsRoot = root;
    } catch (e) {
      if (refreshSkillsAborted) return;
      setSkills([]);
      setSkillsStatus(e instanceof Error ? e.message : "Failed to load skills");
    } finally {
      refreshSkillsInFlight = false;
    }
  }

  async function refreshPlugins(scopeOverride?: PluginScope) {
    if (!isTauriRuntime()) {
      setPluginStatus("Plugin management is only available in Host mode.");
      setPluginList([]);
      setSidebarPluginStatus("Plugins are only available in Host mode.");
      setSidebarPluginList([]);
      return;
    }

    // Skip if already in flight
    if (refreshPluginsInFlight) {
      return;
    }

    refreshPluginsInFlight = true;
    refreshPluginsAborted = false;

    const scope = scopeOverride ?? pluginScope();
    const targetDir = options.projectDir().trim();

    if (scope === "project" && !targetDir) {
      setPluginStatus("Pick a project folder to manage project plugins.");
      setPluginList([]);
      setSidebarPluginStatus("Pick a project folder to load active plugins.");
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

      if (!config.exists) {
        setPluginList([]);
        setPluginStatus("No opencode.json found yet. Add a plugin to create one.");
        setSidebarPluginList([]);
        setSidebarPluginStatus("No opencode.json in this workspace yet.");
        return;
      }

      try {
        const next = parsePluginListFromContent(config.content ?? "");
        setSidebarPluginList(next);
      } catch {
        setSidebarPluginList([]);
        setSidebarPluginStatus("Failed to parse opencode.json");
      }

      loadPluginsFromConfig(config);
    } catch (e) {
      if (refreshPluginsAborted) return;
      setPluginConfig(null);
      setPluginList([]);
      setPluginStatus(e instanceof Error ? e.message : "Failed to load opencode.json");
      setSidebarPluginStatus("Failed to load active plugins.");
      setSidebarPluginList([]);
    } finally {
      refreshPluginsInFlight = false;
    }
  }

  async function addPlugin(pluginNameOverride?: string) {
    if (!isTauriRuntime()) {
      setPluginStatus("Plugin management is only available in Host mode.");
      return;
    }

    const pluginName = (pluginNameOverride ?? pluginInput()).trim();
    const isManualInput = pluginNameOverride == null;

    if (!pluginName) {
      if (isManualInput) {
        setPluginStatus("Enter a plugin package name.");
      }
      return;
    }

    const scope = pluginScope();
    const targetDir = options.projectDir().trim();

    if (scope === "project" && !targetDir) {
      setPluginStatus("Pick a project folder to manage project plugins.");
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
        options.markReloadRequired("plugins");
        if (isManualInput) {
          setPluginInput("");
        }
        await refreshPlugins(scope);
        return;
      }

      const plugins = parsePluginListFromContent(raw);

      const desired = stripPluginVersion(pluginName).toLowerCase();
      if (plugins.some((entry) => stripPluginVersion(entry).toLowerCase() === desired)) {
        setPluginStatus("Plugin already listed in opencode.json.");
        return;
      }

      const next = [...plugins, pluginName];
      const edits = modify(raw, ["plugin"], next, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      });
      const updated = applyEdits(raw, edits);

      await writeOpencodeConfig(scope, targetDir, updated);
      options.markReloadRequired("plugins");
      if (isManualInput) {
        setPluginInput("");
      }
      await refreshPlugins(scope);
    } catch (e) {
      setPluginStatus(e instanceof Error ? e.message : "Failed to update opencode.json");
    }
  }

  async function installFromOpenPackage(sourceOverride?: string) {
    if (options.mode() !== "host" || !isTauriRuntime()) {
      options.setError("OpenPackage installs are only available in Host mode.");
      return;
    }

    const targetDir = options.projectDir().trim();
    const pkg = (sourceOverride ?? openPackageSource()).trim();
    const isNotionSkillInstall = pkg.toLowerCase().includes("manage-crm-notion");

    if (!targetDir) {
      options.setError("Pick a project folder first.");
      return;
    }

    if (!pkg) {
      options.setError("Enter an OpenPackage source (e.g. github:anthropics/claude-code).");
      return;
    }

    setOpenPackageSource(pkg);
    options.setBusy(true);
    options.setError(null);
    setSkillsStatus("Installing OpenPackage...");

    try {
      const result = await opkgInstall(targetDir, pkg);
      if (!result.ok) {
        setSkillsStatus(result.stderr || result.stdout || `opkg failed (${result.status})`);
      } else {
        setSkillsStatus(result.stdout || "Installed.");
        options.markReloadRequired("skills");
        if (isNotionSkillInstall) {
          options.onNotionSkillInstalled?.();
        }
      }

      await refreshSkills({ force: true });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      options.setError(addOpencodeCacheHint(message));
    } finally {
      options.setBusy(false);
    }
  }

  async function useCuratedPackage(pkg: CuratedPackage) {
    if (pkg.installable) {
      await installFromOpenPackage(pkg.source);
      return;
    }

    setOpenPackageSource(pkg.source);
    setSkillsStatus(
      "This is a curated list, not an OpenPackage yet. Copy the link or watch the PRD for planned registry search integration.",
    );
  }

  async function importLocalSkill() {
    if (options.mode() !== "host" || !isTauriRuntime()) {
      options.setError("Skill import is only available in Host mode.");
      return;
    }

    const targetDir = options.projectDir().trim();
    if (!targetDir) {
      options.setError("Pick a project folder first.");
      return;
    }

    options.setBusy(true);
    options.setError(null);
    setSkillsStatus(null);

    try {
      const selection = await pickDirectory({ title: "Select skill folder" });
      const sourceDir = typeof selection === "string" ? selection : Array.isArray(selection) ? selection[0] : null;

      if (!sourceDir) {
        return;
      }

      const result = await importSkill(targetDir, sourceDir, { overwrite: false });
      if (!result.ok) {
        setSkillsStatus(result.stderr || result.stdout || `Import failed (${result.status})`);
      } else {
        setSkillsStatus(result.stdout || "Imported.");
        options.markReloadRequired("skills");
      }

      await refreshSkills({ force: true });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Unknown error";
      options.setError(addOpencodeCacheHint(message));
    } finally {
      options.setBusy(false);
    }
  }

  function abortRefreshes() {
    refreshSkillsAborted = true;
    refreshPluginsAborted = true;
  }

  return {
    skills,
    skillsStatus,
    openPackageSource,
    setOpenPackageSource,
    packageSearch,
    setPackageSearch,
    pluginScope,
    setPluginScope,
    pluginConfig,
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
    refreshPlugins,
    addPlugin,
    installFromOpenPackage,
    useCuratedPackage,
    importLocalSkill,
    abortRefreshes,
  };
}
