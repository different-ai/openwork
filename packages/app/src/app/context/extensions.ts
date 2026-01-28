import { createSignal } from "solid-js";

import { applyEdits, modify } from "jsonc-parser";
import { join } from "@tauri-apps/api/path";
import { currentLocale, t } from "../../i18n";

import type { Client, Mode, PluginScope, ReloadReason, RemoteSkillCard, RemoteSkillSource, SkillCard } from "../types";
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
  uninstallSkill as uninstallSkillCommand,
  pickDirectory,
  readOpencodeConfig,
  writeOpencodeConfig,
  type OpencodeConfigFile,
} from "../lib/tauri";
import {
  fetchRemoteSkillContent,
  listGitHubSkills,
  parseGitHubSourceInput,
  type ParsedGitHubSource,
} from "../lib/github-skills";
import {
  OpenworkServerError,
  type OpenworkServerCapabilities,
  type OpenworkServerClient,
  type OpenworkServerStatus,
} from "../lib/openwork-server";

export type ExtensionsStore = ReturnType<typeof createExtensionsStore>;

export function createExtensionsStore(options: {
  client: () => Client | null;
  mode: () => Mode | null;
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
  markReloadRequired: (reason: ReloadReason) => void;
  onNotionSkillInstalled?: () => void;
}) {
  // Translation helper that uses current language from i18n
  const translate = (key: string) => t(key, currentLocale());

  const [skills, setSkills] = createSignal<SkillCard[]>([]);
  const [skillsStatus, setSkillsStatus] = createSignal<string | null>(null);
  const [remoteSkillSources, setRemoteSkillSources] = createSignal<RemoteSkillSource[]>([]);
  const [remoteSkills, setRemoteSkills] = createSignal<RemoteSkillCard[]>([]);
  const [remoteSkillsStatus, setRemoteSkillsStatus] = createSignal<string | null>(null);
  const [remoteSkillsLoading, setRemoteSkillsLoading] = createSignal(false);
  const [remoteSkillInstallState, setRemoteSkillInstallState] = createSignal<
    Record<string, { status: "idle" | "installing" | "error"; message?: string | null }>
  >({});

  const formatSkillPath = (location: string) => location.replace(/[/\\]SKILL\.md$/i, "");

  const REMOTE_SKILL_STORAGE_PREFIX = "openwork.remoteSkills.sources";

  const remoteSkillStorageKey = () => {
    const workspaceType = options.workspaceType();
    const workspaceRoot = options.activeWorkspaceRoot().trim();
    const openworkWorkspaceId = options.openworkServerWorkspaceId();
    if (workspaceType === "remote") {
      const remoteKey = openworkWorkspaceId?.trim() || workspaceRoot;
      return remoteKey
        ? `${REMOTE_SKILL_STORAGE_PREFIX}.remote.${encodeURIComponent(remoteKey)}`
        : null;
    }
    if (!workspaceRoot) return null;
    return `${REMOTE_SKILL_STORAGE_PREFIX}.local.${encodeURIComponent(workspaceRoot)}`;
  };

  const readRemoteSkillSourcesFromStorage = (key: string) => {
    if (typeof window === "undefined") return [] as string[];
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.map((value) => String(value)).filter(Boolean);
    } catch {
      return [];
    }
  };

  const writeRemoteSkillSourcesToStorage = (key: string, sources: string[]) => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(key, JSON.stringify(sources));
    } catch {
      // ignore
    }
  };

  const formatGithubError = (error: unknown) => {
    const status = typeof (error as { status?: number })?.status === "number"
      ? (error as { status?: number }).status
      : null;
    if (status === 404) return translate("skills.remote_repo_not_found");
    if (status === 403 || status === 429) return translate("skills.remote_rate_limited");
    if (error instanceof Error) return error.message;
    return translate("skills.remote_fetch_failed");
  };

  const formatOpenworkError = (error: unknown) => {
    if (error instanceof OpenworkServerError) return error.message;
    if (error instanceof Error) return error.message;
    return translate("skills.remote_fetch_failed");
  };

  const hydrateRemoteSkillSources = (inputs: string[]) => {
    const existing = new Map(remoteSkillSources().map((source: RemoteSkillSource) => [source.id, source]));
    const seen = new Set<string>();
    const output: RemoteSkillSource[] = [];
    for (const input of inputs) {
      const parsed = parseGitHubSourceInput(input);
      if (!parsed) {
        const fallback: RemoteSkillSource = {
          id: `invalid:${input}`,
          input,
          repo: "",
          ref: null,
          pathPrefix: null,
          status: "error",
          errorMessage: translate("skills.remote_source_invalid"),
        };
        if (!seen.has(fallback.id)) {
          seen.add(fallback.id);
          output.push(fallback);
        }
        continue;
      }

      const next: RemoteSkillSource = {
        id: parsed.id,
        input: parsed.input,
        repo: parsed.repo,
        ref: parsed.ref,
        pathPrefix: parsed.pathPrefix,
        status: "idle",
        errorMessage: null,
      };
      const previous = existing.get(parsed.id);
      const merged = previous ? { ...previous, ...next } : next;
      if (!seen.has(merged.id)) {
        seen.add(merged.id);
        output.push(merged);
      }
    }
    return output;
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
  let refreshRemoteSkillsInFlight = false;
  let refreshSkillsAborted = false;
  let refreshPluginsAborted = false;
  let refreshRemoteSkillsAborted = false;
  let skillsLoaded = false;
  let skillsRoot = "";
  let remoteSourcesLoaded = false;
  let remoteSourcesKey = "";

  const isPluginInstalledByName = (pluginName: string, aliases: string[] = []) =>
    isPluginInstalled(pluginList(), pluginName, aliases);

  const loadPluginsFromConfig = (config: OpencodeConfigFile | null) => {
    loadPluginsFromConfigHelpers(config, setPluginList, (message) => setPluginStatus(message));
  };

  async function refreshSkills(optionsOverride?: { force?: boolean }) {
    const root = options.activeWorkspaceRoot().trim();
    const isRemoteWorkspace = options.workspaceType() === "remote";
    const openworkClient = options.openworkServerClient();
    const openworkWorkspaceId = options.openworkServerWorkspaceId();
    const openworkCapabilities = options.openworkServerCapabilities();
    if (!root) {
      setSkills([]);
      setSkillsStatus(translate("skills.pick_workspace_first"));
      return;
    }

    // Host/Tauri mode: read directly from `.opencode/skills` or `.claude/skills`
    // so the UI still works even if the OpenCode engine is stopped or unreachable.
    if (options.mode() === "host" && isTauriRuntime()) {
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

    if (isRemoteWorkspace && openworkClient && openworkWorkspaceId && openworkCapabilities?.skills?.read) {
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
        const response = await openworkClient.listSkills(openworkWorkspaceId);
        if (refreshSkillsAborted) return;
        const next: SkillCard[] = Array.isArray(response.items)
          ? response.items.map((entry) => ({
              name: entry.name,
              description: entry.description,
              path: entry.path,
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
      setSkillsStatus(
        isRemoteWorkspace
          ? "OpenWork server unavailable. Connect to load skills."
          : translate("skills.connect_host_to_load"),
      );
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

  const loadRemoteSkillSources = async (optionsOverride?: { force?: boolean }) => {
    const key = remoteSkillStorageKey();
    if (!key) {
      setRemoteSkillSources([]);
      return [] as RemoteSkillSource[];
    }

    if (!optionsOverride?.force && remoteSourcesLoaded && key === remoteSourcesKey) {
      return remoteSkillSources();
    }

    remoteSourcesKey = key;
    remoteSourcesLoaded = true;

    const isRemoteWorkspace = options.workspaceType() === "remote";
    const openworkClient = options.openworkServerClient();
    const openworkWorkspaceId = options.openworkServerWorkspaceId();
    const openworkCapabilities = options.openworkServerCapabilities();
    let inputs: string[] = [];

    if (isRemoteWorkspace && openworkClient && openworkWorkspaceId && openworkCapabilities?.config?.read) {
      try {
        const config = await openworkClient.getConfig(openworkWorkspaceId);
        const openwork = (config.openwork ?? {}) as Record<string, unknown>;
        const remoteSkills = (openwork.remoteSkills ?? {}) as Record<string, unknown>;
        const stored = Array.isArray(remoteSkills.sources) ? remoteSkills.sources : [];
        inputs = stored.map((value) => String(value)).filter(Boolean);
      } catch (error) {
        setRemoteSkillsStatus(formatOpenworkError(error));
      }
    }

    if (!inputs.length) {
      inputs = readRemoteSkillSourcesFromStorage(key);
    }

    const nextSources = hydrateRemoteSkillSources(inputs);
    setRemoteSkillSources(nextSources);
    return nextSources;
  };

  const persistRemoteSkillSources = async (sources: RemoteSkillSource[]) => {
    const key = remoteSkillStorageKey();
    const inputs = sources.map((source) => source.input);
    if (key) {
      writeRemoteSkillSourcesToStorage(key, inputs);
    }

    const isRemoteWorkspace = options.workspaceType() === "remote";
    const openworkClient = options.openworkServerClient();
    const openworkWorkspaceId = options.openworkServerWorkspaceId();
    const openworkCapabilities = options.openworkServerCapabilities();

    if (isRemoteWorkspace && openworkClient && openworkWorkspaceId && openworkCapabilities?.config?.write) {
      try {
        const config = await openworkClient.getConfig(openworkWorkspaceId);
        const openwork = (config.openwork ?? {}) as Record<string, unknown>;
        const remoteSkills = (openwork.remoteSkills ?? {}) as Record<string, unknown>;
        const nextOpenwork = {
          ...openwork,
          remoteSkills: {
            ...remoteSkills,
            sources: inputs,
          },
        };
        await openworkClient.patchConfig(openworkWorkspaceId, { openwork: nextOpenwork });
      } catch (error) {
        setRemoteSkillsStatus(formatOpenworkError(error));
      }
    }
  };

  async function refreshRemoteSkills(optionsOverride?: { force?: boolean }) {
    const root = options.activeWorkspaceRoot().trim();
    const isRemoteWorkspace = options.workspaceType() === "remote";
    const openworkClient = options.openworkServerClient();
    const openworkWorkspaceId = options.openworkServerWorkspaceId();
    const openworkCapabilities = options.openworkServerCapabilities();

    if (!root && !isRemoteWorkspace) {
      setRemoteSkills([]);
      setRemoteSkillsStatus(translate("skills.pick_workspace_first"));
      return;
    }

    if (refreshRemoteSkillsInFlight) {
      return;
    }

    refreshRemoteSkillsInFlight = true;
    refreshRemoteSkillsAborted = false;
    setRemoteSkillsLoading(true);
    setRemoteSkillsStatus(null);

    try {
      const sources = await loadRemoteSkillSources(optionsOverride);
      if (refreshRemoteSkillsAborted) return;

      setRemoteSkillSources((current) =>
        current.map((source) =>
          source.repo
            ? { ...source, status: "loading", errorMessage: null }
            : source,
        ),
      );

      if (!sources.length) {
        setRemoteSkills([]);
        setRemoteSkillsStatus(null);
        return;
      }

      const validSources = sources.filter((source) => source.repo);
      if (!validSources.length) {
        setRemoteSkills([]);
        setRemoteSkillsStatus(translate("skills.remote_source_invalid"));
        return;
      }

      if (isRemoteWorkspace) {
        if (!openworkClient || !openworkWorkspaceId || !openworkCapabilities?.skills?.read) {
          setRemoteSkills([]);
          setRemoteSkillsStatus(translate("skills.remote_host_required"));
          return;
        }

        const response = await openworkClient.listRemoteSkills(
          openworkWorkspaceId,
          sources.map((source) => source.input),
        );
        if (refreshRemoteSkillsAborted) return;

        const sourceById = new Map(sources.map((source) => [source.id, source]));
        const nextSources = response.sources.map((source) => {
          const existing = sourceById.get(source.id);
          return {
            ...(existing ?? {}),
            ...source,
            status: source.status === "error" ? "error" : "success",
            errorMessage: source.errorMessage ?? null,
          } as RemoteSkillSource;
        });
        setRemoteSkillSources(nextSources);
        setRemoteSkills(response.items as RemoteSkillCard[]);
        if (!response.items.length) {
          setRemoteSkillsStatus(translate("skills.remote_no_skills"));
        }
        return;
      }

      const results = await Promise.all(
        validSources.map(async (source) => {
          const parsed: ParsedGitHubSource = {
            input: source.input,
            id: source.id,
            repo: source.repo,
            ref: source.ref,
            pathPrefix: source.pathPrefix,
          };
          try {
            const items = await listGitHubSkills(parsed);
            const resolvedRef = items[0]?.ref ?? parsed.ref ?? null;
            return { sourceId: source.id, items, error: null, resolvedRef };
          } catch (error) {
            return { sourceId: source.id, items: [] as RemoteSkillCard[], error: formatGithubError(error), resolvedRef: null };
          }
        }),
      );

      if (refreshRemoteSkillsAborted) return;

      const nextItems = results.flatMap((result) => result.items);
      const nextSources = sources.map((source) => {
        if (!source.repo) return source;
        const match = results.find((result) => result.sourceId === source.id);
        if (!match) return source;
        return {
          ...source,
          status: match.error ? "error" : "success",
          errorMessage: match.error ?? null,
          resolvedRef: match.resolvedRef ?? source.resolvedRef,
        };
      });

      setRemoteSkillSources(nextSources);
      setRemoteSkills(nextItems);
      if (!nextItems.length && !results.some((result) => result.error)) {
        setRemoteSkillsStatus(translate("skills.remote_no_skills"));
      }
    } catch (error) {
      if (refreshRemoteSkillsAborted) return;
      setRemoteSkillsStatus(isRemoteWorkspace ? formatOpenworkError(error) : formatGithubError(error));
    } finally {
      refreshRemoteSkillsInFlight = false;
      setRemoteSkillsLoading(false);
    }
  }

  async function addRemoteSkillSource(input: string) {
    const trimmed = input.trim();
    if (!trimmed) {
      setRemoteSkillsStatus(translate("skills.remote_source_required"));
      return false;
    }

    const parsed = parseGitHubSourceInput(trimmed);
    if (!parsed) {
      setRemoteSkillsStatus(translate("skills.remote_source_invalid"));
      return false;
    }

    const current = remoteSkillSources();
    if (current.some((source) => source.id === parsed.id)) {
      setRemoteSkillsStatus(translate("skills.remote_source_exists"));
      return false;
    }

    const nextSource: RemoteSkillSource = {
      id: parsed.id,
      input: parsed.input,
      repo: parsed.repo,
      ref: parsed.ref,
      pathPrefix: parsed.pathPrefix,
      status: "idle",
      errorMessage: null,
    };
    const nextSources = [...current, nextSource];
    setRemoteSkillSources(nextSources);
    await persistRemoteSkillSources(nextSources);
    setRemoteSkillsStatus(null);
    await refreshRemoteSkills({ force: true });
    return true;
  }

  async function removeRemoteSkillSource(id: string) {
    const current = remoteSkillSources();
    const nextSources = current.filter((source) => source.id !== id);
    setRemoteSkillSources(nextSources);
    setRemoteSkills((items) => items.filter((item) => item.sourceId !== id));
    await persistRemoteSkillSources(nextSources);
    if (!nextSources.length) {
      setRemoteSkillsStatus(null);
    }
  }

  const setInstallState = (id: string, status: "idle" | "installing" | "error", message?: string | null) => {
    setRemoteSkillInstallState((current) => ({
      ...current,
      [id]: { status, message: message ?? null },
    }));
  };

  async function installRemoteSkill(skill: RemoteSkillCard) {
    const snapshot = { ...skill };
    const current = remoteSkillInstallState()[snapshot.id];
    if (current?.status === "installing") return;

    setInstallState(snapshot.id, "installing", null);

    const isRemoteWorkspace = options.workspaceType() === "remote";
    if (isRemoteWorkspace) {
      const openworkClient = options.openworkServerClient();
      const openworkWorkspaceId = options.openworkServerWorkspaceId();
      const openworkCapabilities = options.openworkServerCapabilities();
      if (!openworkClient || !openworkWorkspaceId || !openworkCapabilities?.skills?.write) {
        setInstallState(snapshot.id, "error", translate("skills.remote_host_required"));
        return;
      }

      try {
        await openworkClient.installRemoteSkill(openworkWorkspaceId, {
          source: snapshot.sourceInput,
          path: snapshot.skillFilePath,
          name: snapshot.name,
        });
        await refreshSkills({ force: true });
        setInstallState(snapshot.id, "idle", null);
      } catch (error) {
        setInstallState(snapshot.id, "error", formatOpenworkError(error));
      }
      return;
    }

    if (!isTauriRuntime()) {
      setInstallState(snapshot.id, "error", translate("skills.desktop_required"));
      return;
    }

    const root = options.activeWorkspaceRoot().trim();
    if (!root) {
      setInstallState(snapshot.id, "error", translate("skills.pick_workspace_first"));
      return;
    }

    try {
      const content = await fetchRemoteSkillContent(snapshot);
      const result = await installSkillTemplate(root, snapshot.name, content, { overwrite: false });
      if (!result.ok) {
        setInstallState(
          snapshot.id,
          "error",
          result.stderr || result.stdout || translate("skills.install_failed"),
        );
        return;
      }
      options.markReloadRequired("skills");
      await refreshSkills({ force: true });
      setInstallState(snapshot.id, "idle", null);
    } catch (error) {
      const message = error instanceof Error ? error.message : translate("skills.unknown_error");
      setInstallState(snapshot.id, "error", message);
    }
  }

  async function refreshPlugins(scopeOverride?: PluginScope) {
    const isRemoteWorkspace = options.workspaceType() === "remote";
    const openworkClient = options.openworkServerClient();
    const openworkWorkspaceId = options.openworkServerWorkspaceId();
    const openworkCapabilities = options.openworkServerCapabilities();

    // Skip if already in flight
    if (refreshPluginsInFlight) {
      return;
    }

    refreshPluginsInFlight = true;
    refreshPluginsAborted = false;

    const scope = scopeOverride ?? pluginScope();
    const targetDir = options.projectDir().trim();

    if (isRemoteWorkspace) {
      setPluginConfig(null);
      setPluginConfigPath("opencode.json (remote)");
      if (scope !== "project") {
        setPluginStatus("Global plugins are only available in Host mode.");
        setPluginList([]);
        setSidebarPluginStatus("Switch to project scope to view remote plugins.");
        setSidebarPluginList([]);
        refreshPluginsInFlight = false;
        return;
      }

      if (!openworkClient || !openworkWorkspaceId || !openworkCapabilities?.plugins?.read) {
        setPluginStatus("OpenWork server unavailable. Plugins are read-only.");
        setPluginList([]);
        setSidebarPluginStatus("Connect OpenWork server to load plugins.");
        setSidebarPluginList([]);
        refreshPluginsInFlight = false;
        return;
      }

      try {
        setPluginStatus(null);
        setSidebarPluginStatus(null);

        const result = await openworkClient.listPlugins(openworkWorkspaceId);
        if (refreshPluginsAborted) return;

        const configItems = result.items.filter((item) => item.source === "config");
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

    const isRemoteWorkspace = options.workspaceType() === "remote";
    const openworkClient = options.openworkServerClient();
    const openworkWorkspaceId = options.openworkServerWorkspaceId();
    const openworkCapabilities = options.openworkServerCapabilities();

    if (!pluginName) {
      if (isManualInput) {
        setPluginStatus(translate("skills.enter_plugin_name"));
      }
      return;
    }

    if (isRemoteWorkspace) {
      if (pluginScope() !== "project") {
        setPluginStatus("Global plugins are only available in Host mode.");
        return;
      }
      if (!openworkClient || !openworkWorkspaceId || !openworkCapabilities?.plugins?.write) {
        setPluginStatus("OpenWork server unavailable. Connect to add plugins.");
        return;
      }

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
        setPluginStatus(translate("skills.plugin_already_listed"));
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
      setPluginStatus(e instanceof Error ? e.message : translate("skills.failed_update_opencode"));
    }
  }

  async function importLocalSkill() {
    if (options.mode() !== "host" || !isTauriRuntime()) {
      options.setError(translate("skills.import_host_only"));
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

      const result = await importSkill(targetDir, sourceDir, { overwrite: false });
      if (!result.ok) {
        setSkillsStatus(result.stderr || result.stdout || translate("skills.import_failed").replace("{status}", String(result.status)));
      } else {
        setSkillsStatus(result.stdout || translate("skills.imported"));
        options.markReloadRequired("skills");
      }

      await refreshSkills({ force: true });
    } catch (e) {
      const message = e instanceof Error ? e.message : translate("skills.unknown_error");
      options.setError(addOpencodeCacheHint(message));
    } finally {
      options.setBusy(false);
    }
  }

  async function installSkillCreator() {
    const isRemoteWorkspace = options.workspaceType() === "remote";
    const openworkClient = options.openworkServerClient();
    const openworkWorkspaceId = options.openworkServerWorkspaceId();
    const openworkCapabilities = options.openworkServerCapabilities();

    if (isRemoteWorkspace) {
      if (!openworkClient || !openworkWorkspaceId || !openworkCapabilities?.skills?.write) {
        setSkillsStatus("OpenWork server unavailable. Connect to install skills.");
        return;
      }

      options.setBusy(true);
      options.setError(null);
      setSkillsStatus(translate("skills.installing_skill_creator"));

      try {
        await openworkClient.upsertSkill(openworkWorkspaceId, {
          name: "skill-creator",
          content: skillCreatorTemplate,
        });
        setSkillsStatus(translate("skills.skill_creator_installed"));
        await refreshSkills({ force: true });
      } catch (e) {
        const message = e instanceof Error ? e.message : translate("skills.unknown_error");
        options.setError(addOpencodeCacheHint(message));
      } finally {
        options.setBusy(false);
      }
      return;
    }

    if (!isTauriRuntime()) {
      setSkillsStatus(translate("skills.desktop_required"));
      return;
    }

    if (options.mode() !== "host") {
      options.setError(translate("skills.host_only_error"));
      return;
    }

    const targetDir = options.activeWorkspaceRoot().trim();
    if (!targetDir) {
      setSkillsStatus(translate("skills.pick_workspace_first"));
      return;
    }

    options.setBusy(true);
    options.setError(null);
    setSkillsStatus(translate("skills.installing_skill_creator"));

    try {
      const result = await installSkillTemplate(targetDir, "skill-creator", skillCreatorTemplate, { overwrite: false });

      if (!result.ok && /already exists/i.test(result.stderr)) {
        setSkillsStatus(translate("skills.skill_creator_already_installed"));
      } else if (!result.ok) {
        setSkillsStatus(result.stderr || result.stdout || translate("skills.install_failed"));
      } else {
        setSkillsStatus(result.stdout || translate("skills.skill_creator_installed"));
        options.markReloadRequired("skills");
      }

      await refreshSkills({ force: true });
    } catch (e) {
      const message = e instanceof Error ? e.message : translate("skills.unknown_error");
      options.setError(addOpencodeCacheHint(message));
    } finally {
      options.setBusy(false);
    }
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

    if (options.mode() !== "host") {
      options.setError(translate("skills.host_only_error"));
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
        options.markReloadRequired("skills");
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
    refreshRemoteSkillsAborted = true;
  }

  return {
    skills,
    skillsStatus,
    remoteSkillSources,
    remoteSkills,
    remoteSkillsStatus,
    remoteSkillsLoading,
    remoteSkillInstallState,
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
    refreshRemoteSkills,
    refreshPlugins,
    addPlugin,
    addRemoteSkillSource,
    removeRemoteSkillSource,
    importLocalSkill,
    installSkillCreator,
    installRemoteSkill,
    revealSkillsFolder,
    uninstallSkill,
    abortRefreshes,
  };
}
