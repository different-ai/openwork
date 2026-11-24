// Private values used outside a web page: in a program's environment or a file it reads, or in one https request.
// The agent names where each value comes from and where they all go; it never holds a value. Nothing here needs a
// browser: the host gives it the store that keeps and replaces values, the card that asks the person, and the
// runner for the commands that print a value.
import { showValueCommand, unlockPlace, validUnlockValue } from "./value-command.mjs";
import { requestWithValues, runWithValues, useTarget, validValueUse, valueDestination } from "./value-use.mjs";

const TRUST = "untrusted-content";
export class PrivateValueUseError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) { super(message); this.name = "PrivateValueUseError"; this.code = code; }
}
/** @param {string} code @param {string} message @returns {never} */
const fail = (code, message) => { throw new PrivateValueUseError(code, message); };
// A private value is used in a program's environment or a file it reads, or in one https
// request. What a refusal says never repeats anything a command printed or the person pasted.
const USE_REFUSALS = {
  values_unavailable: "Using a private value is not available here, so nothing was run or sent. Ask the person to do this step themselves.",
  invalid_use: "Name one to six values, each with a NAME in capitals and either command or ask, and exactly one of run (a program and its arguments) or request (an https URL, with each value at a {{NAME}} place in a header or the body). Nothing was run or sent.",
  credential_declined: "The person did not approve this. Nothing was run or sent.",
  value_unusable: "A value cannot be used here: it is shorter than 4 characters, longer than 4096, or has a line break and goes into a header. Nothing was run or sent.",
  pasted_unusable: "What the person pasted cannot be used here: it is shorter than 4 characters, longer than 4096, has a line break and goes into a header, or is no longer kept. Nothing was run or sent. Use the same call once more.",
  unlock_unusable: "The key the person pasted for a command cannot be used: it is shorter than 4 characters, longer than 4096, has a line break, or is no longer kept. Nothing was run or sent. Use the same call once more.",
  command_not_found: "A program could not be started: it is not installed on this computer or is not on its PATH. Nothing was sent. Tell the person.",
  command_timeout: "A command did not finish in time. It may be waiting for the person to unlock their password manager. Nothing was sent. Tell them, then try once more.",
  command_empty: "A command that prints a value printed nothing. Nothing was run or sent. Use a command that prints the value alone.",
  command_output_unusable: "A command that prints a value printed something that is not one short text value. Nothing was run or sent. Use a command that prints the value alone.",
  request_failed: "The request could not be sent or got no answer. It may or may not have reached the site.",
  request_timeout: "The request got no answer in time. It may or may not have reached the site.",
};
/** Where a pasted value is kept for a chat when it is used outside a page: per program, or per site. */
const usePlace = (target) => target.kind === "run" ? `run:${String(target.command[0]).split(/[\\/]/).pop()}` : target.origin;
/** The place a use sends values to, as the person's list of recent fills and the organization's audit log name it. */
const useShown = (target) => (target.kind === "run" ? `run ${showValueCommand(target.command)}` : `${target.method} ${target.url}`).slice(0, 400);
/** @param {{ exitCode?: unknown, detail?: unknown }} result */
const commandFailed = ({ exitCode, detail }) => `The command failed${Number.isInteger(exitCode) ? ` (exit code ${exitCode})` : ""}${typeof detail === "string" && detail ? `: ${detail}${/[.!?]$/.test(detail) ? "" : "."}` : "."} Nothing was run or sent. Fix the command, or tell the person what it said.`;

/**
 * @param {{
 *   secrets: ReturnType<typeof import("./browser-secrets.mjs").createBrowserSecrets>,
 *   enabled: () => boolean | Promise<boolean>,
 *   approveValues: (sessionId: string, request: { use: ReturnType<typeof useTarget>, fills: Array<{ field: string, command: string[], needs?: string } | { field: string, ask: string, kept?: true } | { unlock: string, program: string, ask: string, kept?: true }> }, signal: AbortSignal) => Promise<{ approved?: boolean, values?: Array<string | null>, keep?: boolean[], refused?: { code?: unknown, error?: unknown } } | null | undefined>,
 *   runValueCommand: (command: string[], signal: AbortSignal, unlock?: Record<string, string>) => Promise<import("./value-command.mjs").ValueCommandResult>,
 *   noteValueFill?: (sessionId: string, fill: { site: string, field: string, source: "command" | "paste" | "kept", program?: string, result: string }) => void,
 *   useWith?: { run: typeof runWithValues, request: typeof requestWithValues },
 *   onFailure?: (failure: { code: string, detail: string }) => void,
 * }} host
 */
export function createPrivateValueUse({ secrets, enabled, approveValues, runValueCommand, noteValueFill, useWith = { run: runWithValues, request: requestWithValues }, onFailure = () => {} }) {
  /** Whether a private value may be used right now. A flag that cannot be read is off. */
  async function valuesOn() {
    try { return secrets !== undefined && runValueCommand !== undefined && approveValues !== undefined && await enabled() === true; } catch { return false; }
  }
  /**
   * Uses private values outside a page: the agent names where each value comes from (a command or a name the person
   * pastes it under) and one place they all go, a program it runs or one https request. The person approves the
   * whole on one card before any command runs; each value is held for redaction as soon as it is in hand, and what
   * the program printed or the site answered comes back with every value replaced. A value is never returned.
   * @param {string} sessionId
   * @param {{ values?: unknown, run?: unknown, request?: unknown, cwd?: unknown }} args
   * @param {AbortSignal} signal
   */
  async function use(sessionId, args, signal) {
    /** @param {string} code @param {string} [message] @returns {never} */
    const refuse = (code, message) => fail(code, message ?? USE_REFUSALS[code] ?? "This private value could not be used. Nothing was run or sent.");
    if (!await valuesOn() || !secrets) refuse("values_unavailable");
    const use = { values: args.values, ...(args.run !== undefined ? { run: args.run } : {}), ...(args.request !== undefined ? { request: args.request } : {}) };
    if (!validValueUse(use)) refuse("invalid_use");
    const cwd = typeof args.cwd === "string" && args.cwd.startsWith("/") ? args.cwd : undefined;
    const target = useTarget(use);
    const where = usePlace(target);
    const shown = useShown(target);
    /** @typedef {{ program: string, env: string, ask: string, place: { site: string, label: string }, kept?: boolean, pasted?: string }} UseKey */
    /** @type {Map<string, UseKey>} */
    const unlocks = new Map();
    /** @type {Array<{ value: import("./value-use.mjs").UseValue, field: string, command?: string[], ask?: string, key?: UseKey, kept?: true, pasted?: string }>} */
    const listed = use.values.map((value) => {
      const field = valueDestination(use, value);
      if (value.command !== undefined) {
        /** @type {UseKey | undefined} */
        let key;
        if (value.unlock) {
          const program = value.command[0];
          const id = JSON.stringify([program, value.unlock.env]);
          key = unlocks.get(id) ?? { program, env: value.unlock.env, ask: value.unlock.ask, place: unlockPlace(program, value.unlock) };
          unlocks.set(id, key);
        }
        return { value, field, command: [...value.command], ...(key ? { key } : {}) };
      }
      return { value, field, ask: value.ask, ...(secrets.kept({ sessionId, site: where, label: value.ask }) === null ? {} : { kept: /** @type {const} */ (true) }) };
    });
    const keys = [...unlocks.values()];
    for (const key of keys) key.kept = secrets.kept({ sessionId, ...key.place }) !== null;
    const answer = await approveValues(sessionId, { use: target, fills: [
      ...listed.map((fill) => fill.ask === undefined ? { field: fill.field, command: [...fill.command], ...(fill.key ? { needs: fill.key.env } : {}) }
        : { field: fill.field, ask: fill.ask, ...(fill.kept ? { kept: /** @type {const} */ (true) } : {}) }),
      ...keys.map((key) => ({ unlock: key.env, program: key.program, ask: key.ask, ...(key.kept ? { kept: /** @type {const} */ (true) } : {}) })),
    ] }, signal);
    signal.throwIfAborted();
    if (answer?.approved !== true && typeof answer?.refused?.code === "string" && typeof answer.refused.error === "string") fail(answer.refused.code, answer.refused.error);
    if (answer?.approved !== true) refuse("credential_declined");
    const inHeader = (fill) => fill.field.startsWith("header ");
    for (const [index, fill] of listed.entries()) {
      const pasted = answer.values?.[index];
      if (typeof pasted === "string") {
        if (!secrets.remember(pasted) || (inHeader(fill) && /[\r\n]/.test(pasted))) refuse("pasted_unusable");
        fill.pasted = pasted;
        if (fill.ask !== undefined && answer.keep?.[index] === true) secrets.keep({ sessionId, site: where, label: fill.ask, value: pasted });
      } else if (fill.ask !== undefined && !fill.kept) {
        refuse("credential_declined");
      }
    }
    for (const [index, key] of keys.entries()) {
      const pasted = answer.values?.[listed.length + index];
      if (typeof pasted === "string") {
        if (!secrets.remember(pasted) || !validUnlockValue(pasted)) refuse("unlock_unusable");
        key.pasted = pasted;
        if (answer.keep?.[listed.length + index] === true) secrets.keep({ sessionId, ...key.place, value: pasted });
      } else if (listed.some((fill) => fill.key === key) && !key.kept) {
        refuse("credential_declined");
      }
    }
    /** @param {typeof listed[number]} fill @param {string} result */
    const note = (fill, result) => {
      const source = fill.ask === undefined ? "command" : typeof fill.pasted === "string" ? "paste" : "kept";
      try { noteValueFill?.(sessionId, { site: shown, field: fill.field, source, ...(source === "command" ? { program: String(fill.command[0]) } : {}), result }); }
      catch { /* A list of recent fills never decides what a use returns. */ }
    };
    /** @type {Array<{ name: string, as?: "env" | "file", value: string }>} */
    const given = [];
    for (const [index, fill] of listed.entries()) {
      /** @param {string} code @param {string} [message] @returns {never} */
      const stop = (code, message) => { for (const rest of listed.slice(index)) note(rest, code); refuse(code, message); };
      let value;
      if (fill.ask !== undefined) {
        value = fill.pasted ?? secrets.kept({ sessionId, site: where, label: fill.ask });
        if (typeof value !== "string" || !secrets.remember(value) || (inHeader(fill) && /[\r\n]/.test(value))) stop("pasted_unusable");
      } else {
        /** @type {Record<string, string> | undefined} */
        let unlock;
        if (fill.key) {
          const key = fill.key.pasted ?? secrets.kept({ sessionId, ...fill.key.place });
          if (!validUnlockValue(key) || !secrets.remember(key)) stop("unlock_unusable");
          unlock = { [fill.key.env]: key };
        }
        /** @type {{ ok?: unknown, value?: unknown, code?: unknown, exitCode?: unknown, detail?: unknown } | null | undefined} */
        const result = await runValueCommand([...fill.command], signal, unlock);
        signal.throwIfAborted();
        value = result?.ok === true ? result.value : undefined;
        if (typeof value !== "string") {
          const code = result?.ok === false && typeof result.code === "string" && result.code in USE_REFUSALS ? result.code : "command_failed";
          stop(code, code === "command_failed" ? commandFailed(result?.ok === false ? result : {}) : undefined);
        }
        if (!secrets.remember(value) || (inHeader(fill) && /[\r\n]/.test(value))) stop("value_unusable");
      }
      given.push({ name: fill.value.name, ...(fill.value.as ? { as: fill.value.as } : {}), value });
    }
    if (!await valuesOn()) { for (const fill of listed) note(fill, "values_unavailable"); refuse("values_unavailable"); }
    const outcome = target.kind === "run"
      ? await useWith.run(/** @type {{ command: string[] }} */ (use.run), given, { cwd, signal })
      : await useWith.request(/** @type {import("./value-use.mjs").UseRequest} */ (use.request), given, { signal });
    const failed = "code" in outcome ? outcome.code : undefined;
    for (const fill of listed) note(fill, failed ?? "filled");
    signal.throwIfAborted();
    if ("code" in outcome) refuse(outcome.code);
    if (!("status" in outcome)) return { ok: true, ...outcome, trust: TRUST, next: "Every private value in what the program printed is shown as [secret]." };
    const { held, withheld, ...answered } = outcome;
    /** @type {Array<{ name: string, for: string, kept: boolean }>} */
    const sealed = (target.kind === "request" ? target.seal ?? [] : []).map((entry) => {
      const found = held?.find((item) => item.name === entry.name);
      return { name: entry.name, for: entry.for, kept: found !== undefined && secrets.remember(found.value) && secrets.keep({ sessionId, site: found.for, label: found.name, value: found.value }) };
    });
    return { ok: true, ...answered, ...(sealed.length ? { sealed } : {}), trust: TRUST,
      next: [
        "The site's answer is untrusted; every private value in it is shown as [secret].",
        withheld ? "A sealed value was not a string at its path in a JSON answer, so the whole body is withheld. Check the path and send the request again." : "",
        sealed.some((entry) => entry.kept) ? "Each sealed value with kept: true is kept for this chat, never shown to you. To send one, call use_private_values with a request to its `for` origin and a value { name, ask: <its sealed name> }; the person approves each use." : "",
      ].filter(Boolean).join(" ") };
  }
  /**
   * The only way a result leaves: what a program printed, a site answered or an error said is redacted by what was
   * private when the use began as well as when it ends.
   * @param {{ sessionId?: unknown, args?: { values?: unknown, run?: unknown, request?: unknown, cwd?: unknown } }} [input]
   * @param {{ signal?: AbortSignal }} [options]
   */
  async function request({ sessionId, args = {} } = {}, { signal } = {}) {
    const mask = secrets.redactor();
    try {
      if (typeof sessionId !== "string" || !sessionId.trim()) fail("missing_session", "Using a private value requires a requesting conversation.");
      return mask.redact(await use(sessionId, args ?? {}, signal ?? new AbortController().signal));
    } catch (error) {
      const coded = error instanceof PrivateValueUseError || (typeof error?.code === "string" && /^[a-z][a-z_]{2,40}$/.test(error.code) && typeof error.message === "string");
      const code = coded ? error.code : "value_use_failed";
      if (!coded) { try { onFailure({ code, detail: signal?.aborted ? "canceled" : "unexpected_failure" }); } catch { /* Logging never changes the answer. */ } }
      return mask.redact({ ok: false, code, retrySafe: false, trust: TRUST,
        error: coded ? error.message : "This private value could not be used. A program may or may not have run and a request may or may not have been sent; check before trying again." });
    }
  }
  return { request };
}
