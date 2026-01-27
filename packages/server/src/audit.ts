import { dirname, join } from "node:path";
import { appendFile, readFile } from "node:fs/promises";
import type { AuditEntry } from "./types.js";
import { ensureDir, exists } from "./utils.js";

export function auditLogPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".opencode", "openwork", "audit.jsonl");
}

export async function recordAudit(workspaceRoot: string, entry: AuditEntry): Promise<void> {
  const path = auditLogPath(workspaceRoot);
  await ensureDir(dirname(path));
  await appendFile(path, JSON.stringify(entry) + "\n", "utf8");
}

export async function readLastAudit(workspaceRoot: string): Promise<AuditEntry | null> {
  const path = auditLogPath(workspaceRoot);
  if (!(await exists(path))) return null;
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
