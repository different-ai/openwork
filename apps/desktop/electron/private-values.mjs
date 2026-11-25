import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { agentPermissionDenialMessage, decideAgentPermission, matchingAgentPermissionRule, wildcardMatch } from "@openwork/types/den/agent-permissions-runtime";

/**
 * Who decides whether a field of a website is filled with a value the agent never sees (`fill_from`), before the
 * person is shown the approval card: their organization's agent permissions, then their own three switches in
 * Settings. Nothing here loosens the card. The organization can block a site, a command or pasting, or make every
 * fill ask; the person can turn off commands, pasting, or keeping a pasted value for the chat. The card itself is
 * always shown: no setting fills a field without the person's yes.
 *
 * It also holds what Settings lists: the commands the person chose "Always" for, the values kept for a chat, and
 * the most recent fills. None of the three holds a value, and all of it is in memory only.
 *
 * Every program the agent names as the source of a private value becomes fill-only: while the organization keeps
 * private values out of the agent's own terminal, the engine refuses any terminal command that runs it. Which
 * programs those are is decided by use, never by a list of known names, and is kept on disk so a restart does not
 * let one back in.
 */

/** @typedef {{ commands: boolean, paste: boolean, keep: boolean }} PrivateValueSwitches */
/** @typedef {{ enabled: boolean, rules: import("@openwork/types/den/agent-permissions-runtime").AgentPermissionRule[] }} PrivateValuePolicy */
/** @typedef {{ field: string, command: string[], needs?: string, ask?: undefined, kept?: undefined, unlock?: undefined } | { field: string, ask: string, kept?: true, command?: undefined, needs?: undefined, unlock?: undefined } | { unlock: string, program: string, ask: string, kept?: true, field?: undefined, command?: undefined, needs?: undefined }} PrivateValueFill */
/** @typedef {{ kind: "run", command: string[] } | { kind: "request", method: string, url: string, origin: string, seal?: Array<{ name: string, from: string, for: string }> }} PrivateValueUse */
/** @typedef {{ at: number, sessionId: string, site: string, field: string, source: "command" | "paste" | "kept", program?: string, result: string }} PrivateValueRecord */

export const PRIVATE_VALUE_SWITCHES = /** @type {const} */ (["commands", "paste", "keep"]);
/** @type {PrivateValueSwitches} */
const SWITCHES_ON = { commands: true, paste: true, keep: true };
/** @type {PrivateValuePolicy} */
const OFF = { enabled: false, rules: [] };
const RECENT_MAX = 50;
const TELL = "Tell the person what was refused. Never ask them to type the value in the chat; if they want to enter it themselves, call browser_handoff.";

/** The person's three switches, kept in one small file of this computer's private app data. */
export function createPrivateValueSwitchStore({ file }) {
  /** @type {PrivateValueSwitches | null} */
  let known = null;
  return {
    /** @returns {Promise<PrivateValueSwitches>} */
    async read() {
      if (known) return { ...known };
      /** @type {PrivateValueSwitches} */
      const switches = { ...SWITCHES_ON };
      try {
        const saved = JSON.parse(await readFile(file, "utf8"));
        // Only an explicit off turns a switch off: a file that cannot be read leaves the card as the one gate.
        for (const name of PRIVATE_VALUE_SWITCHES) if (saved?.[name] === false) switches[name] = false;
      } catch { /* Never written, or unreadable: every switch is on. */ }
      known = switches;
      return { ...switches };
    },
    /** @param {PrivateValueSwitches} switches */
    async write(switches) {
      const next = { commands: switches.commands !== false, paste: switches.paste !== false, keep: switches.keep !== false };
      const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
      await writeFile(temporary, JSON.stringify(next), "utf8");
      await rename(temporary, file);
      known = next;
    },
  };
}

/** The programs used as a source of private values, by file name only, kept in one small file of private app data. */
export function createPrivateValueSourceStore({ file }) {
  /** @type {Set<string> | null} */
  let known = null;
  async function load() {
    if (known) return known;
    const names = new Set();
    try {
      const saved = JSON.parse(await readFile(file, "utf8"));
      if (Array.isArray(saved?.programs)) for (const name of saved.programs) if (typeof name === "string" && name) names.add(name);
    } catch { /* Never written, or unreadable: none yet. */ }
    known ??= names;
    return known;
  }
  return {
    /** @returns {Promise<string[]>} */
    async list() { return [...await load()].sort(); },
    /** @param {string[]} names */
    async add(names) {
      const programs = await load();
      const before = programs.size;
      for (const name of names) if (name) programs.add(name);
      if (programs.size === before) return;
      const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
      await writeFile(temporary, JSON.stringify({ programs: [...programs].sort() }), "utf8");
      await rename(temporary, file);
    },
  };
}

/** The file name of a program, however it was written: `/opt/homebrew/bin/bw` and `C:\\Tools\\bw.exe` are `bw`. */
export function privateValueProgramName(program) {
  const name = String(program).split(/[\\/]/).pop() ?? "";
  return name.replace(/\.(?:exe|cmd|bat|com)$/i, "");
}

/**
 * @param {PrivateValueRecord} record
 * @param {string} id
 * @returns {import("@openwork/types/den/private-value-fills").PrivateValueFillReport | null}
 */
export function privateValueReport(record, id) {
  if (record.result !== "filled" && record.result !== "declined" && record.result !== "blocked") return null;
  const result = record.result === "blocked" ? "refused" : record.result;
  const program = record.program && path.win32.basename(record.program);
  return {
    id,
    at: new Date(record.at).toISOString(),
    site: record.site,
    field: record.field,
    source: record.source,
    ...(program ? { program } : {}),
    result,
  };
}

/** The command as its rules read it: as written, and with the program's folder removed, so `bw *` covers `/opt/homebrew/bin/bw`. */
export function privateValueCommandLines(command) {
  const [program = "", ...rest] = command.map(String);
  const name = program.split(/[\\/]/).pop() || program;
  const lines = [[program, ...rest].join(" ")];
  if (name !== program) lines.push([name, ...rest].join(" "));
  return lines;
}

/**
 * @param {{
 *   readPolicy: () => Promise<unknown>,
 *   switches: { read: () => Promise<PrivateValueSwitches>, write: (switches: PrivateValueSwitches) => Promise<void> },
 *   approveValues: (sessionId: string, request: { site?: string, use?: PrivateValueUse, fills: PrivateValueFill[], limits: { everyTime: boolean, paste: boolean, keep: boolean } }, signal: AbortSignal) => Promise<{ approved: boolean, values: Array<string | null>, keep: boolean[] }>,
 *   grants: { list: () => Array<{ id: string, sessionId: string, site: string, field: string, command: string[] }>, remove: (id?: string) => boolean },
 *   sources?: { list: () => Promise<string[]>, add: (names: string[]) => Promise<void> },
 *   secrets: { listAllKept: () => Array<{ sessionId: string, site: string, label: string }>, forget: (input: { sessionId: string, site: string, label: string }) => boolean, forgetAllKept: () => void },
 *   onRecord?: (record: PrivateValueRecord) => void,
 *   now?: () => number,
 *   policyMs?: number,
 * }} input
 */
export function createPrivateValues({ readPolicy, switches, approveValues, grants, sources = memorySources(), secrets, onRecord, now = Date.now, policyMs = 30_000 }) {
  let cached = { at: Number.NEGATIVE_INFINITY, policy: OFF };
  /** @type {Promise<PrivateValuePolicy> | null} */
  let reading = null;
  /** @type {PrivateValueRecord[]} */
  const recent = [];

  const site = (policy, where) => decideAgentPermission(policy.rules, "private_value_fill", [where]);
  // The last rule that covers the command in either way of writing it decides, so `bw *` allows or blocks
  // `/opt/homebrew/bin/bw` exactly as it does `bw`, and a blocked command still wins over an allowed one.
  const commandRule = (action) => (policy, argv) => {
    const lines = privateValueCommandLines(argv);
    for (let index = policy.rules.length - 1; index >= 0; index--) {
      const rule = policy.rules[index];
      if (rule?.action === action && lines.some((line) => wildcardMatch(line, rule.resource))) return { effect: rule.effect, rule };
    }
    return { effect: "allow", rule: null };
  };
  const command = commandRule("private_value_command");
  // A program that is given private values in its environment or a file, rather than a page.
  const runs = commandRule("private_value_run");
  /** The website a request goes to: a page's site, or a request's origin. Null for a program. */
  const siteOf = (request) => request.use ? (request.use.kind === "request" ? request.use.origin : null) : request.site;
  /** Where the values go, as the person's list and the audit log name it. */
  const shownOf = (request) => !request.use ? request.site
    : request.use.kind === "run" ? `run ${privateValueCommandLines(request.use.command)[0]}`.slice(0, 400) : `${request.use.method} ${request.use.url}`.slice(0, 400);
  const pasteBlocked = (policy) => decideAgentPermission(policy.rules, "private_value_paste", ["*"]).effect !== "allow";
  const has = (policy, action, effect) => policy.rules.some((rule) => rule.action === action && rule.effect === effect);

  /**
   * The organization's answer, read again after `policyMs`. Anything but a confirmed yes with its rules is off:
   * a fill is refused while the rules that might block it cannot be read.
   * @returns {Promise<PrivateValuePolicy>}
   */
  async function current(fresh = false) {
    if (!fresh && now() - cached.at < policyMs) return cached.policy;
    reading ??= (async () => {
      /** @type {PrivateValuePolicy} */
      let policy = OFF;
      try {
        const read = /** @type {{ enabled?: unknown, rules?: unknown } | null} */ (await readPolicy());
        if (read?.enabled === true && Array.isArray(read.rules)) policy = { enabled: true, rules: read.rules };
      } catch { /* Not confirmed: off until the next read. */ }
      cached = { at: now(), policy };
      // A value pasted before the organization turned pasting off is not typed afterwards.
      if (policy.enabled && pasteBlocked(policy)) secrets.forgetAllKept();
      return policy;
    })().finally(() => { reading = null; });
    return reading;
  }

  /** @param {Omit<PrivateValueRecord, "at">} entry */
  function record(entry) {
    const kept = { at: now(), ...entry };
    recent.unshift(kept);
    recent.length = Math.min(recent.length, RECENT_MAX);
    try { onRecord?.(kept); } catch { /* Reporting a fill never decides it. */ }
  }
  const rowsOf = (fills) => fills.filter((fill) => typeof fill.field === "string");
  const sourceOf = (fill) => fill.command !== undefined ? "command" : fill.kept === true ? "kept" : "paste";
  function recordAll(sessionId, request, result) {
    for (const fill of rowsOf(request.fills)) {
      record({ sessionId, site: shownOf(request), field: String(fill.field), source: sourceOf(fill),
        ...(Array.isArray(fill.command) ? { program: String(fill.command[0]) } : {}), result });
    }
  }

  /**
   * Why this request is refused before the person is asked, or null. The organization's rules come first, so what
   * the agent is told names the rule that cannot be changed on this computer.
   * @returns {{ code: string, error: string, result: "blocked" | "off" } | null}
   */
  function refusal(policy, own, request) {
    const target = siteOf(request);
    const where = target === null ? { effect: "allow", rule: null } : site(policy, target);
    if (where.effect === "deny") {
      return { code: "values_blocked", result: "blocked",
        error: `${where.rule ? agentPermissionDenialMessage(where.rule, target) : "Your organization blocks filling private values on this website."} Nothing was run or typed. ${TELL}` };
    }
    if (request.use?.kind === "run") {
      const decision = runs(policy, request.use.command);
      if (decision.effect === "deny") {
        return { code: "value_run_blocked", result: "blocked",
          error: `${decision.rule ? agentPermissionDenialMessage(decision.rule, privateValueCommandLines(request.use.command)[0]) : "Your organization blocks giving private values to this program."} Nothing was run. ${TELL}` };
      }
    }
    const seal = request.use?.kind === "request" ? request.use.seal ?? [] : [];
    for (const entry of seal) {
      const later = site(policy, entry.for);
      if (later.effect === "deny") {
        return { code: "values_blocked", result: "blocked",
          error: `${later.rule ? agentPermissionDenialMessage(later.rule, entry.for) : "Your organization blocks private values for this website."} ${entry.name} cannot be kept for it. Nothing was sent. ${TELL}` };
      }
    }
    if (seal.length && !own.keep) {
      return { code: "value_keep_off", result: "off",
        error: `The person turned off keeping private values for the chat, in Settings under Computer use, so nothing can be sealed. Nothing was sent. Send the request without seal only if its answer holds nothing private. ${TELL}` };
    }
    const commands = request.fills.filter((fill) => Array.isArray(fill.command));
    const pasted = request.fills.filter((fill) => fill.ask !== undefined);
    const canPaste = own.paste && !pasteBlocked(policy);
    const instead = canPaste ? " Use fill_from with ask instead of command, naming the value, so the person pastes it into OpenWork's own card." : "";
    for (const fill of commands) {
      const lines = privateValueCommandLines(fill.command);
      const decision = command(policy, fill.command);
      if (decision.effect === "deny") {
        return { code: "value_command_blocked", result: "blocked",
          error: `${decision.rule ? agentPermissionDenialMessage(decision.rule, lines[0]) : "Your organization blocks getting a private value from this command."} Nothing was run or typed.${instead} ${TELL}` };
      }
    }
    if (commands.length && !own.commands) {
      return { code: "value_commands_off", result: "off",
        error: `The person turned off getting private values by running a command, in Settings under Computer use. Nothing was run or typed.${instead} ${TELL}` };
    }
    // A key a command reads is pasted too, so a command that needs one is refused with the pasting it depends on.
    const other = pasted.every((fill) => fill.unlock !== undefined)
      ? "The command needs a key the person would paste. A command that needs no key can still be used."
      : "A value can still come from a command that prints it.";
    if (pasted.length && pasteBlocked(policy)) {
      const rule = decideAgentPermission(policy.rules, "private_value_paste", ["*"]).rule;
      return { code: "value_paste_blocked", result: "blocked",
        error: `${rule ? agentPermissionDenialMessage(rule, "*") : "Your organization blocks pasting private values in the chat."} Nothing was run or typed. ${other} ${TELL}` };
    }
    if (pasted.length && !own.paste) {
      return { code: "value_paste_off", result: "off",
        error: `The person turned off pasting private values in the chat, in Settings under Computer use. Nothing was run or typed. ${other} ${TELL}` };
    }
    return null;
  }

  /**
   * What the organization set, in the words Settings shows a lock for. Null where the person decides.
   * @param {PrivateValuePolicy} policy
   * @returns {import("@openwork/types/desktop-ipc").PrivateValueSettings["organization"]}
   */
  function organization(policy) {
    const base = site(policy, "*");
    const someSites = has(policy, "private_value_fill", "deny") || has(policy, "private_value_fill", "allow");
    const commandBase = decideAgentPermission(policy.rules, "private_value_command", ["*"]);
    const someCommands = has(policy, "private_value_command", "deny");
    return {
      fills: base.effect === "deny" ? (has(policy, "private_value_fill", "allow") ? "limited" : "blocked")
        : base.effect === "ask" && base.rule ? "ask" : someSites ? "limited" : null,
      commands: commandBase.effect === "deny" ? (has(policy, "private_value_command", "allow") ? "limited" : "blocked") : someCommands ? "limited" : null,
      paste: pasteBlocked(policy) ? "blocked" : null,
    };
  }

  return {
    /** Whether fields can be filled with private values at all: the organization's rollout, confirmed. */
    enabled: async () => (await current()).enabled,
    /**
     * Asks the person, unless their organization or their own settings already said no. `refused` then says
     * which and why, in words for the agent; nothing ran and nothing was typed.
     * @param {string} sessionId
     * @param {{ site: string, use?: undefined, fills: PrivateValueFill[] } | { site?: undefined, use: PrivateValueUse, fills: PrivateValueFill[] }} request
     * @param {AbortSignal} signal
     * @returns {Promise<{ approved: boolean, values: Array<string | null>, keep: boolean[], refused?: { code: string, error: string } }>}
     */
    async approve(sessionId, request, signal) {
      const no = { approved: false, values: [], keep: [] };
      const policy = await current();
      if (!policy.enabled) return no;
      // Named as a source is enough, approved or not: the agent said this program prints private values.
      const programs = request.fills.flatMap((fill) => Array.isArray(fill.command) ? [fill.command[0]] : "program" in fill ? [fill.program] : [])
        .filter((program) => typeof program === "string").map(privateValueProgramName);
      await sources.add(programs).catch(() => undefined);
      const own = await switches.read();
      const refused = refusal(policy, own, request);
      if (refused) {
        recordAll(sessionId, request, refused.result);
        return { ...no, refused: { code: refused.code, error: refused.error } };
      }
      const target = siteOf(request);
      const where = request.use?.kind === "run" ? runs(policy, request.use.command) : site(policy, target);
      const answer = await approveValues(sessionId, { ...(request.use ? { use: request.use } : { site: request.site }), fills: request.fills, limits: {
        // The organization's own Ask first asks whatever was approved before, as it does for uploads.
        everyTime: where.effect === "ask" && where.rule !== null,
        paste: own.paste && !pasteBlocked(policy),
        keep: own.keep,
      } }, signal);
      if (answer?.approved !== true) {
        recordAll(sessionId, request, "declined");
        return no;
      }
      // The card can stay open for minutes: what changed meanwhile, on either side, still refuses.
      const later = refusal(await current(), await switches.read(), request);
      if (later) {
        recordAll(sessionId, request, later.result);
        return { ...no, refused: { code: later.code, error: later.error } };
      }
      return answer;
    },
    /**
     * The programs the agent's own terminal may not run, and who set that: every program used as a source of private
     * values, while the organization keeps them out of the terminal. Off with the rollout, or when the rules could
     * not be confirmed: the block is part of this feature and no more.
     * @returns {Promise<{ blocked: boolean, source?: string, programs?: string[] }>}
     */
    async terminal() {
      const policy = await current();
      const rule = policy.enabled ? matchingAgentPermissionRule(policy.rules, "private_value_terminal", "*") : null;
      if (rule?.effect !== "deny") return { blocked: false };
      return { blocked: true, source: rule.source, programs: await sources.list().catch(() => []) };
    },
    /** What became of one approved fill, as the browser reports it. @param {string} sessionId @param {Omit<PrivateValueRecord, "at" | "sessionId">} fill */
    note(sessionId, fill) {
      if (typeof sessionId !== "string" || typeof fill?.site !== "string" || typeof fill.field !== "string" || typeof fill.result !== "string") return;
      record({ sessionId, site: fill.site, field: fill.field, source: fill.source === "paste" || fill.source === "kept" ? fill.source : "command",
        ...(typeof fill.program === "string" ? { program: fill.program } : {}), result: fill.result });
    },
    /** Everything Settings shows, read fresh. No value is in it. @returns {Promise<import("@openwork/types/desktop-ipc").PrivateValueSettings>} */
    async list() {
      const policy = await current(true);
      if (!policy.enabled) return { enabled: false, switches: { ...SWITCHES_ON }, organization: { fills: null, commands: null, paste: null }, always: [], kept: [], recent: [] };
      return {
        enabled: true,
        switches: await switches.read(),
        organization: organization(policy),
        always: grants.list().map((grant) => ({
          id: grant.id, sessionId: grant.sessionId, site: grant.site, field: grant.field, command: grant.command.join(" "),
          blocked: site(policy, grant.site).effect === "deny" || command(policy, grant.command).effect === "deny",
        })),
        kept: secrets.listAllKept().map((entry) => ({
          id: JSON.stringify([entry.sessionId, entry.site, entry.label]), sessionId: entry.sessionId,
          // A key for a command is kept for that program, not for a website.
          ...(entry.site.startsWith("command:") ? { program: entry.site.slice("command:".length) } : { site: entry.site }),
          label: entry.label,
        })),
        recent: recent.map((entry) => ({ ...entry })),
      };
    },
    /**
     * One of the person's switches. Turning off pasting or keeping lets go of every value kept for a chat, and
     * turning off commands ends every "Always", so nothing approved before outlives the switch.
     * @param {string} name @param {boolean} enabled
     */
    async setSwitch(name, enabled) {
      if (!PRIVATE_VALUE_SWITCHES.some((entry) => entry === name) || typeof enabled !== "boolean") return { ok: false };
      const next = { ...await switches.read(), [name]: enabled };
      await switches.write(next);
      if (!enabled && name !== "commands") secrets.forgetAllKept();
      if (!enabled && name === "commands") grants.remove();
      return { ok: true };
    },
    /** Ends one "Always" or stops keeping one value. @param {"always" | "kept"} kind @param {string} id */
    remove(kind, id) {
      if (typeof id !== "string" || !id) return { ok: false };
      if (kind === "always") return { ok: grants.remove(id) };
      if (kind !== "kept") return { ok: false };
      let sessionId, where, label;
      try { [sessionId, where, label] = JSON.parse(id); } catch { return { ok: false }; }
      if (![sessionId, where, label].every((value) => typeof value === "string")) return { ok: false };
      return { ok: secrets.forget({ sessionId, site: where, label }) };
    },
  };
}

function memorySources() {
  const programs = new Set();
  return {
    /** @returns {Promise<string[]>} */
    list: async () => [...programs].sort(),
    /** @param {string[]} names */
    add: async (names) => { for (const name of names) if (name) programs.add(name); },
  };
}
