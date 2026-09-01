import { appendFile, chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface LedgerEntry {
  kind: string;
  id: string;
  label?: string;
  match?: string;
  retain?: boolean;
  at: string;
}

export const LEDGER_ENV = "OPENWORK_WORLD_LEDGER";

export function ledgerPath(snapshotDirectory: string, receiptName: string): string {
  return join(snapshotDirectory, `${receiptName}.ledger.jsonl`);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ENOENT";
}

function parseEntry(line: string): LedgerEntry | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || !("kind" in value)
    || typeof value.kind !== "string"
    || !("id" in value)
    || typeof value.id !== "string"
    || !("at" in value)
    || typeof value.at !== "string"
  ) {
    return undefined;
  }
  const label = "label" in value ? value.label : undefined;
  const match = "match" in value ? value.match : undefined;
  const retain = "retain" in value ? value.retain : undefined;
  if (
    (label !== undefined && typeof label !== "string")
    || (match !== undefined && typeof match !== "string")
    || (retain !== undefined && typeof retain !== "boolean")
  ) return undefined;
  return {
    kind: value.kind,
    id: value.id,
    ...(typeof label === "string" ? { label } : {}),
    ...(typeof match === "string" ? { match } : {}),
    ...(typeof retain === "boolean" ? { retain } : {}),
    at: value.at,
  };
}

export async function appendLedgerEntry(
  path: string,
  entry: Omit<LedgerEntry, "at">,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const recorded: LedgerEntry = { ...entry, at: new Date().toISOString() };
  await appendFile(path, `${JSON.stringify(recorded)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

export async function readLedger(path: string): Promise<LedgerEntry[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
  const entries = new Map<string, LedgerEntry>();
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    const entry = parseEntry(line);
    if (!entry) continue;
    const key = `${entry.kind}\u0000${entry.id}`;
    entries.delete(key);
    entries.set(key, entry);
  }
  return [...entries.values()];
}

export async function rewriteLedger(path: string, entries: LedgerEntry[]): Promise<void> {
  if (entries.length === 0) {
    try {
      await unlink(path);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(path, 0o600);
}

export async function trackResource(entry: Omit<LedgerEntry, "at">): Promise<void> {
  const path = process.env[LEDGER_ENV];
  if (path === undefined) return;
  await appendLedgerEntry(path, entry);
}
