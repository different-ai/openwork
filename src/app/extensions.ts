import { createSignal } from "solid-js";

import { applyEdits, modify } from "jsonc-parser";

import type { Client, CuratedPackage, Mode, PluginScope, ReloadReason, SkillCard } from "./types";
import { isTauriRuntime } from "./utils";
import {
  isPluginInstalled,
  loadPluginsFromConfig as loadPluginsFromConfigHelpers,
  parsePluginListFromContent,
  stripPluginVersion,
} from "./plugins";
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
}) {
  const [skills, setSkills] = createSignal<SkillCard[]>([]);
  const [skillsStatus, setSkillsStatus] = createSignal<string | null>(null);
  const [openPackageSource, setOpenPackageSource] = createSignal("");
  const [packageSearch, setPackageSearch] = createSignal("");

  const [pluginScope, setPluginScope] = createSignal<PluginScope>("project");
  const [pluginConfig, setPluginConfig] = createSignal<OpencodeConfigFile | null>(null);
  const [pluginList, setPluginList] = createSignal<string[]>([]);
  const [pluginInput, setPluginInput] = createSignal("");
  const [pluginStatus, setPluginStatus] = createSignal<string | null>(null);
  const [activePluginGuide, setActivePluginGuide] = createSignal<string | null>(null);

  const [sidebarPluginList, setSidebarPluginList] = createSignal<string[]>([]);
  const [sidebarPluginStatus, setSidebarPluginStatus] = createSignal<string | null>(null);

  const isPluginInstalledByName = (pluginName: string, aliases: string[] = []) =>
    isPluginInstalled(pluginList(), pluginName, aliases);

  const loadPluginsFromConfig = (config: OpencodeConfigFile | null) => {
    loadPluginsFromConfigHelpers(config, setPluginList, (message) => setPluginStatus(message));
  };

  async function refreshSkills() {
    const c = options.client();
    if (!c) return;

    try {
      setSkillsStatus(null);
      const nodes = unwrap(
        await c.file.list({ directory: options.activeWorkspaceRoot().trim(), path: ".opencode/skill" }),
      );

      const dirs = nodes.filter((n) => n.type === "directory" && !n.ignored);

      const next: SkillCard[] = [];

      for (const dir of dirs) {
        let description: string | undefined;

        try {
          const skillDoc = unwrap(
            await c.file.read({
              directory: options.activeWorkspaceRoot().trim(),
              path: `.opencode/skill/${dir.name}/SKILL.md`,
            }),
          );

          if (skillDoc.type === "text") {
            const lines = skillDoc.content.split("\n");
            const first = lines
              .map((l) => l.trim())
              .filter((l) => l && !l.startsWith("#"))
              .slice(0, 2)
              .join(" ");
            if (first) {
              description = first;
            }
          }
        } catch {
          // ignore missing SKILL.md
        }

        next.push({ name: dir.name, path: dir.path, description });
      }

      setSkills(next);
      if (!next.length) {
        setSkillsStatus("No skills found in .opencode/skill");
      }
    } catch (e) {
      setSkills([]);
      setSkillsStatus(e instanceof Error ? e.message : "Failed to load skills");
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

    const scope = scopeOverride ?? pluginScope();
    const targetDir = options.projectDir().trim();

    if (scope === "project" && !targetDir) {
      setPluginStatus("Pick a project folder to manage project plugins.");
      setPluginList([]);
      setSidebarPluginStatus("Pick a project folder to load active plugins.");
      setSidebarPluginList([]);
      return;
    }

    try {
      setPluginStatus(null);
      setSidebarPluginStatus(null);
      const config = await readOpencodeConfig(scope, targetDir);
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
      setPluginConfig(null);
      setPluginList([]);
      setPluginStatus(e instanceof Error ? e.message : "Failed to load opencode.json");
      setSidebarPluginStatus("Failed to load active plugins.");
      setSidebarPluginList([]);
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
      }

      await refreshSkills();
    } catch (e) {
      options.setError(e instanceof Error ? e.message : String(e));
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

      await refreshSkills();
    } catch (e) {
      options.setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      options.setBusy(false);
    }
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
  };
}
