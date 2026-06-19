import { existsSync, watch, type FSWatcher } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import type { ReloadEventStore } from "./events.js";
import { computeReloadFingerprint, fingerprintedReloadReasons } from "./reload-fingerprint.js";
import type { ReloadReason, ReloadTrigger, ServerConfig, WorkspaceInfo } from "./types.js";

type LogLevel = "info" | "warn" | "error";

type Logger = {
  log: (level: LogLevel, message: string, attributes?: Record<string, unknown>) => void;
};

type DirectoryTreeWatcher = {
  scheduleRescan: () => void;
  close: () => void;
};

type WorkspaceReloadWatcher = {
  refreshBaseline: (reasons?: ReloadReason[]) => Promise<void>;
  close: () => void;
};

export function startReloadWatchers(input: {
  config: ServerConfig;
  reloadEvents: ReloadEventStore;
  logger?: Logger | null;
  debounceMs?: number;
}): { close: () => void; refreshWorkspace: (workspaceId: string, reasons?: ReloadReason[]) => Promise<void> } {
  const { config, reloadEvents } = input;
  const logger = input.logger ?? null;
  const debounceMs = typeof input.debounceMs === "number" ? input.debounceMs : 750;

  const workspaceWatchers = new Map<string, WorkspaceReloadWatcher>();

  for (const workspace of config.workspaces) {
    try {
      const watcher = startWorkspaceReloadWatcher({ workspace, reloadEvents, logger, debounceMs });
      workspaceWatchers.set(workspace.id, watcher);
    } catch (error) {
      logger?.log("warn", "Reload watcher failed to start", {
        workspaceId: workspace.id,
        workspacePath: workspace.path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (config.workspaces.length) {
    logger?.log("info", `Reload watcher enabled (${config.workspaces.length})`, {
      workspaceCount: config.workspaces.length,
    });
  }

  return {
    close: () => {
      for (const watcher of workspaceWatchers.values()) {
        try {
          watcher.close();
        } catch {
          // ignore
        }
      }
      workspaceWatchers.clear();
    },
    refreshWorkspace: async (workspaceId: string, reasons?: ReloadReason[]) => {
      await workspaceWatchers.get(workspaceId)?.refreshBaseline(reasons);
    },
  };
}

function startWorkspaceReloadWatcher(input: {
  workspace: WorkspaceInfo;
  reloadEvents: ReloadEventStore;
  logger: Logger | null;
  debounceMs: number;
}): WorkspaceReloadWatcher {
  const { workspace, reloadEvents, logger, debounceMs } = input;
  const root = resolve(workspace.path);
  const opencodeRoot = join(root, ".opencode");

  const trees: DirectoryTreeWatcher[] = [];
  const baselines = new Map<ReloadReason, string>();
  const pendingChecks = new Map<ReloadReason, { timer: ReturnType<typeof setTimeout>; trigger?: ReloadTrigger }>();

  let closed = false;
  let rootWatcher: FSWatcher | null = null;
  let opencodeRootWatcher: FSWatcher | null = null;

  const closeAll = () => {
    closed = true;
    for (const pending of pendingChecks.values()) {
      clearTimeout(pending.timer);
    }
    pendingChecks.clear();
    for (const tree of trees) {
      tree.close();
    }
    rootWatcher?.close();
    opencodeRootWatcher?.close();
  };

  const refreshBaseline = async (reasons: ReloadReason[] = fingerprintedReloadReasons) => {
    for (const reason of reasons) {
      if (!fingerprintedReloadReasons.includes(reason)) continue;
      baselines.set(reason, await computeReloadFingerprint(root, reason));
    }
  };

  // Best-known named trigger per reason. fs.watch event order and filename
  // presence are platform-dependent (macOS often omits filenames or fires a
  // named check before the write has flushed), so a triggerless path can be
  // the one that finally observes the fingerprint change. Remember the most
  // recent named trigger briefly and attach it to such records instead of
  // emitting trigger-less reload events.
  const NAMED_TRIGGER_TTL_MS = 5_000;
  const lastNamedTrigger = new Map<ReloadReason, { trigger: ReloadTrigger; at: number }>();

  const resolveTrigger = (reason: ReloadReason, trigger?: ReloadTrigger): ReloadTrigger | undefined => {
    if (trigger) return trigger;
    const recent = lastNamedTrigger.get(reason);
    if (recent && Date.now() - recent.at <= NAMED_TRIGGER_TTL_MS) return recent.trigger;
    // Last line of defense: macOS fs.watch can coalesce a config-file write
    // into a single directory-level event (e.g. ".opencode") and never
    // deliver a file-named event at all. If a config/agents fingerprint
    // change is about to be recorded with no trigger, infer it from the
    // files that can produce it — same inference the watch callbacks use.
    if (reason === "config") {
      const candidates = [
        join(root, "opencode.jsonc"),
        join(root, "opencode.json"),
        join(opencodeRoot, "opencode.jsonc"),
        join(opencodeRoot, "opencode.json"),
      ];
      const found = candidates.find((candidate) => existsSync(candidate));
      if (found) return { type: "config", name: basename(found), action: "updated", path: found };
    }
    if (reason === "agents") {
      const agentsPath = join(root, "AGENTS.md");
      if (existsSync(agentsPath)) return { type: "agent", action: "updated", path: agentsPath };
    }
    return undefined;
  };

  const checkReason = async (reason: ReloadReason, trigger?: ReloadTrigger) => {
    if (closed) return;
    if (!fingerprintedReloadReasons.includes(reason)) return;

    const current = await computeReloadFingerprint(root, reason);
    const previous = baselines.get(reason);
    baselines.set(reason, current);

    if (previous === undefined || previous === current) return;
    reloadEvents.recordDebounced(workspace.id, reason, resolveTrigger(reason, trigger), debounceMs);
  };

  const scheduleReasonCheck = (reason: ReloadReason, trigger?: ReloadTrigger) => {
    if (closed) return;
    if (!fingerprintedReloadReasons.includes(reason)) return;
    if (trigger) lastNamedTrigger.set(reason, { trigger, at: Date.now() });

    const existing = pendingChecks.get(reason);
    if (existing) {
      clearTimeout(existing.timer);
    }

    const timer = setTimeout(() => {
      const pending = pendingChecks.get(reason);
      pendingChecks.delete(reason);
      void checkReason(reason, pending?.trigger ?? trigger);
    }, debounceMs);
    // Coalescing must not lose a named trigger: a triggerless directory-level
    // event arriving inside the debounce window previously overwrote the
    // pending file trigger with undefined (platform-dependent event order —
    // surfaced as a macOS-only CI flake in reload-events.e2e.test.ts).
    pendingChecks.set(reason, { timer, trigger: trigger ?? existing?.trigger });
  };

  const ensureOpencodeRootWatcher = () => {
    if (!existsSync(opencodeRoot)) {
      opencodeRootWatcher?.close();
      opencodeRootWatcher = null;
      return;
    }
    if (opencodeRootWatcher) return;

    try {
      opencodeRootWatcher = watch(
        opencodeRoot,
        { persistent: false },
        (_eventType, filename) => {
          const raw = filename ? filename.toString() : "";
          const name = raw.trim();
          if (!name) {
            const inferredConfigPath = existsSync(join(opencodeRoot, "opencode.jsonc"))
              ? join(opencodeRoot, "opencode.jsonc")
              : existsSync(join(opencodeRoot, "opencode.json"))
                ? join(opencodeRoot, "opencode.json")
                : null;
            scheduleReasonCheck("config", inferredConfigPath
              ? { type: "config", name: basename(inferredConfigPath), action: "updated", path: inferredConfigPath }
              : undefined);
            for (const tree of trees) tree.scheduleRescan();
            return;
          }

          if (name === "opencode.json" || name === "opencode.jsonc") {
            scheduleReasonCheck("config", {
              type: "config",
              name,
              action: "updated",
              path: join(opencodeRoot, name),
            });
            return;
          }

          if (name === "skills" || name === "commands" || name === "plugins" || name === "agents" || name === "agent") {
            for (const tree of trees) tree.scheduleRescan();
          }
        },
      );
      opencodeRootWatcher.on("error", (error) => {
        logger?.log("warn", "Reload watcher .opencode error", {
          workspaceId: workspace.id,
          workspacePath: root,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    } catch (error) {
      logger?.log("warn", "Reload watcher .opencode failed", {
        workspaceId: workspace.id,
        workspacePath: root,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  // Watch the workspace root for top-level config files.
  if (existsSync(root)) {
    try {
      rootWatcher = watch(
        root,
        { persistent: false },
        (_eventType, filename) => {
          const raw = filename ? filename.toString() : "";
          const name = raw.trim();
          if (!name) {
            // macOS fs.watch may omit the filename for directory events.
            // Infer the trigger like ensureOpencodeRootWatcher does so config
            // reload events keep their trigger {name, path} on macOS.
            const inferredConfigPath = existsSync(join(root, "opencode.jsonc"))
              ? join(root, "opencode.jsonc")
              : existsSync(join(root, "opencode.json"))
                ? join(root, "opencode.json")
                : null;
            scheduleReasonCheck("config", inferredConfigPath
              ? { type: "config", name: basename(inferredConfigPath), action: "updated", path: inferredConfigPath }
              : undefined);
            const agentsPath = join(root, "AGENTS.md");
            scheduleReasonCheck("agents", existsSync(agentsPath)
              ? { type: "agent", action: "updated", path: agentsPath }
              : undefined);
            for (const tree of trees) tree.scheduleRescan();
            return;
          }

          if (name === "opencode.json" || name === "opencode.jsonc") {
            scheduleReasonCheck("config", {
              type: "config",
              name,
              action: "updated",
              path: join(root, name),
            });
            return;
          }

          if (name === "AGENTS.md") {
            scheduleReasonCheck("agents", {
              type: "agent",
              action: "updated",
              path: join(root, name),
            });
            return;
          }

          // If .opencode is created/removed, rescan the relevant trees.
          if (name === ".opencode") {
            ensureOpencodeRootWatcher();
            scheduleReasonCheck("config");
            for (const tree of trees) tree.scheduleRescan();
          }
        },
      );
      rootWatcher.on("error", (error) => {
        logger?.log("warn", "Reload watcher root error", {
          workspaceId: workspace.id,
          workspacePath: root,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    } catch (error) {
      logger?.log("warn", "Reload watcher root failed", {
        workspaceId: workspace.id,
        workspacePath: root,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  ensureOpencodeRootWatcher();

  trees.push(
    createDirectoryTreeWatcher({
      rootDir: join(opencodeRoot, "skills"),
      workspace,
      reason: "skills",
      triggerType: "skill",
      logger,
      onChange: (trigger) => scheduleReasonCheck("skills", trigger),
    }),
  );
  trees.push(
    createDirectoryTreeWatcher({
      rootDir: join(opencodeRoot, "commands"),
      workspace,
      reason: "commands",
      triggerType: "command",
      logger,
      onChange: (trigger) => scheduleReasonCheck("commands", trigger),
    }),
  );
  trees.push(
    createDirectoryTreeWatcher({
      rootDir: join(opencodeRoot, "plugins"),
      workspace,
      reason: "plugins",
      triggerType: "plugin",
      logger,
      onChange: (trigger) => scheduleReasonCheck("plugins", trigger),
    }),
  );
  trees.push(
    createDirectoryTreeWatcher({
      rootDir: join(opencodeRoot, "agents"),
      workspace,
      reason: "agents",
      triggerType: "agent",
      logger,
      onChange: (trigger) => scheduleReasonCheck("agents", trigger),
    }),
  );
  trees.push(
    createDirectoryTreeWatcher({
      rootDir: join(opencodeRoot, "agent"),
      workspace,
      reason: "agents",
      triggerType: "agent",
      logger,
      onChange: (trigger) => scheduleReasonCheck("agents", trigger),
    }),
  );

  // Kick off an initial scan so we start watching existing trees.
  for (const tree of trees) {
    tree.scheduleRescan();
  }
  void refreshBaseline();

  return { close: closeAll, refreshBaseline };
}

function createDirectoryTreeWatcher(input: {
  rootDir: string;
  workspace: WorkspaceInfo;
  reason: ReloadReason;
  triggerType: ReloadTrigger["type"];
  logger: Logger | null;
  onChange: (trigger?: ReloadTrigger) => void;
}): DirectoryTreeWatcher {
  const { rootDir, workspace, reason, triggerType, logger, onChange } = input;
  const resolvedRoot = resolve(rootDir);

  const watchers = new Map<string, FSWatcher>();
  let closed = false;
  let scanTimer: ReturnType<typeof setTimeout> | null = null;
  let scanning = false;
  let rescanRequested = false;
  let lastRootExists = existsSync(resolvedRoot);

  const close = () => {
    if (closed) return;
    closed = true;
    if (scanTimer) {
      clearTimeout(scanTimer);
      scanTimer = null;
    }
    for (const watcher of watchers.values()) {
      try {
        watcher.close();
      } catch {
        // ignore
      }
    }
    watchers.clear();
  };

  const record = (path: string) => {
    const trigger: ReloadTrigger = {
      type: triggerType,
      action: "updated",
      path,
    };

    if (reason === "skills" || reason === "commands" || reason === "agents") {
      const rel = path.slice(resolvedRoot.length).replace(/^[/\\]+/, "");
      const name = rel.split(/[/\\]+/).filter(Boolean)[0] ?? "";
      if (name) {
        trigger.name = reason === "commands" ? name.replace(/\.md$/i, "") : name;
      }
    }

    onChange(trigger);
  };

  const shouldIgnoreEntry = (absPath: string) => {
    const base = basename(absPath);
    if (!base) return true;
    if (base === ".DS_Store" || base === "Thumbs.db") return true;
    if (base.startsWith(".") || base.endsWith("~") || base.endsWith(".tmp") || base.endsWith(".swp")) return true;
    return false;
  };

  const shouldRecordEntry = (absPath: string) => {
    if (shouldIgnoreEntry(absPath)) return false;
    const base = basename(absPath);
    if (triggerType === "skill") return /^SKILL\.md$/i.test(base);
    if (triggerType === "command") return /\.md$/i.test(base);
    if (triggerType === "agent") return /\.(md|json|jsonc)$/i.test(base);
    return true;
  };

  const shouldSkipDir = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return true;
    if (trimmed === ".git" || trimmed === "node_modules") return true;
    return false;
  };

  const ensureWatcher = (dir: string) => {
    if (watchers.has(dir)) return;
    try {
      const watcher = watch(
        dir,
        { persistent: false },
        (_eventType, filename) => {
          if (closed) return;
          const raw = filename ? filename.toString() : "";
          const name = raw.trim();
          const absPath = name ? join(dir, name) : dir;
          if (shouldRecordEntry(absPath)) {
            record(absPath);
          }
          scheduleRescan();
        },
      );
      watcher.on("error", (error) => {
        logger?.log("warn", "Reload watcher dir error", {
          workspaceId: workspace.id,
          reason,
          dir,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      watchers.set(dir, watcher);
    } catch (error) {
      logger?.log("warn", "Reload watcher dir failed", {
        workspaceId: workspace.id,
        reason,
        dir,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const scanDirs = async (): Promise<Set<string>> => {
    const dirs = new Set<string>();
    const stack = [resolvedRoot];
    while (stack.length) {
      const dir = stack.pop();
      if (!dir) continue;
      dirs.add(dir);
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (shouldSkipDir(entry.name)) continue;
        stack.push(join(dir, entry.name));
      }
    }
    return dirs;
  };

  const scan = async () => {
    if (closed) return;
    if (scanning) {
      rescanRequested = true;
      return;
    }
    scanning = true;
    try {
      const existsNow = existsSync(resolvedRoot);
      if (existsNow !== lastRootExists) {
        lastRootExists = existsNow;
        onChange({ type: triggerType, action: "updated", path: resolvedRoot });
      }
      if (!existsNow) {
        for (const watcher of watchers.values()) {
          try {
            watcher.close();
          } catch {
            // ignore
          }
        }
        watchers.clear();
        return;
      }

      const dirs = await scanDirs();
      for (const dir of dirs) {
        ensureWatcher(dir);
      }
      for (const dir of Array.from(watchers.keys())) {
        if (!dirs.has(dir)) {
          const watcher = watchers.get(dir);
          try {
            watcher?.close();
          } catch {
            // ignore
          }
          watchers.delete(dir);
        }
      }
    } finally {
      scanning = false;
      if (rescanRequested) {
        rescanRequested = false;
        scheduleRescan();
      }
    }
  };

  const scheduleRescan = () => {
    if (closed) return;
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      void scan();
    }, 200);
  };

  return { scheduleRescan, close };
}
