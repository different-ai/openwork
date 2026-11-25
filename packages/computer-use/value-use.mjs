// Uses private values the agent never sees somewhere other than a web page: in a program's environment, in a file
// only that program reads, or in the headers and body of one https request. The values come from `fill_from`'s
// sources (a command the person approves, or what they paste into the card). This module runs the program or
// sends the request once those values are in hand, and hands back what came back with every value replaced by
// `[secret]`. Nothing here writes a value to a log or an error, and every file it writes is removed before it
// returns.
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validValueAsk, validValueCommand, validValueUnlock } from "./value-command.mjs";

export const MAX_USE_VALUES = 6;
const MAX_OUTPUT_BYTES = 32_768;
const MAX_RESPONSE_BYTES = 65_536;
const MAX_BODY_LENGTH = 16_384;
const MAX_HEADERS = 16;
const MAX_HEADER_LENGTH = 2000;
const SCRUBBED = "[secret]";
const VALUE_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const PLACE = /\{\{([A-Z_][A-Z0-9_]{0,63})\}\}/g;
// The same rule as an unlock key: a value never goes into a variable that decides which code a program loads.
const REFUSED_NAME = /^(PATH|HOME|SHELL|IFS|ENV|BASH_ENV|NODE_OPTIONS|PYTHONSTARTUP|PYTHONPATH|PERL5OPT|RUBYOPT|(LD|DYLD)_.*)$/i;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const UNSHOWABLE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202f\u2060-\u206f\ufeff]/;

/**
 * @typedef {{ name: string, as?: "env" | "file", command: string[], unlock?: { env: string, ask: string }, ask?: undefined }
 *   | { name: string, as?: "env" | "file", ask: string, command?: undefined, unlock?: undefined }} UseValue
 * @typedef {{ command: string[] }} UseRun
 * @typedef {{ name: string, from: string, for?: string }} UseSeal
 * @typedef {{ method: string, url: string, headers?: Record<string, string>, body?: string, seal?: UseSeal[] }} UseRequest
 * @typedef {{ values: UseValue[], run?: UseRun, request?: UseRequest }} ValueUse
 */

export const MAX_SEALS = 4;
const SEAL_PATH = /^[A-Za-z0-9_-]{1,64}(\.[A-Za-z0-9_-]{1,64}){0,5}$/;

/** Whether `text` is an https origin as `URL` writes it, such as `https://api.example.com`. @param {unknown} text */
const isHttpsOrigin = (text) => {
  if (typeof text !== "string" || text.length > 300) return false;
  try { const url = new URL(text); return url.protocol === "https:" && url.origin === text; } catch { return false; }
};

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * Whether `seal` names up to four values to take out of a request's JSON answer and keep for the chat instead of
 * showing them: each a NAME in capitals that no value of the same use has, the dotted path of a string in the
 * answer (`access_token`, `data.token`, `items.0.key`), and the https origin it may later be sent to.
 * @param {unknown} seal @param {Set<string>} names
 */
function validSeal(seal, names) {
  if (!Array.isArray(seal) || seal.length < 1 || seal.length > MAX_SEALS) return false;
  const seen = new Set();
  for (const entry of seal) {
    if (!isObject(entry) || !Object.keys(entry).every((key) => ["name", "from", "for"].includes(key))) return false;
    if (typeof entry.name !== "string" || !VALUE_NAME.test(entry.name) || REFUSED_NAME.test(entry.name) || names.has(entry.name) || seen.has(entry.name)) return false;
    seen.add(entry.name);
    if (typeof entry.from !== "string" || !SEAL_PATH.test(entry.from)) return false;
    if (entry.for !== undefined && !isHttpsOrigin(entry.for)) return false;
  }
  return true;
}

/** The `{{NAME}}` places in `text`. @param {string} text */
export const placesIn = (text) => [...text.matchAll(PLACE)].map((match) => match[1]);

/**
 * Whether `use` names up to six values, each with a source and a name, and exactly one place they go: a program to
 * run (`run`) or one https request (`request`). A request takes each value at a `{{NAME}}` place in a header or the
 * body, and every value it names must be placed there. A run takes each as an environment variable, or with
 * `as: "file"`, as a file whose path is in that variable.
 * @param {unknown} use @returns {use is ValueUse}
 */
export function validValueUse(use) {
  if (!isObject(use) || !Object.keys(use).every((key) => ["values", "run", "request"].includes(key))) return false;
  const { values, run, request } = use;
  if ((run === undefined) === (request === undefined)) return false;
  if (!Array.isArray(values) || values.length < 1 || values.length > MAX_USE_VALUES) return false;
  const names = new Set();
  for (const value of values) {
    if (!isObject(value) || !Object.keys(value).every((key) => ["name", "as", "command", "ask", "unlock"].includes(key))) return false;
    if (typeof value.name !== "string" || !VALUE_NAME.test(value.name) || REFUSED_NAME.test(value.name) || names.has(value.name)) return false;
    names.add(value.name);
    if (value.as !== undefined && value.as !== "env" && value.as !== "file") return false;
    if ((value.command === undefined) === (value.ask === undefined)) return false;
    if (value.command !== undefined && !validValueCommand(value.command)) return false;
    if (value.ask !== undefined && (!validValueAsk(value.ask) || value.unlock !== undefined)) return false;
    if (value.unlock !== undefined && !validValueUnlock(value.unlock)) return false;
  }
  if (run !== undefined) {
    if (!isObject(run) || !Object.keys(run).every((key) => key === "command") || !validValueCommand(run.command)) return false;
    return true;
  }
  if (!isObject(request) || !Object.keys(request).every((key) => ["method", "url", "headers", "body", "seal"].includes(key))) return false;
  if (request.seal !== undefined && !validSeal(request.seal, names)) return false;
  if (typeof request.method !== "string" || !METHODS.includes(request.method)) return false;
  if (typeof request.url !== "string" || request.url.length > 2000 || UNSHOWABLE.test(request.url) || request.url.includes("{{")) return false;
  let url;
  try { url = new URL(request.url); } catch { return false; }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  const headers = request.headers ?? {};
  if (!isObject(headers) || Object.keys(headers).length > MAX_HEADERS) return false;
  for (const [name, text] of Object.entries(headers)) {
    if (!HEADER_NAME.test(name) || typeof text !== "string" || text.length > MAX_HEADER_LENGTH || /[\r\n\u0000]/.test(text)) return false;
  }
  if (request.body !== undefined && (typeof request.body !== "string" || request.body.length > MAX_BODY_LENGTH)) return false;
  if (values.some((value) => value.as === "file")) return false;
  const placed = new Set([...Object.values(headers), request.body ?? ""].flatMap(placesIn));
  return [...placed].every((name) => names.has(name)) && [...names].every((name) => placed.has(name));
}

/** Where a value goes, as one short line for the card and the audit log. @param {ValueUse} use @param {UseValue} value */
export function valueDestination(use, value) {
  if (use.run) return value.as === "file" ? `file in $${value.name}` : `$${value.name}`;
  const headers = Object.entries(use.request?.headers ?? {}).filter(([, text]) => placesIn(text).includes(value.name)).map(([name]) => name);
  return headers.length ? `header ${headers.join(", ")}` : "request body";
}

/** The place a use sends values to, as the card and the audit log name it: the program, or the request's method and URL. @param {ValueUse} use */
export function useTarget(use) {
  if (use.run) return { kind: /** @type {const} */ ("run"), command: [...use.run.command] };
  const request = /** @type {UseRequest} */ (use.request);
  const url = new URL(request.url);
  const seal = request.seal?.map((entry) => ({ name: entry.name, from: entry.from, for: entry.for ?? url.origin }));
  return { kind: /** @type {const} */ ("request"), method: request.method, url: `${url.origin}${url.pathname}`, origin: url.origin, ...(seal ? { seal } : {}) };
}

/**
 * The string at each seal's dotted path in `text`, a JSON answer, or null where there is none or it cannot be kept:
 * 4 to 4096 characters on one line, so it can later go into a header.
 * @param {string} text @param {UseSeal[]} seal @returns {Array<string | null>}
 */
export function sealedIn(text, seal) {
  let answer;
  try { answer = JSON.parse(text); } catch { return seal.map(() => null); }
  return seal.map((entry) => {
    let at = answer;
    for (const step of entry.from.split(".")) {
      if (Array.isArray(at) && /^\d+$/.test(step)) at = at[Number(step)];
      else if (isObject(at) && Object.hasOwn(at, step)) at = at[step];
      else return null;
    }
    return typeof at === "string" && at.length >= 4 && at.length <= 4096 && !/[\r\n\u0000]/.test(at) ? at : null;
  });
}

/** Every way a value could be written out that `[secret]` replaces: as it is, URL-encoded, inside JSON, and in base64. @param {string} value */
function forms(value) {
  const all = new Set([value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1), Buffer.from(value).toString("base64").replace(/=+$/, "")]);
  return [...all].filter((form) => form.length >= 4).sort((a, b) => b.length - a.length);
}

/** `text` with every value, in every form `forms` lists, replaced by `[secret]`. @param {string} text @param {string[]} values */
export function scrubValues(text, values) {
  let result = text;
  for (const form of values.flatMap(forms).sort((a, b) => b.length - a.length)) result = result.split(form).join(SCRUBBED);
  return result;
}

/** At most `limit` bytes of `chunks` as text, and whether more came. @param {Buffer[]} chunks @param {number} limit */
function cut(chunks, limit) {
  const all = Buffer.concat(chunks);
  return { text: all.subarray(0, limit).toString("utf8"), truncated: all.length > limit };
}

/**
 * Runs `run.command` with each value in its environment (or, `as: "file"`, in a file only the person's account can
 * read, its path in the variable) and resolves with its exit code and what it printed, every value scrubbed.
 * Never rejects. The files are removed before this resolves, whatever happened.
 * @param {UseRun} run @param {Array<{ name: string, as?: "env" | "file", value: string }>} values
 * @param {{ env?: NodeJS.ProcessEnv, cwd?: string, timeoutMs?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<{ ok: true, exitCode: number | null, output: string, errors: string, truncated: boolean } | { ok: false, code: "command_not_found" | "command_timeout" | "canceled" | "command_failed" }>}
 */
export async function runWithValues(run, values, { env = process.env, cwd, timeoutMs = 120_000, signal } = {}) {
  if (!validValueCommand(run.command)) return { ok: false, code: "command_failed" };
  if (signal?.aborted) return { ok: false, code: "canceled" };
  const secrets = values.map((entry) => entry.value);
  /** @type {string | null} */
  let folder = null;
  try {
    /** @type {NodeJS.ProcessEnv} */
    const childEnv = { ...env };
    for (const entry of values) {
      if (entry.as === "file") {
        folder ??= await mkdtemp(path.join(os.tmpdir(), "openwork-value-"));
        const file = path.join(folder, entry.name.toLowerCase());
        await writeFile(file, entry.value, { mode: 0o600, flag: "wx" });
        childEnv[entry.name] = file;
      } else {
        childEnv[entry.name] = entry.value;
      }
    }
    return await new Promise((resolve) => {
      /** @type {Buffer[]} */
      const output = [], errors = [];
      let outputBytes = 0, errorBytes = 0, settled = false;
      let child;
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
        child = spawn(run.command[0], run.command.slice(1), { shell: false, stdio: ["ignore", "pipe", "pipe"], env: childEnv, cwd, windowsHide: true });
      } catch {
        return finish({ ok: false, code: "command_not_found" });
      }
      child.stdout.on("data", (chunk) => { if (outputBytes <= MAX_OUTPUT_BYTES) output.push(chunk); outputBytes += chunk.length; });
      child.stderr.on("data", (chunk) => { if (errorBytes <= MAX_OUTPUT_BYTES) errors.push(chunk); errorBytes += chunk.length; });
      child.on("error", (/** @type {NodeJS.ErrnoException} */ error) => finish({ ok: false, code: ["ENOENT", "EACCES", "ENOTDIR"].includes(error?.code ?? "") ? "command_not_found" : "command_failed" }));
      child.on("close", (exitCode) => {
        const out = cut(output, MAX_OUTPUT_BYTES), err = cut(errors, MAX_OUTPUT_BYTES);
        finish({ ok: true, exitCode, output: scrubValues(out.text, secrets), errors: scrubValues(err.text, secrets), truncated: out.truncated || err.truncated });
      });
    });
  } catch {
    return { ok: false, code: "command_failed" };
  } finally {
    if (folder) await rm(folder, { recursive: true, force: true }).catch(() => {});
  }
}

/** `text` with each `{{NAME}}` replaced by that value. @param {string} text @param {Map<string, string>} byName */
const fillPlaces = (text, byName) => text.replace(PLACE, (_, name) => byName.get(name) ?? "");

const SHOWN_HEADERS = ["content-type", "location", "retry-after", "www-authenticate"];

/**
 * Sends `request` once, with each `{{NAME}}` in its headers and body replaced by that value, never following a
 * redirect, and resolves with its status, a few plain headers and up to 64 KB of its body, every value scrubbed.
 * With `seal`, each string at a seal's path is taken out of the answer into `held`, for the caller to keep and never
 * show, and scrubbed too; when one is not found the body is withheld whole (`withheld`), since the value may be
 * somewhere else in it. Never rejects.
 * @param {UseRequest} request @param {Array<{ name: string, value: string }>} values
 * @param {{ fetch?: typeof fetch, timeoutMs?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<{ ok: true, status: number, headers: Record<string, string>, body: string, truncated: boolean, held?: Array<{ name: string, for: string, value: string }>, withheld?: true } | { ok: false, code: "request_failed" | "request_timeout" | "canceled" }>}
 */
export async function requestWithValues(request, values, { fetch: send = fetch, timeoutMs = 60_000, signal } = {}) {
  const byName = new Map(values.map((entry) => [entry.name, entry.value]));
  const secrets = values.map((entry) => entry.value);
  const timeout = AbortSignal.timeout(timeoutMs);
  const both = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const headers = Object.fromEntries(Object.entries(request.headers ?? {}).map(([name, text]) => [name, fillPlaces(text, byName)]));
    const response = await send(request.url, { method: request.method, headers, ...(request.body !== undefined ? { body: fillPlaces(request.body, byName) } : {}), redirect: "manual", signal: both });
    /** @type {Buffer[]} */
    const chunks = [];
    let bytes = 0, truncated = false;
    if (response.body) {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (bytes + value.length > MAX_RESPONSE_BYTES) { truncated = true; chunks.push(Buffer.from(value).subarray(0, MAX_RESPONSE_BYTES - bytes)); await reader.cancel().catch(() => {}); break; }
        chunks.push(Buffer.from(value));
        bytes += value.length;
      }
    }
    const text = Buffer.concat(chunks).toString("utf8");
    const seal = request.seal ?? [];
    const found = seal.length ? (truncated ? seal.map(() => null) : sealedIn(text, seal)) : [];
    /** @type {Array<{ name: string, for: string, value: string }>} */
    const held = seal.flatMap((entry, index) => {
      const value = found[index];
      return typeof value === "string" ? [{ name: entry.name, for: entry.for ?? new URL(request.url).origin, value }] : [];
    });
    const hidden = [...secrets, ...held.map((entry) => entry.value)];
    const shown = Object.fromEntries(SHOWN_HEADERS.flatMap((name) => {
      const line = response.headers.get(name);
      return line === null ? [] : [[name, scrubValues(line, hidden)]];
    }));
    const withheld = held.length < seal.length;
    return { ok: true, status: response.status, headers: shown, body: withheld ? "" : scrubValues(text, hidden), truncated, ...(seal.length ? { held, ...(withheld ? { withheld: true } : {}) } : {}) };
  } catch {
    if (signal?.aborted) return { ok: false, code: "canceled" };
    if (timeout.aborted) return { ok: false, code: "request_timeout" };
    return { ok: false, code: "request_failed" };
  }
}
