import { dirname, join } from "node:path";
import { appendFile, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import type { AuditEntry } from "./types.js";
import { ensureDir, exists } from "./utils.js";

function expandHome(value: string): string {
  if (value.startsWith("~/")) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

function resolveOpenworkDataDir(): string {
  const override = process.env.OPENWORK_DATA_DIR?.trim();
  if (override) return expandHome(override);
  return join(homedir(), ".openwork", "openwork-server");
}

export function auditLogPath(workspaceId: string): string {
  return join(resolveOpenworkDataDir(), "audit", `${workspaceId}.jsonl`);
}

export function legacyAuditLogPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".opencode", "openwork", "audit.jsonl");
}

async function resolveReadableAuditPath(workspaceRoot: string, workspaceId: string): Promise<string | null> {
  const primary = auditLogPath(workspaceId);
  if (await exists(primary)) return primary;
  const legacy = legacyAuditLogPath(workspaceRoot);
  if (await exists(legacy)) return legacy;
  return null;
}

export async function recordAudit(workspaceRoot: string, entry: AuditEntry): Promise<void> {
  const workspaceId = entry.workspaceId?.trim();
  if (!workspaceId) {
    const path = legacyAuditLogPath(workspaceRoot);
    await ensureDir(dirname(path));
    await appendFile(path, JSON.stringify(entry) + "\n", "utf8");
    return;
  }

  const path = auditLogPath(workspaceId);
  await ensureDir(dirname(path));
  await appendFile(path, JSON.stringify(entry) + "\n", "utf8");
}

export async function readLastAudit(workspaceRoot: string, workspaceId: string): Promise<AuditEntry | null> {
  const path = await resolveReadableAuditPath(workspaceRoot, workspaceId);
  if (!path) return null;
  const content = await readFile(path, "utf8");
  const lines = content.trim().split("\n");
  const last = lines[lines.length - 1];
  if (!last) return null;
  try {
    return JSON.parse(last) as AuditEntry;
  } catch {
    return null;
  }
}

export async function readAuditEntries(
  workspaceRoot: string,
  workspaceId: string,
  limit = 50,
): Promise<AuditEntry[]> {
  const path = await resolveReadableAuditPath(workspaceRoot, workspaceId);
  if (!path) return [];
  const content = await readFile(path, "utf8");
  const rawLines = content.trim().split("\n").filter(Boolean);
  if (!rawLines.length) return [];
  const slice = rawLines.slice(-Math.max(1, limit));
  const entries: AuditEntry[] = [];
  for (let i = slice.length - 1; i >= 0; i -= 1) {
    try {
      entries.push(JSON.parse(slice[i]) as AuditEntry);
    } catch {
      // ignore malformed entry
    }
  }
  return entries;
}
