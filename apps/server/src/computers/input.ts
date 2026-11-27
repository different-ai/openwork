import { posix } from "node:path";
import { z } from "zod";
import { computerActionSchema, computerFolderSchema } from "@openwork/types/den/computers";
import { computerToolSchemas, type SandboxToolName } from "../sandbox-tool-host.js";

const path = z.string().min(1);
const count = z.number().int().min(0).optional();
const native = {
  shell: z.strictObject({ command: z.string(), workdir: path.optional(), timeout: count, background: z.boolean().optional() }),
  read: z.strictObject({ path, offset: count, limit: count }),
  write: z.strictObject({ path, content: z.string() }),
  edit: z.strictObject({ path, oldString: z.string(), newString: z.string(), replaceAll: z.boolean().optional() }),
  glob: z.strictObject({ path: path.optional(), pattern: z.string(), hidden: z.boolean().optional(), limit: count }),
  grep: z.strictObject({ path: path.optional(), pattern: z.string(), literal: z.boolean().optional(), include: z.string().optional(), caseSensitive: z.boolean().optional(), limit: count }),
};

function guestPath(value: string, folder: string) {
  return computerFolderSchema.parse(posix.resolve(folder, value));
}

export function translateComputerInput(tool: SandboxToolName, value: unknown, folder: string) {
  switch (tool) {
    case "shell": {
      const { command, workdir, timeout, background } = native.shell.parse(value);
      if (background) throw new Error("Long-running background commands can't run on another computer yet. Run it in the foreground.");
      return computerToolSchemas.shell.parse({ command, cwd: guestPath(workdir ?? folder, folder), timeoutMs: Math.min(timeout || 120_000, 120_000) });
    }
    case "read": {
      const args = native.read.parse(value);
      return computerToolSchemas.read.parse({ path: guestPath(args.path, folder), offset: args.offset || 1, limit: Math.min(args.limit || 2000, 2000) });
    }
    case "write": {
      const args = native.write.parse(value);
      return computerToolSchemas.write.parse({ ...args, path: guestPath(args.path, folder) });
    }
    case "edit": {
      const args = native.edit.parse(value);
      return computerToolSchemas.edit.parse({ ...args, path: guestPath(args.path, folder) });
    }
    case "glob": {
      const { path: root, pattern, hidden, limit } = native.glob.parse(value);
      return computerToolSchemas.glob.parse({ path: guestPath(root ?? folder, folder), pattern, hidden, limit: limit ? Math.min(limit, 2000) : undefined });
    }
    case "grep": {
      const { path: root, pattern, literal, include, caseSensitive, limit } = native.grep.parse(value);
      return computerToolSchemas.grep.parse({ path: guestPath(root ?? folder, folder), pattern, literal, include, caseSensitive, limit: limit ? Math.min(limit, 2000) : undefined });
    }
  }
}

export function computerActionForTool(tool: SandboxToolName, input: unknown) {
  switch (tool) {
    case "shell": return computerActionSchema.parse({ type: "shell", ...computerToolSchemas.shell.parse(input) });
    case "read": {
      const args = computerToolSchemas.read.parse(input);
      return computerActionSchema.parse({ type: "read", path: args.path ?? args.filePath });
    }
    case "write":
    case "edit": {
      const args = computerToolSchemas[tool].parse(input);
      return computerActionSchema.parse({ type: "write", path: args.path ?? args.filePath });
    }
    case "glob": return computerActionSchema.parse({ type: "list", path: computerToolSchemas.glob.parse(input).path });
    case "grep": return computerActionSchema.parse({ type: "search", path: computerToolSchemas.grep.parse(input).path });
  }
}
