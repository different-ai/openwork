import type { SandboxHandle, SandboxProvider } from "@openwork/sandbox";
import { z } from "zod";

export const SANDBOX_TOOL_NAMES: readonly ["shell", "read", "write", "edit", "glob", "grep"] = ["shell", "read", "write", "edit", "glob", "grep"];
export type SandboxToolName = typeof SANDBOX_TOOL_NAMES[number];
const MAX_INPUT_BYTES = 128_000;
const MAX_FILE_BYTES = 128_000;
export const SANDBOX_OUTPUT_BYTES = 32_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** Guest POSIX paths only. Never resolve these against a host directory. */
export function sandboxGuestPath(value: string): string {
  if (!value.startsWith("/") || value.includes("\\") || /[\u0000-\u001f\u007f]/u.test(value)
    || value.length > 1024 || value.split("/").some(part => part === "." || part === "..")
    || (value !== "/" && (value.includes("//") || value.endsWith("/")))) {
    throw new Error("Use a canonical absolute guest path without dot segments, backslashes or control characters.");
  }
  return value;
}
const path = z.string().min(1).max(1024).refine(value => {
  try { sandboxGuestPath(value); return true; } catch { return false; }
}, "Expected a canonical absolute guest path");
const text = z.string().max(32_000);
const timeout = z.number().int().min(1).max(120_000).optional();
const filePath = { path: path.optional(), filePath: path.optional() };
function validateFilePath(value: { path?: string; filePath?: string }, context: z.RefinementCtx) {
  if (!value.path && !value.filePath) context.addIssue({ code: "custom", message: "Provide path or filePath." });
  if (value.path && value.filePath && value.path !== value.filePath) context.addIssue({ code: "custom", message: "path and filePath must agree." });
}

/** Small, flat schemas remain safe for grammar-constrained model providers. */
export const sandboxToolSchemas = {
  shell: z.object({ command: text.min(1), cwd: path.optional(), timeoutMs: timeout }).strict(),
  read: z.object({ ...filePath, offset: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(), limit: z.number().int().min(1).max(2000).optional() }).strict().superRefine(validateFilePath),
  write: z.object({ ...filePath, content: text }).strict().superRefine(validateFilePath),
  edit: z.object({ ...filePath, oldString: text.min(1), newString: text, replaceAll: z.boolean().optional() }).strict().superRefine(validateFilePath),
  glob: z.object({ path: path.optional(), pattern: text.min(1) }).strict(),
  grep: z.object({ path: path.optional(), pattern: text.min(1), literal: z.boolean().optional(), include: z.string().max(1024).optional() }).strict(),
};
export const sandboxToolDescriptions: Record<SandboxToolName, string> = {
  shell: "Run a POSIX sh command in the local Linux sandbox, never the host. cwd must be an absolute guest path. Output is bounded; timeout does not prove a process was killed.",
  read: "Read a UTF-8 guest file (maximum 128 KB), with 1-based line offset and limit. Paths are absolute inside the sandbox, not host paths.",
  write: "Write UTF-8 content to an absolute guest path in the sandbox. Does not create parent directories or write host files.",
  edit: "Exactly replace oldString in a UTF-8 guest file. Rejects ambiguous matches unless replaceAll is true. Not atomic against changes by other guest processes.",
  glob: "Find guest files below path (default /) using Linux find -path glob syntax, relative to that root. Includes hidden files; output is bounded. Requires guest find and head.",
  grep: "Search UTF-8 guest files below path (default /) with Linux grep basic regular expressions, or literal text. include is a find -name basename glob. Requires guest find, grep and head; output is bounded.",
};
export type SandboxToolCall = { sessionID: string; signal: AbortSignal; id?: string; messageID?: string; agent?: string };
export type SandboxToolResult = { content: { type: "text"; text: string }[]; metadata: { sandbox: true; truncated: boolean; exitCode?: number } };
export type SandboxToolHostDependencies = {
  provider: SandboxProvider;
  /** Trusted session ownership/lifecycle belongs to the caller, not model input. */
  acquire(): Promise<SandboxHandle>;
  cwd: string;
};

function quote(value: string): string { return `'${value.replace(/'/g, `'"'"'`)}'`; }
function bounded(output: string, exitCode?: number): SandboxToolResult {
  const bytes = encoder.encode(output);
  const truncated = bytes.byteLength > SANDBOX_OUTPUT_BYTES;
  // The non-fatal decoder drops no bytes except the bounded suffix; a split UTF-8
  // sequence can become a replacement character but never leaks extra output.
  const value = truncated ? new TextDecoder().decode(bytes.subarray(0, SANDBOX_OUTPUT_BYTES - 64)) + "\n[Sandbox output truncated]" : output;
  return { content: [{ type: "text", text: value }], metadata: { sandbox: true, truncated, ...(exitCode === undefined ? {} : { exitCode }) } };
}
function selectedPath(input: { path?: string; filePath?: string }): string {
  const value = input.path ?? input.filePath;
  if (!value) throw new Error("Provide path or filePath.");
  return sandboxGuestPath(value);
}

/** All effects use provider blocks. Missing blocks fail closed; there is no host exec/fs fallback. */
export function createSandboxToolHost(dependencies: SandboxToolHostDependencies) {
  const { provider } = dependencies;
  const cwd = sandboxGuestPath(dependencies.cwd);
  return {
    async execute(toolName: string, input: unknown, call: SandboxToolCall = { sessionID: "", signal: new AbortController().signal }): Promise<SandboxToolResult> {
      const name = z.enum(SANDBOX_TOOL_NAMES).parse(toolName);
      call.signal.throwIfAborted();
      const serialized = JSON.stringify(input);
      if (!serialized || encoder.encode(serialized).byteLength > MAX_INPUT_BYTES) throw new Error("Sandbox tool input is too large.");
      // Validate before acquiring compute; a malformed call must not boot a VM.
      const parsed = sandboxToolSchemas[name].parse(input);
      const run = provider.blocks?.run;
      const files = provider.blocks?.files;
      const needsRun = name === "shell" || name === "glob" || name === "grep";
      if (needsRun ? !run : !files) throw new Error(`Sandbox provider does not support ${needsRun ? "run" : "files"}; host fallback is disabled.`);
      const handle = await dependencies.acquire();
      call.signal.throwIfAborted();
      if (handle.ref.providerId !== provider.id || handle.state !== "running") throw new Error("Sandbox handle must be running and belong to the configured provider.");
      const opts = { timeoutMs: 30_000 };
      const read = async (guestPath: string) => {
        if (!files) throw new Error("Sandbox files unavailable.");
        const stat = await files.stat(handle, guestPath, opts);
        if (!stat || stat.kind !== "file") throw new Error("Guest path is not a file.");
        if (stat.size > MAX_FILE_BYTES) throw new Error("Guest file exceeds the 128 KB read/edit limit.");
        const bytes = await files.read(handle, guestPath, opts);
        if (bytes.byteLength > MAX_FILE_BYTES) throw new Error("Guest file exceeds the 128 KB read/edit limit.");
        if (bytes.includes(0)) throw new Error("Guest file is binary; only UTF-8 text is supported.");
        return decoder.decode(bytes);
      };
      const write = async (guestPath: string, content: string) => {
        if (!files) throw new Error("Sandbox files unavailable.");
        const bytes = encoder.encode(content);
        if (bytes.byteLength > MAX_FILE_BYTES) throw new Error("Edited guest file exceeds the 128 KB limit.");
        call.signal.throwIfAborted();
        await files.write(handle, guestPath, bytes, opts);
      };
      let result: SandboxToolResult;
      // Parsing per branch preserves precise types without casts or unchecked unions.
      if (name === "shell") {
        const args = sandboxToolSchemas.shell.parse(parsed);
        if (!run) throw new Error("Sandbox run unavailable.");
        const completed = await run(handle, { command: args.command, shell: "sh", cwd: args.cwd ?? cwd, timeoutMs: args.timeoutMs ?? opts.timeoutMs });
        result = bounded(`${completed.stdout}${completed.stderr ? `\n[stderr]\n${completed.stderr}` : ""}`, completed.exitCode);
      } else if (name === "read") {
        const args = sandboxToolSchemas.read.parse(parsed);
        const content = await read(selectedPath(args));
        const lines = content.split("\n");
        const start = (args.offset ?? 1) - 1;
        const end = Math.min(lines.length, start + (args.limit ?? 2000));
        result = bounded(lines.slice(start, end).map((line, index) => `${start + index + 1}: ${line}`).join("\n") + (end < lines.length ? "\n[More guest lines available; use offset]" : ""));
      } else if (name === "write") {
        const args = sandboxToolSchemas.write.parse(parsed);
        await write(selectedPath(args), args.content);
        result = bounded("Guest file written.");
      } else if (name === "edit") {
        const args = sandboxToolSchemas.edit.parse(parsed);
        if (args.oldString === args.newString) throw new Error("oldString and newString must differ.");
        const guestPath = selectedPath(args);
        const content = await read(guestPath);
        const parts = content.split(args.oldString);
        const matches = parts.length - 1;
        if (!matches) throw new Error("oldString was not found in the guest file.");
        if (matches > 1 && !args.replaceAll) throw new Error("oldString is ambiguous; provide more context or replaceAll.");
        await write(guestPath, parts.join(args.newString));
        result = bounded(`Replaced ${matches} occurrence${matches === 1 ? "" : "s"} in the guest file.`);
      } else {
        if (!run) throw new Error("Sandbox run unavailable.");
        let command: string;
        if (name === "glob") {
          const args = sandboxToolSchemas.glob.parse(parsed);
          const root = args.path ?? "/";
          if (args.pattern.startsWith("/") || args.pattern.split("/").some(part => part === ".." || part === ".") || /[\u0000-\u001f\u007f]/u.test(args.pattern)) throw new Error("Use a relative guest glob without dot segments or control characters.");
          command = `test -d ${quote(root)} || exit 2\nfind ${quote(root)} -type f -path ${quote(`${root === "/" ? "" : root}/${args.pattern}`)} -print | head -c ${SANDBOX_OUTPUT_BYTES + 1}`;
        } else {
          const args = sandboxToolSchemas.grep.parse(parsed);
          const root = args.path ?? "/";
          if (/[\u0000\r\n]/u.test(args.pattern) || (args.include && /[\u0000\r\n/]/u.test(args.include))) throw new Error("grep expects a single-line pattern and a basename include glob.");
          const flag = args.literal ? "-F" : "";
          command = `test -d ${quote(root)} || exit 2\ngrep ${flag} -e ${quote(args.pattern)} /dev/null\nstatus=$?\n[ "$status" -le 1 ] || exit "$status"\nfind ${quote(root)} -type f${args.include ? ` -name ${quote(args.include)}` : ""} -exec grep ${flag} -nH -e ${quote(args.pattern)} '{}' + | head -c ${SANDBOX_OUTPUT_BYTES + 1}`;
        }
        const completed = await run(handle, { command, shell: "sh", cwd: "/", ...opts });
        result = bounded(`${completed.stdout}${completed.stderr ? `\n[stderr]\n${completed.stderr}` : ""}`, completed.exitCode);
      }
      call.signal.throwIfAborted();
      return result;
    },
  };
}
