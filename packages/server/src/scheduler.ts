import { readdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

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

function opencodeJobsDir(): string {
  return join(resolveHomeDir(), ".config", "opencode", "jobs");
}

function jobFilePath(jobsDir: string, slug: string): string {
  return join(jobsDir, `${slug}.json`);
}

async function loadJobFile(path: string): Promise<ScheduledJob | null> {
  const job = await readJsonFile<Partial<ScheduledJob>>(path);
  if (!job || typeof job !== "object") return null;
  if (typeof job.slug !== "string" || typeof job.name !== "string" || typeof job.schedule !== "string") {
    return null;
  }
  return job as ScheduledJob;
}

async function loadJobBySlug(jobsDir: string, slug: string): Promise<ScheduledJob | null> {
  const trimmed = slug.trim();
  if (!trimmed) return null;
  const path = jobFilePath(jobsDir, trimmed);
  if (!(await exists(path))) return null;
  return loadJobFile(path);
}

async function loadAllJobs(jobsDir: string): Promise<ScheduledJob[]> {
  if (!(await exists(jobsDir))) return [];
  const entries = await readdir(jobsDir, { withFileTypes: true });
  const jobs: ScheduledJob[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".json")) continue;
    const path = join(jobsDir, entry.name);
    const job = await loadJobFile(path);
    if (job) jobs.push(job);
  }
  jobs.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  return jobs;
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

async function findJobByName(jobsDir: string, name: string): Promise<ScheduledJob | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const slug = slugify(trimmed);
  let job = await loadJobBySlug(jobsDir, slug);
  if (!job && slug !== trimmed) {
    job = await loadJobBySlug(jobsDir, trimmed);
  }
  if (job) return job;
  const all = await loadAllJobs(jobsDir);
  const lower = trimmed.toLowerCase();
  return (
    all.find((entry) =>
      entry.slug === trimmed ||
      entry.slug.endsWith(`-${slug}`) ||
      entry.name.toLowerCase() === lower ||
      entry.name.toLowerCase().includes(lower)
    ) ?? null
  );
}

function schedulerSystemPaths(slug: string): string[] {
  if (process.platform === "darwin") {
    return [join(resolveHomeDir(), "Library", "LaunchAgents", `com.opencode.job.${slug}.plist`)];
  }
  if (process.platform === "linux") {
    const base = join(resolveHomeDir(), ".config", "systemd", "user");
    return [
      join(base, `opencode-job-${slug}.service`),
      join(base, `opencode-job-${slug}.timer`),
    ];
  }
  return [];
}

async function uninstallJob(slug: string): Promise<void> {
  if (process.platform === "darwin") {
    const [plist] = schedulerSystemPaths(slug);
    if (plist && (await exists(plist))) {
      spawnSync("launchctl", ["unload", plist]);
      await rm(plist, { force: true });
    }
    return;
  }

  if (process.platform === "linux") {
    const [service, timer] = schedulerSystemPaths(slug);
    const timerUnit = `opencode-job-${slug}.timer`;
    spawnSync("systemctl", ["--user", "stop", timerUnit]);
    spawnSync("systemctl", ["--user", "disable", timerUnit]);

    if (service && (await exists(service))) {
      await rm(service, { force: true });
    }
    if (timer && (await exists(timer))) {
      await rm(timer, { force: true });
    }

    spawnSync("systemctl", ["--user", "daemon-reload"]);
    return;
  }

  ensureSchedulerSupported();
}

export async function listScheduledJobs(): Promise<ScheduledJob[]> {
  ensureSchedulerSupported();
  const jobsDir = opencodeJobsDir();
  return loadAllJobs(jobsDir);
}

export async function resolveScheduledJob(name: string): Promise<{
  job: ScheduledJob;
  jobFile: string;
  systemPaths: string[];
}> {
  ensureSchedulerSupported();
  const trimmed = name.trim();
  if (!trimmed) {
    throw new ApiError(400, "job_name_required", "name is required");
  }
  const jobsDir = opencodeJobsDir();
  const job = await findJobByName(jobsDir, trimmed);
  if (!job) {
    throw new ApiError(404, "job_not_found", `Job "${trimmed}" not found.`);
  }
  return {
    job,
    jobFile: jobFilePath(jobsDir, job.slug),
    systemPaths: schedulerSystemPaths(job.slug),
  };
}

export async function deleteScheduledJob(job: ScheduledJob): Promise<void> {
  ensureSchedulerSupported();
  const jobsDir = opencodeJobsDir();
  await uninstallJob(job.slug);
  await rm(jobFilePath(jobsDir, job.slug), { force: true });
}
