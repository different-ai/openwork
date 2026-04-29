import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { sanitizeOpenworkTemplateConfig } from "./blueprint-sessions.js";
import { buildCommandContent } from "./commands.js";
import { ApiError } from "./errors.js";
import { parseFrontmatter } from "./frontmatter.js";
import { readJsoncFile } from "./jsonc.js";
import { planPortableFiles, listPortableFilePaths, type PortableFile } from "./portable-files.js";
import { sanitizePortableOpencodeConfig } from "./portable-opencode.js";
import { buildSkillContent } from "./skills.js";
import { exists } from "./utils.js";
import { sanitizeCommandName, validateCommandName, validateSkillName } from "./validators.js";
import {
  opencodeConfigPath,
  openworkConfigPath,
  projectCommandsDir,
  projectSkillsDir,
} from "./workspace-files.js";

export type WorkspaceImportMode = "merge" | "replace";
export type WorkspaceImportChangeKind = "opencode" | "openwork" | "skill" | "command" | "file";
export type WorkspaceImportChangeAction = "create" | "update" | "replace" | "delete" | "unchanged";

export type WorkspaceImportChange = {
  kind: WorkspaceImportChangeKind;
  action: WorkspaceImportChangeAction;
  label: string;
  path: string;
};

type WorkspaceImportPlannedChange = WorkspaceImportChange & {
  absolutePath: string;
  beforeDigest: string;
  afterDigest: string;
};

export type WorkspaceImportPreview = {
  fingerprint: string;
  summary: {
    total: number;
    create: number;
    update: number;
    replace: number;
    delete: number;
    unchanged: number;
  };
  changes: WorkspaceImportChange[];
};

export type WorkspaceImportPlan = Omit<WorkspaceImportPreview, "changes"> & {
  changes: WorkspaceImportPlannedChange[];
};

type WorkspaceImportSection = "opencode" | "openwork" | "skills" | "commands" | "files";

export type NormalizedWorkspaceImport = {
  modes: Record<string, WorkspaceImportMode>;
  sections: Record<WorkspaceImportSection, boolean>;
  opencode?: Record<string, unknown>;
  openwork?: Record<string, unknown>;
  skills: Array<{ name: string; content: string; description?: string }>;
  commands: Array<{
    name: string;
    template: string;
    description?: string;
    agent?: string;
    model?: string | null;
    subtask?: boolean;
  }>;
  files: PortableFile[];
};

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readMode(value: unknown): WorkspaceImportMode {
  return value === "replace" ? "replace" : "merge";
}

function normalizeModes(value: unknown): Record<string, WorkspaceImportMode> {
  const record = readRecord(value) ?? {};
  return {
    opencode: readMode(record.opencode),
    openwork: readMode(record.openwork),
    skills: readMode(record.skills),
    commands: readMode(record.commands),
    files: readMode(record.files),
  };
}

function readArray(value: unknown, label: string): Record<string, unknown>[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ApiError(400, "invalid_workspace_import_payload", `${label} must be an array`);
  }
  return value.map((item, index) => {
    const record = readRecord(item);
    if (!record) {
      throw new ApiError(400, "invalid_workspace_import_payload", `${label}[${index}] must be an object`);
    }
    return record;
  });
}

function normalizeSkills(value: unknown): NormalizedWorkspaceImport["skills"] {
  return readArray(value, "skills").map((skill) => {
    const name = String(skill.name ?? "").trim();
    const content = typeof skill.content === "string" ? skill.content : "";
    validateSkillName(name);
    if (!content) {
      throw new ApiError(400, "invalid_skill_content", "Skill content is required");
    }
    return {
      name,
      content,
      description: typeof skill.description === "string" ? skill.description : undefined,
    };
  });
}

function normalizeCommands(value: unknown): NormalizedWorkspaceImport["commands"] {
  return readArray(value, "commands").map((command) => {
    if (typeof command.content === "string" && command.content.trim()) {
      const parsed = parseFrontmatter(command.content);
      const name = sanitizeCommandName(
        String(command.name || (typeof parsed.data.name === "string" ? parsed.data.name : "")),
      );
      validateCommandName(name);
      const template = parsed.body.trim();
      if (!template) {
        throw new ApiError(400, "invalid_command_template", "Command template is required");
      }
      return {
        name,
        template,
        description:
          typeof command.description === "string"
            ? command.description
            : typeof parsed.data.description === "string"
              ? parsed.data.description
              : undefined,
        agent: typeof parsed.data.agent === "string" ? parsed.data.agent : undefined,
        model: typeof parsed.data.model === "string" ? parsed.data.model : undefined,
        subtask: typeof parsed.data.subtask === "boolean" ? parsed.data.subtask : undefined,
      };
    }

    const name = sanitizeCommandName(String(command.name ?? ""));
    validateCommandName(name);
    const template = typeof command.template === "string" ? command.template : "";
    if (!template.trim()) {
      throw new ApiError(400, "invalid_command_template", "Command template is required");
    }
    return {
      name,
      template,
      description: typeof command.description === "string" ? command.description : undefined,
      agent: typeof command.agent === "string" ? command.agent : undefined,
      model: typeof command.model === "string" ? command.model : null,
      subtask: typeof command.subtask === "boolean" ? command.subtask : undefined,
    };
  });
}

export function normalizeWorkspaceImportPayload(
  workspaceRoot: string,
  payload: Record<string, unknown>,
): NormalizedWorkspaceImport {
  return {
    modes: normalizeModes(payload.mode),
    sections: {
      opencode: payload.opencode !== undefined,
      openwork: payload.openwork !== undefined,
      skills: payload.skills !== undefined,
      commands: payload.commands !== undefined,
      files: payload.files !== undefined,
    },
    ...(payload.opencode !== undefined
      ? { opencode: sanitizePortableOpencodeConfig(readRecord(payload.opencode)) }
      : {}),
    ...(payload.openwork !== undefined
      ? { openwork: sanitizeOpenworkTemplateConfig(readRecord(payload.openwork)) }
      : {}),
    skills: normalizeSkills(payload.skills),
    commands: normalizeCommands(payload.commands),
    files: planPortableFiles(workspaceRoot, payload.files).map((file) => ({
      path: file.path,
      content: file.content,
    })),
  };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function textDigest(content: string | null): string {
  return digest(content === null ? { type: "missing" } : { type: "text", content });
}

function jsonDigest(value: unknown): string {
  return digest({ type: "json", value });
}

function sameJson(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

function actionForTarget(
  existsBefore: boolean,
  changed: boolean,
  mode: WorkspaceImportMode,
): WorkspaceImportChangeAction {
  if (!existsBefore) return "create";
  if (!changed) return "unchanged";
  return mode === "replace" ? "replace" : "update";
}

function rel(workspaceRoot: string, absolutePath: string): string {
  return relative(workspaceRoot, absolutePath).replaceAll("\\", "/");
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

async function readTextIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

function countSummary(changes: WorkspaceImportChange[]): WorkspaceImportPreview["summary"] {
  return changes.reduce(
    (summary, change) => {
      summary.total += 1;
      summary[change.action] += 1;
      return summary;
    },
    { total: 0, create: 0, update: 0, replace: 0, delete: 0, unchanged: 0 },
  );
}

function fingerprintWorkspaceImportChanges(changes: WorkspaceImportPlannedChange[]): string {
  return digest(
    changes.map((change) => ({
      kind: change.kind,
      action: change.action,
      path: change.path,
      beforeDigest: change.beforeDigest,
      afterDigest: change.afterDigest,
    })),
  );
}

async function readOpenworkConfig(path: string): Promise<Record<string, unknown>> {
  const raw = await readTextIfPresent(path);
  if (raw === null) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new ApiError(422, "invalid_json", "Failed to parse openwork.json");
  }
}

async function listProjectSkillNames(workspaceRoot: string): Promise<string[]> {
  const dir = projectSkillsDir(workspaceRoot);
  if (!(await exists(dir))) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (await exists(join(dir, entry.name, "SKILL.md"))) {
      names.push(entry.name);
    }
  }
  return names.sort();
}

async function listProjectCommandNames(workspaceRoot: string): Promise<string[]> {
  const dir = projectCommandsDir(workspaceRoot);
  if (!(await exists(dir))) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name.replace(/\.md$/, ""))
    .sort();
}

export async function buildWorkspaceImportPreview(
  workspaceRoot: string,
  payload: Record<string, unknown>,
): Promise<WorkspaceImportPlan> {
  const input = normalizeWorkspaceImportPayload(workspaceRoot, payload);
  const changes: WorkspaceImportPlannedChange[] = [];

  if (input.opencode !== undefined) {
    const path = opencodeConfigPath(workspaceRoot);
    const before = await readJsoncFile(path, {} as Record<string, unknown>);
    const after = input.modes.opencode === "replace" ? input.opencode : { ...before.data, ...input.opencode };
    changes.push({
      kind: "opencode",
      action: actionForTarget(Boolean(before.raw), !sameJson(before.data, after), input.modes.opencode),
      label: "OpenCode config",
      path: rel(workspaceRoot, path),
      absolutePath: path,
      beforeDigest: jsonDigest(before.data),
      afterDigest: jsonDigest(after),
    });
  }

  if (input.openwork !== undefined) {
    const path = openworkConfigPath(workspaceRoot);
    const existsBefore = await exists(path);
    const before = await readOpenworkConfig(path);
    const after = input.modes.openwork === "replace" ? input.openwork : { ...before, ...input.openwork };
    changes.push({
      kind: "openwork",
      action: actionForTarget(existsBefore, !sameJson(before, after), input.modes.openwork),
      label: "OpenWork config",
      path: rel(workspaceRoot, path),
      absolutePath: path,
      beforeDigest: existsBefore ? jsonDigest(before) : textDigest(null),
      afterDigest: jsonDigest(after),
    });
  }

  if (input.sections.skills) {
    const existing = new Set(await listProjectSkillNames(workspaceRoot));
    const incoming = new Set<string>();
    for (const skill of input.skills) {
      incoming.add(skill.name);
      const path = join(projectSkillsDir(workspaceRoot), skill.name, "SKILL.md");
      const existsBefore = existing.has(skill.name);
      const before = existsBefore ? await readTextIfPresent(path) : null;
      const next = buildSkillContent(skill);
      changes.push({
        kind: "skill",
        action: actionForTarget(before !== null, before !== next.content, "merge"),
        label: skill.name,
        path: rel(workspaceRoot, path),
        absolutePath: path,
        beforeDigest: before !== null ? textDigest(before) : textDigest(null),
        afterDigest: textDigest(next.content),
      });
    }
    if (input.modes.skills === "replace") {
      for (const name of existing) {
        if (incoming.has(name)) continue;
        const path = join(projectSkillsDir(workspaceRoot), name);
        const skillFile = join(path, "SKILL.md");
        const before = await readTextIfPresent(skillFile);
        if (before === null) continue;
        changes.push({
          kind: "skill",
          action: "delete",
          label: name,
          path: rel(workspaceRoot, path),
          absolutePath: path,
          beforeDigest: textDigest(before),
          afterDigest: textDigest(null),
        });
      }
    }
  }

  if (input.sections.commands) {
    const existing = new Set(await listProjectCommandNames(workspaceRoot));
    const incoming = new Set<string>();
    for (const command of input.commands) {
      incoming.add(command.name);
      const path = join(projectCommandsDir(workspaceRoot), `${command.name}.md`);
      const existsBefore = existing.has(command.name);
      const before = existsBefore ? await readTextIfPresent(path) : null;
      const next = buildCommandContent(command);
      changes.push({
        kind: "command",
        action: actionForTarget(before !== null, before !== next.content, "merge"),
        label: command.name,
        path: rel(workspaceRoot, path),
        absolutePath: path,
        beforeDigest: before !== null ? textDigest(before) : textDigest(null),
        afterDigest: textDigest(next.content),
      });
    }
    if (input.modes.commands === "replace") {
      for (const name of existing) {
        if (incoming.has(name)) continue;
        const path = join(projectCommandsDir(workspaceRoot), `${name}.md`);
        const before = await readTextIfPresent(path);
        if (before === null) continue;
        changes.push({
          kind: "command",
          action: "delete",
          label: name,
          path: rel(workspaceRoot, path),
          absolutePath: path,
          beforeDigest: textDigest(before),
          afterDigest: textDigest(null),
        });
      }
    }
  }

  if (input.sections.files) {
    const incoming = new Set<string>();
    for (const file of input.files) {
      incoming.add(file.path);
      const path = join(workspaceRoot, file.path);
      const existsBefore = await exists(path);
      const before = existsBefore ? await readTextIfPresent(path) : null;
      changes.push({
        kind: "file",
        action: actionForTarget(before !== null, before !== file.content, "merge"),
        label: file.path,
        path: file.path,
        absolutePath: path,
        beforeDigest: before !== null ? textDigest(before) : textDigest(null),
        afterDigest: textDigest(file.content),
      });
    }
    if (input.modes.files === "replace") {
      for (const filePath of await listPortableFilePaths(workspaceRoot)) {
        if (incoming.has(filePath)) continue;
        const path = join(workspaceRoot, filePath);
        const before = await readTextIfPresent(path);
        if (before === null) continue;
        changes.push({
          kind: "file",
          action: "delete",
          label: filePath,
          path: filePath,
          absolutePath: path,
          beforeDigest: textDigest(before),
          afterDigest: textDigest(null),
        });
      }
    }
  }

  const summary = countSummary(changes);
  return {
    fingerprint: fingerprintWorkspaceImportChanges(changes),
    summary,
    changes,
  };
}

export function publicWorkspaceImportPreview(preview: WorkspaceImportPlan): WorkspaceImportPreview {
  return {
    fingerprint: preview.fingerprint,
    summary: preview.summary,
    changes: preview.changes.map(
      ({ absolutePath: _absolutePath, beforeDigest: _beforeDigest, afterDigest: _afterDigest, ...change }) => change,
    ),
  };
}

export function workspaceImportPreviewApprovalPaths(preview: WorkspaceImportPlan): string[] {
  return Array.from(
    new Set(
      preview.changes
        .filter((change) => change.action !== "unchanged")
        .map((change) => change.absolutePath),
    ),
  );
}

function countLabel(verb: string, count: number): string | null {
  if (count <= 0) return null;
  return `${verb} ${count}`;
}

function summarizeWorkspaceImport(prefix: "Import" | "Imported", preview: WorkspaceImportPreview): string {
  const parts = [
    countLabel("add", preview.summary.create),
    countLabel("update", preview.summary.update + preview.summary.replace),
    countLabel("remove", preview.summary.delete),
  ].filter((part): part is string => Boolean(part));

  return parts.length ? `${prefix} workspace config (${parts.join(", ")})` : `${prefix} workspace config (no changes)`;
}

export function summarizeWorkspaceImportPreview(preview: WorkspaceImportPreview): string {
  return summarizeWorkspaceImport("Import", preview);
}

export function summarizeWorkspaceImportApplied(preview: WorkspaceImportPreview): string {
  return summarizeWorkspaceImport("Imported", preview);
}
