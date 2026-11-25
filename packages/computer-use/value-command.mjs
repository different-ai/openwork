// Runs the one command a person approved to fetch a private value, such as a password manager's
// `read` command, and hands back what it printed. The host that calls this types the value into a
// page and never returns it to the model. Nothing here writes the value to a log, an error or a file.
//
// The command is a program and its arguments, started directly: no shell reads it, so what the
// approval card shows is exactly what runs. Pipes, variables and quoting belong in a script the
// person names instead.
import { spawn } from "node:child_process";
import path from "node:path";

const MAX_PARTS = 16;
const MAX_PART_LENGTH = 512;
const MAX_COMMAND_LENGTH = 1000;
const MAX_OUTPUT_BYTES = 16_384;
const MAX_ERROR_BYTES = 4096;
const MAX_DETAIL_LENGTH = 200;
// Characters a card cannot show: controls, and the marks that reorder or hide the text around them.
const UNSHOWABLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202f\u2060-\u206f\ufeff]/;
const UNSHOWABLE_ALL = new RegExp(UNSHOWABLE, "g");
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Whether `command` is a program and its arguments that an approval card can show whole. The program is a
 * bare name, found on PATH, or an absolute path: never a path relative to a folder the person cannot see.
 * @param {unknown} command @returns {command is string[]}
 */
export function validValueCommand(command) {
  if (!Array.isArray(command) || command.length < 1 || command.length > MAX_PARTS) return false;
  if (!command.every((part) => typeof part === "string" && part.length <= MAX_PART_LENGTH && !UNSHOWABLE.test(part))) return false;
  const program = command[0];
  if (!program.trim() || program !== program.trim() || program.startsWith("-")) return false;
  if (/[\\/]/.test(program) && !path.isAbsolute(program)) return false;
  return command.reduce((total, part) => total + part.length + 1, 0) <= MAX_COMMAND_LENGTH;
}

/**
 * Whether `ask` is a name the approval card can show for a value the person pastes, such as "GitHub password":
 * one short line, with nothing in it that hides or reorders what the person reads.
 * @param {unknown} ask @returns {ask is string}
 */
export function validValueAsk(ask) {
  return typeof ask === "string" && ask.length <= 80 && ask.trim().length >= 1 && ask === ask.trim() && !UNSHOWABLE.test(ask);
}

// A variable that changes which code a program loads or where it looks for programs is never one a pasted
// value goes into, whatever the card would call it.
const UNLOCK_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const UNLOCK_REFUSED = /^(PATH|HOME|SHELL|IFS|ENV|BASH_ENV|NODE_OPTIONS|PYTHONSTARTUP|PYTHONPATH|PERL5OPT|RUBYOPT|(LD|DYLD)_.*)$/i;

/**
 * Whether `unlock` names one environment variable a command reads its key from, such as a password manager's
 * session key, and the name under which the person pastes that key: `{ env: "BW_SESSION", ask: "Bitwarden
 * session key" }`, and nothing else.
 * @param {unknown} unlock @returns {unlock is { env: string, ask: string }}
 */
export function validValueUnlock(unlock) {
  if (!unlock || typeof unlock !== "object" || Array.isArray(unlock)) return false;
  const { env, ask } = /** @type {{ env?: unknown, ask?: unknown }} */ (unlock);
  return Object.keys(unlock).every((key) => key === "env" || key === "ask")
    && typeof env === "string" && UNLOCK_NAME.test(env) && !UNLOCK_REFUSED.test(env) && validValueAsk(ask);
}

/** Whether a pasted key can be given to a command in its environment: one line, and long enough to be told apart from ordinary text. */
export function validUnlockValue(value) {
  return typeof value === "string" && value.length >= 4 && value.length <= 4096 && !/[\r\n\u0000]/.test(value);
}

/**
 * Where a key the person pastes for a command is kept: by the program it unlocks, never by a website.
 * @param {string} program @param {{ env: string, ask: string }} unlock
 */
export const unlockPlace = (program, unlock) => ({ site: `command:${program}`, label: `${unlock.env} ${unlock.ask}` });

/** The command as one line for a person to read: an argument with a space or a quote in it is quoted. */
export function showValueCommand(command) {
  return command.map((part) => part !== "" && /^[\w@%+=:,./-]+$/.test(part) ? part : `'${part.replaceAll("'", "'\\''")}'`).join(" ");
}

/** The first line a failed command wrote to its error stream, short enough to read at a glance. */
function firstLine(bytes) {
  const text = Buffer.concat(bytes).toString("utf8").replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
  const line = text.split(/\r?\n/).map((entry) => entry.replace(UNSHOWABLE_ALL, " ").trim()).find(Boolean) ?? "";
  return line.length > MAX_DETAIL_LENGTH ? `${line.slice(0, MAX_DETAIL_LENGTH)}…` : line;
}

/**
 * @typedef {{ ok: true, value: string }
 *   | { ok: false, code: "command_not_found" | "command_failed" | "command_timeout" | "command_empty" | "command_output_unusable" | "canceled", exitCode?: number, detail?: string }} ValueCommandResult
 */

/**
 * Runs `command` and resolves with what it printed, less one final line break. Never rejects. A failure carries
 * a code, and for a command that exited with an error its exit code and the first line of its error stream: never
 * anything it printed to its output.
 * @param {string[]} command
 * @param {{ env?: NodeJS.ProcessEnv, cwd?: string, timeoutMs?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<ValueCommandResult>}
 */
export function runValueCommand(command, { env = process.env, cwd, timeoutMs = 60_000, signal } = {}) {
  return new Promise((resolve) => {
    if (!validValueCommand(command)) return resolve({ ok: false, code: "command_failed" });
    if (signal?.aborted) return resolve({ ok: false, code: "canceled" });
    /** @type {Buffer[]} */
    const output = [], errors = [];
    let outputBytes = 0, errorBytes = 0, settled = false, overflow = false;
    let child;
    /** @param {ValueCommandResult} result */
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      resolve(result);
    };
    const stop = () => { try { child?.kill("SIGKILL"); } catch { /* Already gone. */ } };
    const cancel = () => { stop(); finish({ ok: false, code: "canceled" }); };
    const timer = setTimeout(() => { stop(); finish({ ok: false, code: "command_timeout" }); }, timeoutMs);
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      // No shell, no input: the command cannot wait on a prompt in a terminal nobody sees.
      child = spawn(command[0], command.slice(1), { shell: false, stdio: ["ignore", "pipe", "pipe"], env, cwd, windowsHide: true });
    } catch {
      return finish({ ok: false, code: "command_not_found" });
    }
    child.stdout.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) { overflow = true; stop(); return; }
      output.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (errorBytes >= MAX_ERROR_BYTES) return;
      errors.push(chunk.subarray(0, MAX_ERROR_BYTES - errorBytes));
      errorBytes += chunk.length;
    });
    child.on("error", (/** @type {NodeJS.ErrnoException} */ error) => finish({ ok: false, code: ["ENOENT", "EACCES", "ENOTDIR"].includes(error?.code) ? "command_not_found" : "command_failed" }));
    child.on("close", (exitCode) => {
      if (overflow) return finish({ ok: false, code: "command_output_unusable" });
      if (exitCode !== 0) {
        const detail = firstLine(errors);
        return finish({ ok: false, code: "command_failed", ...(Number.isInteger(exitCode) ? { exitCode } : {}), ...(detail ? { detail } : {}) });
      }
      let text;
      try { text = strictUtf8.decode(Buffer.concat(output)); }
      catch { return finish({ ok: false, code: "command_output_unusable" }); }
      const value = text.endsWith("\r\n") ? text.slice(0, -2) : text.endsWith("\n") ? text.slice(0, -1) : text;
      finish(value ? { ok: true, value } : { ok: false, code: "command_empty" });
    });
  });
}
