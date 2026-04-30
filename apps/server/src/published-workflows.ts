import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { readFile, writeFile } from "node:fs/promises";

import type { ServerConfig } from "./types.js";
import { ensureDir, exists, hashToken, shortId } from "./utils.js";

export type PublishedWorkflowInputSchema = {
  type: "object";
  properties?: Record<string, { type: string; description?: string }>;
  required?: string[];
};

export type PublishedWorkflowRecord = {
  id: string;
  tokenHash: string;
  workspaceId: string;
  skillName: string;
  toolName: string;
  description: string;
  agent?: string;
  inputSchema?: PublishedWorkflowInputSchema;
  label?: string;
  createdAt: number;
};

export type PublishedWorkflowPublic = Omit<PublishedWorkflowRecord, "tokenHash">;

type StoreFile = {
  schemaVersion: number;
  updatedAt: number;
  workflows: PublishedWorkflowRecord[];
};

function resolveStorePath(config: ServerConfig): string {
  const override = (process.env.OPENWORK_PUBLISHED_WORKFLOWS_STORE ?? "").trim();
  if (override) return resolve(override);

  const configPath = config.configPath?.trim();
  const configDir = configPath ? dirname(configPath) : join(homedir(), ".config", "openwork");
  return join(configDir, "published-workflows.json");
}

function isInputSchema(value: unknown): value is PublishedWorkflowInputSchema {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { type?: unknown };
  return candidate.type === "object";
}

async function readStore(path: string): Promise<StoreFile> {
  if (!(await exists(path))) {
    return { schemaVersion: 1, updatedAt: Date.now(), workflows: [] };
  }
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<StoreFile>;
    const workflows = Array.isArray(parsed.workflows)
      ? parsed.workflows
        .map((entry) => {
          const record = entry as Partial<PublishedWorkflowRecord>;
          const id = typeof record.id === "string" ? record.id : "";
          const tokenHash = typeof record.tokenHash === "string" ? record.tokenHash : "";
          const workspaceId = typeof record.workspaceId === "string" ? record.workspaceId : "";
          const skillName = typeof record.skillName === "string" ? record.skillName : "";
          const toolName = typeof record.toolName === "string" ? record.toolName : skillName;
          const description = typeof record.description === "string" ? record.description : "";
          const createdAt = typeof record.createdAt === "number" ? record.createdAt : Date.now();
          if (!id || !tokenHash || !workspaceId || !skillName || !toolName) return null;
          const out: PublishedWorkflowRecord = {
            id, tokenHash, workspaceId, skillName, toolName, description, createdAt,
            ...(typeof record.agent === "string" && record.agent ? { agent: record.agent } : {}),
            ...(typeof record.label === "string" && record.label ? { label: record.label } : {}),
            ...(isInputSchema(record.inputSchema) ? { inputSchema: record.inputSchema } : {}),
          };
          return out;
        })
        .filter((entry): entry is PublishedWorkflowRecord => Boolean(entry))
      : [];
    return {
      schemaVersion: typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : 1,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
      workflows,
    };
  } catch {
    return { schemaVersion: 1, updatedAt: Date.now(), workflows: [] };
  }
}

async function writeStore(path: string, workflows: PublishedWorkflowRecord[]): Promise<void> {
  await ensureDir(dirname(path));
  const payload: StoreFile = { schemaVersion: 1, updatedAt: Date.now(), workflows };
  await writeFile(path, JSON.stringify(payload, null, 2) + "\n", "utf8");
}

function publicView(record: PublishedWorkflowRecord): PublishedWorkflowPublic {
  const { tokenHash: _hash, ...rest } = record;
  return rest;
}

export type CreatePublishedWorkflowInput = {
  workspaceId: string;
  skillName: string;
  toolName: string;
  description: string;
  agent?: string;
  inputSchema?: PublishedWorkflowInputSchema;
  label?: string;
};

export type CreatedPublishedWorkflow = PublishedWorkflowPublic & { token: string };

export class PublishedWorkflowsService {
  private path: string;
  private loaded = false;
  private workflows: PublishedWorkflowRecord[] = [];
  private byHash = new Map<string, PublishedWorkflowRecord>();

  constructor(config: ServerConfig) {
    this.path = resolveStorePath(config);
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    const store = await readStore(this.path);
    this.workflows = store.workflows;
    this.byHash = new Map(store.workflows.map((entry) => [entry.tokenHash, entry]));
    this.loaded = true;
  }

  async list(workspaceId?: string): Promise<PublishedWorkflowPublic[]> {
    await this.ensureLoaded();
    const filtered = workspaceId
      ? this.workflows.filter((entry) => entry.workspaceId === workspaceId)
      : this.workflows;
    return filtered.map(publicView);
  }

  async get(id: string): Promise<PublishedWorkflowPublic | null> {
    await this.ensureLoaded();
    const found = this.workflows.find((entry) => entry.id === id);
    return found ? publicView(found) : null;
  }

  async create(input: CreatePublishedWorkflowInput): Promise<CreatedPublishedWorkflow> {
    await this.ensureLoaded();
    const id = shortId();
    const token = `pwt_${shortId().replace(/-/g, "")}${shortId().replace(/-/g, "")}`;
    const createdAt = Date.now();
    const record: PublishedWorkflowRecord = {
      id,
      tokenHash: hashToken(token),
      workspaceId: input.workspaceId,
      skillName: input.skillName,
      toolName: input.toolName,
      description: input.description,
      createdAt,
      ...(input.agent ? { agent: input.agent } : {}),
      ...(input.inputSchema ? { inputSchema: input.inputSchema } : {}),
      ...(input.label ? { label: input.label } : {}),
    };
    this.workflows = [record, ...this.workflows];
    this.byHash.set(record.tokenHash, record);
    await writeStore(this.path, this.workflows);
    return { ...publicView(record), token };
  }

  async revoke(id: string): Promise<boolean> {
    await this.ensureLoaded();
    const index = this.workflows.findIndex((entry) => entry.id === id);
    if (index === -1) return false;
    const [removed] = this.workflows.splice(index, 1);
    if (removed) this.byHash.delete(removed.tokenHash);
    await writeStore(this.path, this.workflows);
    return true;
  }

  async findByToken(token: string): Promise<PublishedWorkflowRecord | null> {
    const trimmed = token.trim();
    if (!trimmed) return null;
    await this.ensureLoaded();
    return this.byHash.get(hashToken(trimmed)) ?? null;
  }
}
