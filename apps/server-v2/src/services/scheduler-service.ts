import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { RouteError } from "../http.js";
import type { WorkspaceRegistryService } from "./workspace-registry-service.js";

export type ScheduledJobRun = {
  prompt?: string;
  command?: string;
  arguments?: string;
  files?: string[];
  agent?: string;
  model?: string;
  variant?: string;
  title?: string;
  share?: boolean;
  continue?: boolean;
  session?: string;
  runFormat?: string;
  attachUrl?: string;
  port?: number;
};

export type ScheduledJob = {
  scopeId?: string;
  timeoutSeconds?: number;
  invocation?: { command: string; args: string[] };
  slug: string;
  name: string;
  schedule: string;
  prompt?: string;
  attachUrl?: string;
  run?: ScheduledJobRun;
  source?: string;
  workdir?: string;
  createdAt: string;
  updatedAt?: string;
  lastRunAt?: string;
  lastRunExitCode?: number;
  lastRunError?: string;
  lastRunSource?: string;
  lastRunStatus?: string;
};

type JobEntry = {
  job: ScheduledJob;
  jobFile: string;
};

const SUPPORTED_PLATFORMS = new Set(["darwin", "linux"]);

function ensureSchedulerSupported() {
  if (SUPPORTED_PLATFORMS.has(process.platform)) {
    return;
  }
  throw new RouteError(501, "not_implemented", "Scheduler is supported only on macOS and Linux.");
}

function normalizePathForCompare(value: string) {
  const trimmed = value.trim();
  return trimmed ? resolve(trimmed) : "";
}

function slugify(name: string) {
  let out = "";
  let dash = false;
  for (const char of name.trim().toLowerCase()) {
    if (/[a-z0-9]/.test(char)) {
      out += char;
      dash = false;
      continue;
    }
    if (!dash) {
      out += "-";
      dash = true;
    }
  }
  return out.replace(/^-+|-+$/g, "");
}

function findJobEntryByName(entries: JobEntry[], name: string) {
  const trimmed = name.trim();
  if (!trimmed) {
    return null;
  }
  const slug = slugify(trimmed);
  const lower = trimmed.toLowerCase();
  return entries.find((entry) =>
    entry.job.slug === trimmed
    || entry.job.slug === slug
    || entry.job.slug.endsWith(`-${slug}`)
    || entry.job.name.toLowerCase() === lower
    || entry.job.name.toLowerCase().includes(lower),
  ) ?? null;
}

function schedulerSystemPaths(job: ScheduledJob, homeDir: string) {
  const paths: string[] = [];
  if (process.platform === "darwin") {
    if (job.scopeId) {
      paths.push(join(homeDir, "Library", "LaunchAgents", `com.opencode.job.${job.scopeId}.${job.slug}.plist`));
    }
    paths.push(join(homeDir, "Library", "LaunchAgents", `com.opencode.job.${job.slug}.plist`));
    return paths;
  }

  if (process.platform === "linux") {
    const base = join(homeDir, ".config", "systemd", "user");
    if (job.scopeId) {
      paths.push(join(base, `opencode-job-${job.scopeId}-${job.slug}.service`));
      paths.push(join(base, `opencode-job-${job.scopeId}-${job.slug}.timer`));
    }
    paths.push(join(base, `opencode-job-${job.slug}.service`));
    paths.push(join(base, `opencode-job-${job.slug}.timer`));
    return paths;
  }

  return paths;
}

async function loadJobFile(path: string) {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return null;
  }
  const parsed = await file.json().catch(() => null);
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  if (typeof (parsed as any).slug !== "string" || typeof (parsed as any).name !== "string" || typeof (parsed as any).schedule !== "string") {
    return null;
  }
  return parsed as ScheduledJob;
}

export type SchedulerService = ReturnType<typeof createSchedulerService>;

export function createSchedulerService(input: {
  workspaceRegistry: WorkspaceRegistryService;
  homeDir?: string;
}) {
  const resolvedHomeDir = (input.homeDir ?? process.env.HOME ?? homedir()).trim();

  function requireHomeDir() {
    if (!resolvedHomeDir) {
      throw new RouteError(500, "internal_error", "Failed to resolve home directory.");
    }
    return resolvedHomeDir;
  }

  function legacyJobsDir() {
    return join(requireHomeDir(), ".config", "opencode", "jobs");
  }

  function schedulerScopesDir() {
    return join(requireHomeDir(), ".config", "opencode", "scheduler", "scopes");
  }

  function legacyJobFilePath(slug: string) {
    return join(legacyJobsDir(), `${slug}.json`);
  }

  function scopedJobFilePath(scopeId: string, slug: string) {
    return join(schedulerScopesDir(), scopeId, "jobs", `${slug}.json`);
  }

  async function loadLegacyJobEntries() {
    const jobsDir = legacyJobsDir();
    if (!existsSync(jobsDir)) {
      return [] as JobEntry[];
    }
    const entries = await readdir(jobsDir, { withFileTypes: true });
    const jobs: JobEntry[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }
      const jobFile = join(jobsDir, entry.name);
      const job = await loadJobFile(jobFile);
      if (job) {
        jobs.push({ job, jobFile });
      }
    }
    return jobs;
  }

  async function loadScopedJobEntries() {
    const scopesDir = schedulerScopesDir();
    if (!existsSync(scopesDir)) {
      return [] as JobEntry[];
    }
    const scopeEntries = await readdir(scopesDir, { withFileTypes: true });
    const jobs: JobEntry[] = [];
    for (const scopeEntry of scopeEntries) {
      if (!scopeEntry.isDirectory()) {
        continue;
      }
      const scopeId = scopeEntry.name;
      const jobsDir = join(scopesDir, scopeId, "jobs");
      if (!existsSync(jobsDir)) {
        continue;
      }
      const entries = await readdir(jobsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) {
          continue;
        }
        const jobFile = join(jobsDir, entry.name);
        const job = await loadJobFile(jobFile);
        if (!job) {
          continue;
        }
        jobs.push({ job: { ...job, scopeId: job.scopeId ?? scopeId }, jobFile });
      }
    }
    return jobs;
  }

  async function loadAllJobEntries() {
    const [scoped, legacy] = await Promise.all([loadScopedJobEntries(), loadLegacyJobEntries()]);
    return [...scoped, ...legacy];
  }

  function requireLocalWorkspaceDataDir(workspaceId: string) {
    const workspace = input.workspaceRegistry.getById(workspaceId, { includeHidden: true });
    if (!workspace) {
      throw new RouteError(404, "not_found", `Workspace not found: ${workspaceId}`);
    }
    if (workspace.backend.kind !== "local_opencode") {
      throw new RouteError(501, "not_implemented", `Scheduler jobs are not supported for ${workspace.backend.kind} workspaces.`);
    }
    const dataDir = workspace.backend.local?.dataDir?.trim() ?? "";
    if (!dataDir) {
      throw new RouteError(400, "invalid_request", `Workspace ${workspace.id} does not have a local data directory.`);
    }
    return dataDir;
  }

  async function uninstallJob(job: ScheduledJob) {
    const homeDir = requireHomeDir();
    if (process.platform === "darwin") {
      for (const plist of schedulerSystemPaths(job, homeDir)) {
        if (!(await Bun.file(plist).exists())) {
          continue;
        }
        spawnSync("launchctl", ["unload", plist]);
        await rm(plist, { force: true });
      }
      return;
    }

    if (process.platform === "linux") {
      const timerUnits = [
        job.scopeId ? `opencode-job-${job.scopeId}-${job.slug}.timer` : null,
        `opencode-job-${job.slug}.timer`,
      ].filter(Boolean) as string[];
      for (const unit of timerUnits) {
        spawnSync("systemctl", ["--user", "stop", unit]);
        spawnSync("systemctl", ["--user", "disable", unit]);
      }
      for (const filePath of schedulerSystemPaths(job, homeDir)) {
        if (await Bun.file(filePath).exists()) {
          await rm(filePath, { force: true });
        }
      }
      spawnSync("systemctl", ["--user", "daemon-reload"]);
      return;
    }

    ensureSchedulerSupported();
  }

  return {
    async listWorkspaceJobs(workspaceId: string) {
      ensureSchedulerSupported();
      const workdir = requireLocalWorkspaceDataDir(workspaceId);
      const normalizedRoot = normalizePathForCompare(workdir);
      const entries = await loadAllJobEntries();
      const jobs = entries
        .map((entry) => entry.job)
        .filter((job) => {
          const jobWorkdir = job.workdir?.trim() ?? "";
          return jobWorkdir ? normalizePathForCompare(jobWorkdir) === normalizedRoot : false;
        });
      jobs.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
      return { items: jobs };
    },

    async deleteWorkspaceJob(workspaceId: string, name: string) {
      ensureSchedulerSupported();
      const workdir = requireLocalWorkspaceDataDir(workspaceId);
      const normalizedRoot = normalizePathForCompare(workdir);
      const trimmed = name.trim();
      if (!trimmed) {
        throw new RouteError(400, "invalid_request", "name is required");
      }
      const entries = (await loadAllJobEntries()).filter((entry) => {
        const jobWorkdir = entry.job.workdir?.trim() ?? "";
        return jobWorkdir ? normalizePathForCompare(jobWorkdir) === normalizedRoot : false;
      });
      const found = findJobEntryByName(entries, trimmed);
      if (!found) {
        throw new RouteError(404, "not_found", `Job "${trimmed}" not found.`);
      }
      await uninstallJob(found.job);
      await rm(found.jobFile, { force: true });
      const legacyJobPath = legacyJobFilePath(found.job.slug);
      if (legacyJobPath !== found.jobFile && await Bun.file(legacyJobPath).exists()) {
        await rm(legacyJobPath, { force: true });
      }
      if (found.job.scopeId) {
        const scopedJobPath = scopedJobFilePath(found.job.scopeId, found.job.slug);
        if (scopedJobPath !== found.jobFile && await Bun.file(scopedJobPath).exists()) {
          await rm(scopedJobPath, { force: true });
        }
      }
      return { job: found.job };
    },
  };
}
