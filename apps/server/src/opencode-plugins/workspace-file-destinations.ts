import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, win32 } from "node:path";
import { rulesFromPermissionConfig, winningRule } from "../effective-permissions.js";

type Resolution = { requested: string; resolved: string };
type Context = {
  directory?: string;
  client?: { config: { get(): Promise<{ data?: { permission?: unknown }; error?: unknown }> } };
};
const nativeMutations = new Set(["write", "edit", "apply_patch"]);
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

function promptWorkspacePath(directory: string): string {
  return directory.replace(/[\u0000-\u001f\u007f\u2028\u2029<>&]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export function correctWorkspaceRoot(system: string[], directory: string): void {
  for (let index = 0; index < system.length; index++) {
    system[index] = system[index].replace(/<env>[\s\S]*?<\/env>/g, block => block.includes("Is directory a git repo: no")
      ? block.replace(/(^[ \t]*Workspace root folder: )\/(\r?$)/m, (_match, prefix: string, suffix: string) => `${prefix}${promptWorkspacePath(directory)}${suffix}`)
      : block);
  }
}

export function workspaceFileGuidance(directory: string): string {
  return `The opened workspace directory is ${JSON.stringify(promptWorkspacePath(directory))}. For files requested in this workspace, prefer plain relative names such as report.html; native file tools save them inside this directory. Do not invent /workspace or a drive-root location. On Windows, drive-less rooted file paths such as /report.html or \\report.html are interpreted relative to this workspace, with the actual destination reported. Explicit full drive paths and UNC paths retain external-folder permissions. Do not bypass a denied path using another tool.`;
}

/** Only drive-less rooted syntax changes. Fully qualified and shell-drive forms keep native semantics. */
export function workspaceRootedPath(input: string, directory: string): string | undefined {
  if (!/^[\\/]/.test(input)) return undefined;
  if (/^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(input) || /^[\\/]{2}[?.][\\/]/.test(input)) return undefined;
  if (/^\/(?:(?:mnt|cygdrive)\/[a-z](?:\/|$)|[a-z]:(?:[\\/]|$)|[a-z](?:\/|$))/i.test(input)) return undefined;
  if (!win32.isAbsolute(directory) || !/^(?:[a-z]:[\\/]|[\\/]{2})/i.test(directory)) throw new Error("The opened workspace must have a fully qualified Windows path.");
  const target = win32.resolve(directory, input.replace(/^[\\/]+/, ""));
  const child = win32.relative(directory, target);
  if (child === ".." || child.startsWith("..\\") || win32.isAbsolute(child)) throw new Error(`Workspace-rooted path ${JSON.stringify(input)} escapes ${JSON.stringify(directory)}. Use a filename inside the workspace, or an explicit authorized full path.`);
  return target;
}

export async function assertWorkspaceDestination(directory: string, target: string): Promise<void> {
  let ancestor = target;
  let actual: string;
  while (true) {
    try { actual = await realpath(ancestor); break; }
    catch (error) {
      if (!record(error) || error.code !== "ENOENT" || dirname(ancestor) === ancestor) throw error;
      ancestor = dirname(ancestor);
    }
  }
  const child = relative(await realpath(directory), actual);
  if (child === ".." || child.startsWith(".." + (process.platform === "win32" ? "\\" : "/")) || isAbsolute(child)) throw new Error(`The workspace destination ${JSON.stringify(target)} follows a link outside ${JSON.stringify(directory)}. No file was changed.`);
}

export async function planWorkspacePaths(tool: string, args: unknown, directory: string, options: {
  platform?: string;
  cwd?: string;
  externalAllowed?: (original: string) => Promise<boolean>;
} = {}): Promise<{ field: "filePath" | "patchText"; value: string; resolutions: Resolution[] } | undefined> {
  if ((options.platform ?? process.platform) !== "win32" || !nativeMutations.has(tool) || !record(args)) return undefined;
  const resolutions: Resolution[] = [];
  const path = async (requested: string) => {
    const resolved = workspaceRootedPath(requested, directory);
    if (!resolved) return requested;
    // Explicit folder grants continue to use the engine's original destination/permission flow.
    const original = tool === "apply_patch" ? win32.resolve(directory, requested) : win32.resolve(options.cwd ?? process.cwd(), requested);
    if (await options.externalAllowed?.(original)) return requested;
    if (!resolutions.some(entry => entry.requested === requested && entry.resolved === resolved)) resolutions.push({ requested, resolved });
    return resolved;
  };
  if ((tool === "write" || tool === "edit") && typeof args.filePath === "string") {
    const value = await path(args.filePath);
    return resolutions.length ? { field: "filePath", value, resolutions } : undefined;
  }
  if (tool !== "apply_patch" || typeof args.patchText !== "string") return undefined;
  const lines = args.patchText.split("\n");
  for (let index = 0; index < lines.length; index++) {
    // Match the pinned v1 parser's source/move headers, not added/context lines.
    const match = /^(\*\*\* (?:Add File|Update File|Delete File|Move to):[ \t]*)([^\r]*)(\r?)$/.exec(lines[index]);
    if (match) lines[index] = match[1] + await path(match[2].trim()) + match[3];
  }
  return resolutions.length ? { field: "patchText", value: lines.join("\n"), resolutions } : undefined;
}

export function workspaceFileHooks(context?: Context, options: { platform?: string; cwd?: string; validate?: (directory: string, target: string) => Promise<void> } = {}) {
  const resolvedCalls = new WeakMap<object, Resolution[]>();
  return {
    "tool.definition": async (input: { toolID: string }, output: { description: string; jsonSchema?: unknown }) => {
      if (!context?.directory || !nativeMutations.has(input.toolID)) return;
      output.description += `\n\n${workspaceFileGuidance(context.directory)}`;
      // Pinned v1 file schemas; runtime validation remains the engine's original schema.
      const filePath = { type: "string", description: "Path to the file. Prefer a plain workspace-relative name such as report.html; relative paths are saved in the opened workspace. Explicit full external paths retain folder permissions." };
      if (input.toolID === "write") output.jsonSchema = { type: "object", properties: { content: { type: "string", description: "The content to write" }, filePath }, required: ["content", "filePath"] };
      if (input.toolID === "edit") output.jsonSchema = { type: "object", properties: { filePath, oldString: { type: "string", description: "The exact text to replace" }, newString: { type: "string", description: "The replacement text" }, replaceAll: { type: "boolean", description: "Replace every matching occurrence" } }, required: ["filePath", "oldString", "newString"] };
    },
    "tool.execute.before": async (input: { tool: string }, output: { args: unknown }) => {
      if ((options.platform ?? process.platform) === "win32" && nativeMutations.has(input.tool) && !context?.directory) throw new Error("No opened workspace directory is available; no file operation was performed.");
      if (!context?.directory) return;
      const plan = await planWorkspacePaths(input.tool, output.args, context.directory, {
        platform: options.platform,
        cwd: options.cwd,
        externalAllowed: async original => {
          if (!context.client) return false;
          const response = await context.client.config.get();
          if (!response.data || response.error) throw new Error("Could not check external-folder grants; no workspace path was changed. Retry the operation.");
          const rules = rulesFromPermissionConfig(response.data.permission);
          const grant = winningRule(rules, "external_directory", win32.join(win32.dirname(original), "*"));
          // A blanket run-mode allow is not an explicit destination choice.
          return grant?.permission === "external_directory" && grant.action === "allow" && grant.pattern !== "*";
        },
      });
      if (!plan || !record(output.args)) return;
      for (const entry of plan.resolutions) await (options.validate ?? assertWorkspaceDestination)(context.directory, entry.resolved);
      output.args[plan.field] = plan.value;
      resolvedCalls.set(output.args, plan.resolutions);
    },
    "tool.execute.after": async (input: { args: unknown }, output: { output: string; metadata: Record<string, unknown> }) => {
      if (!record(input.args)) return;
      const resolutions = resolvedCalls.get(input.args);
      if (!resolutions) return;
      resolvedCalls.delete(input.args);
      output.metadata.openworkWorkspacePaths = resolutions;
      output.output = resolutions.map(entry => `Workspace destination: ${entry.resolved} (interpreted ${JSON.stringify(entry.requested)} relative to the opened workspace).`).join("\n") + "\n" + output.output;
    },
  };
}
