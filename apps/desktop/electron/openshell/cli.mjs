// Light introspection layer for the OpenShell CLI inside our distro.
//
// The upstream binary changes faster than we can pin: `gateway start`,
// `init`, `provider create` and their flags have all moved between
// releases. Hard-coding any particular verb means a banker laptop that
// installed last week breaks when upstream ships next week.
//
// This module gives the rest of the code two cheap primitives:
//
//   getCliInfo()
//     → { available, version, raw, subcommands, error }
//     Probes `openshell --help` once per process. Memoized — if the
//     binary or distro is offline the result is sticky for the session
//     so retries don't fan out into N help invocations.
//
//   hasSubcommand(parent | null, child)
//     → boolean
//     Parses `openshell [parent] --help` and answers "is `child` a known
//     verb?". Used by installer.phaseOpenshell and main.openshellGatewayRestart
//     to decide between the documented path, an alternate verb, or a
//     docker-direct fallback.
//
// On a Linux dev box the binary doesn't exist — every probe reports
// {available: false}. The installer and gateway-restart paths surface
// that to the user with the actual stderr so we don't pretend the CLI
// is fine when it's not.
//
// Tests stub these via __testing.setMockCliInfo(); they don't need to
// run openshell to exercise dispatch logic.

import { DISTRO_NAME, wslRun } from "./wsl.mjs";

const HELP_TIMEOUT_MS = 10_000;
const VERSION_TIMEOUT_MS = 5_000;

/** @type {Promise<CliInfo> | null} */
let cachedInfo = null;
/** @type {CliInfo | null} */
let mockInfo = null;

/**
 * @typedef {Object} CliInfo
 * @property {boolean} available     True iff `openshell --help` exited 0
 * @property {string|null} version   Parsed from `openshell --version` (best-effort)
 * @property {string} rawHelp        Raw `openshell --help` output (or stderr if it failed)
 * @property {Set<string>} subcommands  Top-level subcommand names parsed from --help
 * @property {string|null} error     stderr/exit reason when available === false
 */

/**
 * Probe the CLI once. Subsequent calls return the cached result. Call
 * resetCache() after a successful install to force a refresh.
 */
export async function getCliInfo() {
  if (mockInfo) return mockInfo;
  if (cachedInfo) return cachedInfo;
  cachedInfo = probe();
  return cachedInfo;
}

/**
 * Returns true if `openshell <parent> <child>` is a documented verb.
 * When parent is null, checks the top-level help. Falls back to true if
 * we can't probe (so the caller still attempts the call and surfaces
 * the real error rather than silently skipping).
 */
export async function hasSubcommand(parent, child) {
  const info = await getCliInfo();
  if (!info.available) return false;
  if (!parent) return info.subcommands.has(child);
  // Probe the parent's own help. Cheap and per-parent-cached so we
  // don't redo it for every check inside one install run.
  const subs = await probeSubcommands(parent);
  return subs.has(child);
}

/** @type {Map<string, Promise<Set<string>>>} */
const subcommandCache = new Map();

function probeSubcommands(parent) {
  if (mockInfo) {
    // Allow tests to seed { subcommands: { gateway: ["start", ...] } }
    const seeded = mockInfo.parentSubcommands?.[parent];
    return Promise.resolve(new Set(seeded ?? []));
  }
  if (subcommandCache.has(parent)) return subcommandCache.get(parent);
  const p = wslRun(
    ["-d", DISTRO_NAME, "--", "openshell", parent, "--help"],
    { timeout: HELP_TIMEOUT_MS },
  )
    .then((r) => {
      const text = r.exitCode === 0 ? r.stdout : `${r.stdout}\n${r.stderr}`;
      return extractSubcommands(text);
    })
    .catch(() => new Set());
  subcommandCache.set(parent, p);
  return p;
}

async function probe() {
  let help;
  try {
    help = await wslRun(
      ["-d", DISTRO_NAME, "--", "openshell", "--help"],
      { timeout: HELP_TIMEOUT_MS },
    );
  } catch (err) {
    return {
      available: false,
      version: null,
      rawHelp: "",
      subcommands: new Set(),
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (help.exitCode !== 0) {
    return {
      available: false,
      version: null,
      rawHelp: help.stdout || help.stderr || "",
      subcommands: new Set(),
      error: (help.stderr || help.stdout || `exit ${help.exitCode}`).trim(),
    };
  }
  const version = await probeVersion().catch(() => null);
  return {
    available: true,
    version,
    rawHelp: help.stdout,
    subcommands: extractSubcommands(help.stdout),
    error: null,
  };
}

async function probeVersion() {
  // Try the JSON form first (newer CLIs), fall back to plain text.
  const j = await wslRun(
    ["-d", DISTRO_NAME, "--", "openshell", "--version", "--json"],
    { timeout: VERSION_TIMEOUT_MS },
  ).catch(() => null);
  if (j && j.exitCode === 0) {
    try {
      const parsed = JSON.parse(j.stdout);
      if (typeof parsed?.version === "string") return parsed.version;
    } catch {
      // fall through
    }
  }
  const p = await wslRun(
    ["-d", DISTRO_NAME, "--", "openshell", "--version"],
    { timeout: VERSION_TIMEOUT_MS },
  ).catch(() => null);
  if (p && p.exitCode === 0) {
    // Match either bare `1.2.3` or `v1.2.3` (some forks prefix). Don't
    // fall back to the raw stdout — if the regex misses, the output is
    // probably help text or an error string, not a version.
    const m = p.stdout.match(/v?(\d+\.\d+(?:\.\d+)?)/);
    return m ? m[1] : null;
  }
  return null;
}

// `openshell --help` typically prints a COMMANDS / SUBCOMMANDS block
// followed by indented `name   description` rows. We scan for any line
// that starts with two-or-more spaces, an identifier, and at least one
// space (an indented row). This is loose on purpose — CLI help formats
// vary across versions and we'd rather over-recognize than miss a real
// verb and silently skip a working code path.
function extractSubcommands(text) {
  const out = new Set();
  if (typeof text !== "string") return out;
  let inCommandsBlock = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\t/g, "    ");
    if (/^(COMMANDS|SUBCOMMANDS|Commands|Subcommands):?\s*$/.test(line.trim())) {
      inCommandsBlock = true;
      continue;
    }
    if (inCommandsBlock && line.trim() === "") {
      inCommandsBlock = false;
      continue;
    }
    // In COMMANDS block we accept any indented `name ...` row. Outside
    // it we still accept rows that look like `  name  description`
    // because some CLIs (e.g. clipanion-derived) don't print a header.
    const m = line.match(/^\s{2,}([a-z][a-z0-9-]*)(\s|$)/);
    if (m) {
      out.add(m[1]);
    }
  }
  return out;
}

export function resetCache() {
  cachedInfo = null;
  subcommandCache.clear();
}

export const __testing = {
  extractSubcommands,
  setMockCliInfo(info) {
    mockInfo = info;
  },
  clearMockCliInfo() {
    mockInfo = null;
  },
  resetAll() {
    mockInfo = null;
    resetCache();
  },
};
