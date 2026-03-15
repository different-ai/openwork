import { ipcMain } from "electron";
import { existsSync, readFileSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";

import type { ScheduledJob } from "../../../../app/src/app/lib/desktop-contract";
import { IPC_CHANNELS } from "../ipc/channels";

type JobEntry = {
  job: ScheduledJob;
  jobFile: string;
};

function schedulerSupported() {
  return process.platform === "darwin" || process.platform === "linux";
}

function requireSchedulerSupport() {
  if (!schedulerSupported()) {
    throw new Error("Scheduler is supported only on macOS and Linux.");
  }
}

function legacyJobsDir() {
  return path.join(os.homedir(), ".config", "opencode", "jobs");
}

function schedulerScopesDir() {
  return path.join(os.homedir(), ".config", "opencode", "scheduler", "scopes");
}

function normalizePath(input: string) {
  const trimmed = input.trim();
  if (!trimmed) {
    return "";
  }
  try {
    return path.resolve(trimmed);
  } catch {
    return trimmed;
  }
}

function loadJobFile(filePath: string) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as ScheduledJob;
  } catch {
    return null;
  }
}

async function collectLegacyJobs(jobsDir: string) {
  const out: JobEntry[] = [];
  if (!existsSync(jobsDir)) {
    return out;
  }

  for (const entry of await readdir(jobsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    const jobFile = path.join(jobsDir, entry.name);
    const job = loadJobFile(jobFile);
    if (job) {
      out.push({ job, jobFile });
    }
  }
  return out;
}

async function collectScopedJobs(scopesDir: string) {
  const out: JobEntry[] = [];
  if (!existsSync(scopesDir)) {
    return out;
  }

  for (const scopeEntry of await readdir(scopesDir, { withFileTypes: true })) {
    if (!scopeEntry.isDirectory()) {
      continue;
    }
    const scopeId = scopeEntry.name;
    if (!scopeId) {
      continue;
    }

    const jobsDir = path.join(scopesDir, scopeId, "jobs");
    if (!existsSync(jobsDir)) {
      continue;
    }

    for (const jobEntry of await readdir(jobsDir, { withFileTypes: true })) {
      if (!jobEntry.isFile() || !jobEntry.name.endsWith(".json")) {
        continue;
      }
      const jobFile = path.join(jobsDir, jobEntry.name);
      const job = loadJobFile(jobFile);
      if (!job) {
        continue;
      }
      if (!job.scopeId) {
        job.scopeId = scopeId;
      }
      out.push({ job, jobFile });
    }
  }

  return out;
}

function slugify(name: string) {
  let out = "";
  let dash = false;
  for (const ch of name.trim().toLowerCase()) {
    if (/[a-z0-9]/.test(ch)) {
      out += ch;
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
  return (
    entries.find((entry) => {
      const job = entry.job;
      const jobName = job.name.toLowerCase();
      return (
        job.slug === trimmed ||
        job.slug === slug ||
        job.slug.endsWith(`-${slug}`) ||
        jobName === lower ||
        jobName.includes(lower)
      );
    }) ?? null
  );
}

async function collectJobsForScopeRoot(scopeRoot?: string) {
  const entries = [
    ...(await collectScopedJobs(schedulerScopesDir())),
    ...(await collectLegacyJobs(legacyJobsDir())),
  ];

  const filterRoot = scopeRoot ? normalizePath(scopeRoot) : "";
  const filtered = filterRoot
    ? entries.filter((entry) => entry.job.workdir && normalizePath(entry.job.workdir) === filterRoot)
    : entries;
  return filtered.sort((a, b) => a.job.name.toLowerCase().localeCompare(b.job.name.toLowerCase()));
}

function execBestEffort(command: string, args: string[]) {
  return new Promise<void>((resolve) => {
    execFile(command, args, { windowsHide: true }, () => resolve());
  });
}

async function uninstallJob(slug: string, scopeId?: string | null) {
  if (process.platform === "darwin") {
    const launchAgents = path.join(os.homedir(), "Library", "LaunchAgents");
    const plists = [
      ...(scopeId ? [path.join(launchAgents, `com.opencode.job.${scopeId}.${slug}.plist`)] : []),
      path.join(launchAgents, `com.opencode.job.${slug}.plist`),
    ];

    for (const plist of plists) {
      if (!existsSync(plist)) continue;
      await execBestEffort("launchctl", ["unload", plist]);
      await rm(plist, { force: true });
    }
    return;
  }

  const base = path.join(os.homedir(), ".config", "systemd", "user");
  const timerUnits = [
    ...(scopeId ? [`opencode-job-${scopeId}-${slug}.timer`] : []),
    `opencode-job-${slug}.timer`,
  ];
  for (const timerUnit of timerUnits) {
    await execBestEffort("systemctl", ["--user", "stop", timerUnit]);
    await execBestEffort("systemctl", ["--user", "disable", timerUnit]);
  }

  const files = [
    ...(scopeId
      ? [
          path.join(base, `opencode-job-${scopeId}-${slug}.service`),
          path.join(base, `opencode-job-${scopeId}-${slug}.timer`),
        ]
      : []),
    path.join(base, `opencode-job-${slug}.service`),
    path.join(base, `opencode-job-${slug}.timer`),
  ];
  for (const filePath of files) {
    if (existsSync(filePath)) {
      await rm(filePath, { force: true });
    }
  }
  await execBestEffort("systemctl", ["--user", "daemon-reload"]);
}

export function createSchedulerService() {
  return {
    async listJobs(input?: { scopeRoot?: string }) {
      requireSchedulerSupport();
      const entries = await collectJobsForScopeRoot(input?.scopeRoot);
      return entries.map((entry) => entry.job);
    },

    async deleteJob(input: { name: string; scopeRoot?: string }) {
      requireSchedulerSupport();
      const trimmed = input.name.trim();
      if (!trimmed) {
        throw new Error("name is required");
      }

      const entries = await collectJobsForScopeRoot(input.scopeRoot);
      const entry = findJobEntryByName(entries, trimmed);
      if (!entry) {
        throw new Error(`Job "${trimmed}" not found.`);
      }

      await uninstallJob(entry.job.slug, entry.job.scopeId);
      if (existsSync(entry.jobFile)) {
        await rm(entry.jobFile, { force: true });
      }

      const legacy = path.join(legacyJobsDir(), `${entry.job.slug}.json`);
      if (legacy !== entry.jobFile && existsSync(legacy)) {
        await rm(legacy, { force: true });
      }

      if (entry.job.scopeId) {
        const scoped = path.join(schedulerScopesDir(), entry.job.scopeId, "jobs", `${entry.job.slug}.json`);
        if (scoped !== entry.jobFile && existsSync(scoped)) {
          await rm(scoped, { force: true });
        }
      }

      return entry.job;
    },
  };
}

export type SchedulerService = ReturnType<typeof createSchedulerService>;

export function registerSchedulerIpc(service: SchedulerService) {
  ipcMain.handle(IPC_CHANNELS.scheduler("listJobs"), (_event, input?: { scopeRoot?: string }) => service.listJobs(input));
  ipcMain.handle(IPC_CHANNELS.scheduler("deleteJob"), (_event, input: { name: string; scopeRoot?: string }) =>
    service.deleteJob(input),
  );
}
