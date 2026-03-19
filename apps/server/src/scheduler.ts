import { readdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { ApiError } from "./errors.js";
import { exists, readJsonFile } from "./utils.js";

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
  if (SUPPORTED_PLATFORMS.has(process.platform)) return;
  throw new ApiError(400, "scheduler_unsupported", "Scheduler is supported only on macOS and Linux.");
}

function resolveHomeDir(): string {
  const home = homedir();
  if (!home) {
    throw new ApiError(500, "home_dir_missing", "Failed to resolve home directory");
  }
  return home;
}

function legacyJobsDir(): string {
  return join(resolveHomeDir(), ".config", "opencode", "jobs");
}

function schedulerScopesDir(): string {
  return join(resolveHomeDir(), ".config", "opencode", "scheduler", "scopes");
}

function legacyJobFilePath(slug: string): string {
  return join(legacyJobsDir(), `${slug}.json`);
}

function scopedJobFilePath(scopeId: string, slug: string): string {
  return join(schedulerScopesDir(), scopeId, "jobs", `${slug}.json`);
}

function normalizePathForCompare(value: string): string {
  const trimmed = value.trim();
  return trimmed ? resolve(trimmed) : "";
}

async function loadJobFile(path: string): Promise<ScheduledJob | null> {
  const job = await readJsonFile<Partial<ScheduledJob>>(path);
  if (!job || typeof job !== "object") return null;
  if (typeof job.slug !== "string" || typeof job.name !== "string" || typeof job.schedule !== "string") {
    return null;
  }
  return job as ScheduledJob;
}

async function loadLegacyJobEntries(): Promise<JobEntry[]> {
  const jobsDir = legacyJobsDir();
  if (!(await exists(jobsDir))) return [];
  const entries = await readdir(jobsDir, { withFileTypes: true });
  const jobs: JobEntry[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".json")) continue;
    const path = join(jobsDir, entry.name);
    const job = await loadJobFile(path);
    if (job) jobs.push({ job, jobFile: path });
  }
  return jobs;
}

async function loadScopedJobEntries(): Promise<JobEntry[]> {
  const scopes = schedulerScopesDir();
  if (!(await exists(scopes))) return [];
  const scopeEntries = await readdir(scopes, { withFileTypes: true });
  const jobs: JobEntry[] = [];
  for (const scopeEntry of scopeEntries) {
    if (!scopeEntry.isDirectory()) continue;
    const scopeId = scopeEntry.name;
    const jobsDir = join(scopes, scopeId, "jobs");
    if (!(await exists(jobsDir))) continue;
    const entries = await readdir(jobsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".json")) continue;
      const path = join(jobsDir, entry.name);
      const job = await loadJobFile(path);
      if (!job) continue;
      jobs.push({ job: { ...job, scopeId: job.scopeId ?? scopeId }, jobFile: path });
    }
  }
  return jobs;
}

async function loadAllJobEntries(): Promise<JobEntry[]> {
  const [scoped, legacy] = await Promise.all([loadScopedJobEntries(), loadLegacyJobEntries()]);
  return [...scoped, ...legacy];
}

function slugify(name: string): string {
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

function findJobEntryByName(entries: JobEntry[], name: string): JobEntry | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const slug = slugify(trimmed);
  const lower = trimmed.toLowerCase();
  return (
    entries.find((entry) =>
      entry.job.slug === trimmed ||
      entry.job.slug === slug ||
      entry.job.slug.endsWith(`-${slug}`) ||
      entry.job.name.toLowerCase() === lower ||
      entry.job.name.toLowerCase().includes(lower)
    ) ?? null
  );
}

function schedulerSystemPaths(job: ScheduledJob): string[] {
  const home = resolveHomeDir();
  const paths: string[] = [];

  if (process.platform === "darwin") {
    if (job.scopeId) {
      paths.push(join(home, "Library", "LaunchAgents", `com.opencode.job.${job.scopeId}.${job.slug}.plist`));
    }
    paths.push(join(home, "Library", "LaunchAgents", `com.opencode.job.${job.slug}.plist`));
    return paths;
  }

  if (process.platform === "linux") {
    const base = join(home, ".config", "systemd", "user");
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

async function uninstallJob(job: ScheduledJob): Promise<void> {
  if (process.platform === "darwin") {
    for (const plist of schedulerSystemPaths(job)) {
      if (!(await exists(plist))) continue;
      spawnSync("launchctl", ["unload", plist]);
      await rm(plist, { force: true });
    }
    return;
  }

  if (process.platform === "linux") {
    const slug = job.slug;
    const scopedTimerUnit = job.scopeId ? `opencode-job-${job.scopeId}-${slug}.timer` : null;
    const legacyTimerUnit = `opencode-job-${slug}.timer`;
    for (const unit of [scopedTimerUnit, legacyTimerUnit].filter(Boolean) as string[]) {
      spawnSync("systemctl", ["--user", "stop", unit]);
      spawnSync("systemctl", ["--user", "disable", unit]);
    }

    for (const p of schedulerSystemPaths(job)) {
      if (await exists(p)) {
        await rm(p, { force: true });
      }
    }

    spawnSync("systemctl", ["--user", "daemon-reload"]);
    return;
  }

  ensureSchedulerSupported();
}

export async function listScheduledJobs(workdir?: string): Promise<ScheduledJob[]> {
  ensureSchedulerSupported();
  const entries = await loadAllJobEntries();

  const filterRoot = typeof workdir === "string" && workdir.trim() ? normalizePathForCompare(workdir) : null;
  const jobs = entries
    .map((entry) => entry.job)
    .filter((job) => {
      if (!filterRoot) return true;
      if (!job.workdir) return false;
      return normalizePathForCompare(job.workdir) === filterRoot;
    });

  jobs.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  return jobs;
}

export async function resolveScheduledJob(
  name: string,
  workdir?: string
): Promise<{
  job: ScheduledJob;
  jobFile: string;
  systemPaths: string[];
}> {
  ensureSchedulerSupported();
  const trimmed = name.trim();
  if (!trimmed) {
    throw new ApiError(400, "job_name_required", "name is required");
  }

  const entries = await loadAllJobEntries();
  const filterRoot = typeof workdir === "string" && workdir.trim() ? normalizePathForCompare(workdir) : null;
  const filtered = filterRoot
    ? entries.filter((entry) => {
        const wd = entry.job.workdir;
        if (!wd) return false;
        return normalizePathForCompare(wd) === filterRoot;
      })
    : entries;

  const found = findJobEntryByName(filtered, trimmed);
  if (!found) {
    throw new ApiError(404, "job_not_found", `Job "${trimmed}" not found.`);
  }

  return {
    job: found.job,
    jobFile: found.jobFile,
    systemPaths: schedulerSystemPaths(found.job),
  };
}

export async function deleteScheduledJob(job: ScheduledJob, jobFile: string): Promise<void> {
  ensureSchedulerSupported();
  await uninstallJob(job);
  await rm(jobFile, { force: true });

  // Best-effort cleanup: if a legacy job file exists with the same slug, remove it.
  const legacy = legacyJobFilePath(job.slug);
  if (legacy !== jobFile && (await exists(legacy))) {
    await rm(legacy, { force: true });
  }
  // Best-effort cleanup: if a scoped job file exists with scopeId, remove it.
  if (job.scopeId) {
    const scoped = scopedJobFilePath(job.scopeId, job.slug);
    if (scoped !== jobFile && (await exists(scoped))) {
      await rm(scoped, { force: true });
    }
  }
}
