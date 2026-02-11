import { existsSync, watch, type FSWatcher } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import type { ReloadEventStore } from "./events.js";
import type { ReloadReason, ReloadTrigger, ServerConfig, WorkspaceInfo } from "./types.js";

type LogLevel = "info" | "warn" | "error";

type Logger = {
  log: (level: LogLevel, message: string, attributes?: Record<string, unknown>) => void;
};

type DirectoryTreeWatcher = {
  scheduleRescan: () => void;
  close: () => void;
};

export function startReloadWatchers(input: {
  config: ServerConfig;
  reloadEvents: ReloadEventStore;
  logger?: Logger | null;
  debounceMs?: number;
}): { close: () => void } {
  const { config, reloadEvents } = input;
  const logger = input.logger ?? null;
  const debounceMs = typeof input.debounceMs === "number" ? input.debounceMs : 750;

  const closers: Array<() => void> = [];

  for (const workspace of config.workspaces) {
    try {
      closers.push(
        startWorkspaceReloadWatcher({ workspace, reloadEvents, logger, debounceMs }),
      );
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
      for (const close of closers) {
        try {
          close();
        } catch {
          // ignore
        }
      }
    },
  };
}

function startWorkspaceReloadWatcher(input: {
  workspace: WorkspaceInfo;
  reloadEvents: ReloadEventStore;
  logger: Logger | null;
  debounceMs: number;
}): () => void {
  const { workspace, reloadEvents, logger, debounceMs } = input;
  const root = resolve(workspace.path);

  const trees: DirectoryTreeWatcher[] = [];
  const closeAll = () => {
    for (const tree of trees) {
      tree.close();
    }
    rootWatcher?.close();
  };

  const record = (reason: ReloadReason, trigger?: ReloadTrigger) => {
    reloadEvents.recordDebounced(workspace.id, reason, trigger, debounceMs);
  };

  // Watch the workspace root for top-level config files.
  let rootWatcher: FSWatcher | null = null;
  if (existsSync(root)) {
    try {
      rootWatcher = watch(
        root,
        { persistent: false },
        (_eventType, filename) => {
          const raw = filename ? filename.toString() : "";
          const name = raw.trim();
          if (!name) {
            for (const tree of trees) tree.scheduleRescan();
            return;
          }

          if (name === "opencode.json" || name === "opencode.jsonc") {
            record("config", {
              type: "config",
              name,
              action: "updated",
              path: join(root, name),
            });
            return;
          }

          if (name === "AGENTS.md") {
            record("agents", {
              type: "agent",
              action: "updated",
              path: join(root, name),
            });
            return;
          }

          // If .opencode is created/removed, rescan the relevant trees.
          if (name === ".opencode") {
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

  const opencodeRoot = join(root, ".opencode");

  trees.push(
    createDirectoryTreeWatcher({
      rootDir: join(opencodeRoot, "skills"),
      workspace,
      reloadEvents,
      reason: "skills",
      triggerType: "skill",
      debounceMs,
      logger,
    }),
  );
  trees.push(
    createDirectoryTreeWatcher({
      rootDir: join(opencodeRoot, "commands"),
      workspace,
      reloadEvents,
      reason: "commands",
      triggerType: "command",
      debounceMs,
      logger,
    }),
  );
  trees.push(
    createDirectoryTreeWatcher({
      rootDir: join(opencodeRoot, "plugins"),
      workspace,
      reloadEvents,
      reason: "plugins",
      triggerType: "plugin",
      debounceMs,
      logger,
    }),
  );
  trees.push(
    createDirectoryTreeWatcher({
      rootDir: join(opencodeRoot, "agents"),
      workspace,
      reloadEvents,
      reason: "agents",
      triggerType: "agent",
      debounceMs,
      logger,
    }),
  );
  trees.push(
    createDirectoryTreeWatcher({
      rootDir: join(opencodeRoot, "agent"),
      workspace,
      reloadEvents,
      reason: "agents",
      triggerType: "agent",
      debounceMs,
      logger,
    }),
  );

  // Kick off an initial scan so we start watching existing trees.
  for (const tree of trees) {
    tree.scheduleRescan();
  }

  return closeAll;
}

function createDirectoryTreeWatcher(input: {
  rootDir: string;
  workspace: WorkspaceInfo;
  reloadEvents: ReloadEventStore;
  reason: ReloadReason;
  triggerType: ReloadTrigger["type"];
  debounceMs: number;
  logger: Logger | null;
}): DirectoryTreeWatcher {
  const { rootDir, workspace, reloadEvents, reason, triggerType, debounceMs, logger } = input;
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

    reloadEvents.recordDebounced(workspace.id, reason, trigger, debounceMs);
  };

  const shouldIgnoreEntry = (absPath: string) => {
    const base = basename(absPath);
    if (!base) return true;
    if (base === ".DS_Store" || base === "Thumbs.db") return true;
    return false;
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
          if (!shouldIgnoreEntry(absPath)) {
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
        reloadEvents.recordDebounced(workspace.id, reason, { type: triggerType, action: "updated", path: resolvedRoot }, debounceMs);
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
