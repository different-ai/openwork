import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PreflightCheck } from "@openwork/world";

/**
 * Provider requirements and known provider failures for `pnpm world`. Each
 * message names the identity in use and the exact fix, because an agent reads
 * these instead of the provider docs.
 */

/** Daytona's API. The CLI uses an environment key only when this URL is set too. */
export const DAYTONA_API_URL = "https://app.daytona.io/api";

/** The team's Daytona key for one command; it never replaces anyone's CLI login. */
export const DAYTONA_TEAM_KEY_FROM_INFISICAL = `DAYTONA_API_URL=${DAYTONA_API_URL} DAYTONA_API_KEY="$(infisical secrets get DAYTONA_API_KEY --env dev --path /openwork-ops --plain --silent)"`;

/** One secret, scoped to one command; it stays on this computer and never enters a VM. */
export const FREESTYLE_KEY_FROM_INFISICAL = 'FREESTYLE_API_KEY="$(infisical secrets get FREESTYLE_API_KEY --env dev --path /openwork-ops --plain --silent)"';

/** Older Infisical CLIs print this, and exit 0, when a secret is missing at that env/path. */
const INFISICAL_NOT_FOUND = "*not found*";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type CliResult = { ok: boolean; missing: boolean; stdout: string; stderr: string };

function daytona(args: readonly string[], timeoutMs: number): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile("daytona", [...args], { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        missing: error !== null && "code" in error && error.code === "ENOENT",
        stdout: String(stdout),
        stderr: String(stderr),
      });
    });
  });
}

/** The CLI's own error line, for example `msg="Unauthorized: Invalid credentials - run 'daytona login' ..."`. */
export function daytonaFailure(stderr: string): string {
  const fatal = [...stderr.matchAll(/level=(?:fatal|error) msg="((?:[^"\\]|\\.)*)"/g)].at(-1)?.[1];
  const logged = fatal ?? /msg="((?:[^"\\]|\\.)*)"/.exec(stderr)?.[1];
  const message = (logged?.replaceAll('\\"', '"').split("\\n")[0] ?? stderr.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "no output").slice(0, 200);
  return /login|unauthori[sz]ed|credential|profile/i.test(message)
    ? `the Daytona CLI is not logged in (${message})`
    : `daytona snapshot list failed (${message})`;
}

/** The CLI warns on every call when it is out of step with the API. */
export function daytonaVersionSkew(stderr: string): string | undefined {
  const match = /Daytona CLI is on (v[0-9]+(?:\.[0-9]+)*) and API is on (v[0-9]+(?:\.[0-9]+)*)/.exec(stderr);
  return match ? `Daytona CLI ${match[1]} does not match the API ${match[2]} (brew upgrade daytonaio/cli/daytona)` : undefined;
}

/** Where the Daytona CLI keeps profiles: DAYTONA_CONFIG_DIR, else Go's os.UserConfigDir()/daytona. */
export function daytonaConfigPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = homedir()): string {
  const directory = env.DAYTONA_CONFIG_DIR?.trim();
  if (directory) return join(directory, "config.json");
  if (platform === "darwin") return join(home, "Library", "Application Support", "daytona", "config.json");
  if (platform === "win32") return join(env.APPDATA?.trim() || join(home, "AppData", "Roaming"), "daytona", "config.json");
  return join(env.XDG_CONFIG_HOME?.trim() || join(home, ".config"), "daytona", "config.json");
}

export type DaytonaProfile = { name?: string; auth: "api-key" | "browser"; organizationId?: string };

/** The active profile's non-secret facts. Key and token values are never read out. */
export async function activeDaytonaProfile(path = daytonaConfigPath()): Promise<DaytonaProfile | undefined> {
  let config: unknown;
  try { config = JSON.parse(await readFile(path, "utf8")); } catch { return undefined; }
  if (!isRecord(config) || !Array.isArray(config.profiles)) return undefined;
  const active = config.activeProfile;
  const profiles: unknown[] = config.profiles;
  const profile = profiles.find((entry) => isRecord(entry) && entry.id === active);
  if (!isRecord(profile) || !isRecord(profile.api)) return undefined;
  const auth = typeof profile.api.key === "string" && profile.api.key ? "api-key" : profile.api.token ? "browser" : undefined;
  if (!auth) return undefined;
  return {
    auth,
    ...(typeof profile.name === "string" && profile.name ? { name: profile.name } : {}),
    ...(typeof profile.activeOrganizationId === "string" && profile.activeOrganizationId ? { organizationId: profile.activeOrganizationId } : {}),
  };
}

export type DaytonaIdentity = { label: string; personal: boolean };

/**
 * Who a world will run as. The organization decides quotas and which warm
 * snapshots exist, so it is shown rather than assumed.
 */
export async function daytonaIdentity(env: NodeJS.ProcessEnv = process.env, timeoutMs = 20_000): Promise<DaytonaIdentity> {
  if (env.DAYTONA_API_KEY?.trim() && env.DAYTONA_API_URL?.trim()) {
    return { label: "the API key in this command's environment (DAYTONA_API_KEY)", personal: false };
  }
  const profile = await activeDaytonaProfile(daytonaConfigPath(env));
  if (profile?.auth === "api-key") {
    return { label: `the API key saved in Daytona CLI profile ${JSON.stringify(profile.name ?? "active")}`, personal: false };
  }
  const listed = await daytona(["organization", "list", "--format", "json"], timeoutMs);
  if (!listed.ok) {
    return { label: /API key authentication/i.test(listed.stderr) ? "an API key saved in the Daytona CLI" : "your Daytona CLI login", personal: false };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(listed.stdout); } catch { parsed = undefined; }
  const organizations = Array.isArray(parsed)
    ? parsed.filter(isRecord).flatMap((entry) => typeof entry.id === "string" && typeof entry.name === "string"
      ? [{ id: entry.id, name: entry.name, personal: entry.personal === true }]
      : [])
    : [];
  const organization = organizations.find((entry) => entry.id === profile?.organizationId)
    ?? (organizations.length === 1 ? organizations[0] : undefined);
  if (!organization) return { label: "your Daytona browser login", personal: false };
  return { label: `your Daytona browser login, organization ${JSON.stringify(organization.name)}`, personal: organization.personal };
}

/**
 * Daytona placements provision through the Daytona CLI, so probe exactly that,
 * then say which identity and organization the world will use. A personal
 * organization or an ignored environment key passes with a warning.
 */
export const daytonaLoginCheck: PreflightCheck = {
  id: "daytona",
  label: "daytona login",
  places: ["daytona"],
  blocking: true,
  timeoutMs: 20_000,
  needs: "A Daytona identity the CLI accepts: the team key in this command's environment, or a logged-in Daytona CLI. world plan shows which organization it is.",
  fix: `Team key for one command, from the repo root: ${DAYTONA_TEAM_KEY_FROM_INFISICAL} pnpm world up ...; or run daytona login in a terminal (a person completes the browser sign-in). Never use daytona login --api-key for a world: it replaces the CLI login for every tool.`,
  async run({ command }) {
    const withTeamKey = command ? `${DAYTONA_TEAM_KEY_FROM_INFISICAL} ${command}` : `prefix the world command with ${DAYTONA_TEAM_KEY_FROM_INFISICAL}`;
    const key = process.env.DAYTONA_API_KEY?.trim();
    const url = process.env.DAYTONA_API_URL?.trim();
    if (key === INFISICAL_NOT_FOUND) {
      return { ok: false, detail: `DAYTONA_API_KEY holds Infisical's "${INFISICAL_NOT_FOUND}" placeholder`, hint: `the team key lives at --env dev --path /openwork-ops: ${withTeamKey}` };
    }
    const probe = await daytona(["snapshot", "list", "-f", "json"], 20_000);
    if (probe.missing) return { ok: false, detail: "the daytona CLI is not installed", hint: `brew install daytonaio/cli/daytona, then: ${withTeamKey}` };
    if (!probe.ok) {
      return { ok: false, detail: daytonaFailure(probe.stderr), hint: `use the team key: ${withTeamKey}; or run daytona login in a terminal (a person completes the browser sign-in)` };
    }
    const identity = await daytonaIdentity();
    const skew = daytonaVersionSkew(probe.stderr);
    const using = `using ${identity.label}${skew ? `; ${skew}` : ""}`;
    const ignored = key !== undefined && key !== "" && !url ? "DAYTONA_API_KEY is set but the Daytona CLI ignores it without DAYTONA_API_URL; " : "";
    if (identity.personal) {
      return { ok: true, warning: true, detail: `${ignored}${using}, a personal organization with small limits and none of the team's warm snapshots`, hint: `run in the team organization: ${withTeamKey}` };
    }
    if (ignored) return { ok: true, warning: true, detail: `${ignored}${using}`, hint: `the CLI reads an environment key only with DAYTONA_API_URL=${DAYTONA_API_URL}; for the team key: ${withTeamKey}` };
    return { ok: true, detail: using };
  },
};

export const freestyleKeyCheck: PreflightCheck = {
  id: "freestyle",
  label: "FREESTYLE_API_KEY",
  places: ["freestyle"],
  blocking: true,
  needs: "FREESTYLE_API_KEY in this command's environment (Infisical: --env dev --path /openwork-ops). It never enters the VM.",
  fix: `From the repo root, prefix the world command: ${FREESTYLE_KEY_FROM_INFISICAL} pnpm world up ...`,
  async run({ command }) {
    const value = process.env.FREESTYLE_API_KEY?.trim();
    const withKey = command ? `${FREESTYLE_KEY_FROM_INFISICAL} ${command}` : `prefix the world command with ${FREESTYLE_KEY_FROM_INFISICAL}`;
    if (!value) return { ok: false, detail: "FREESTYLE_API_KEY is not set", hint: `from the repo root (run infisical login first if needed): ${withKey}` };
    if (value === INFISICAL_NOT_FOUND) {
      return { ok: false, detail: `FREESTYLE_API_KEY holds Infisical's "${INFISICAL_NOT_FOUND}" placeholder`, hint: `the secret was not found at that env/path; it lives at --env dev --path /openwork-ops: ${withKey}` };
    }
    return { ok: true };
  },
};

/**
 * Known provider failures, recognised in a failed world's error and log tail,
 * each with the fix. Unrecognised failures get no hint rather than a guess.
 */
export function diagnoseWorldFailure(text: string): string[] {
  const hints: string[] = [];
  const quota = /Total memory limit exceeded\. Maximum allowed: ([0-9]+\s?[GMT]i?B)/.exec(text);
  if (quota) {
    hints.push(`the Daytona organization this world ran in is at its ${quota[1]} total memory limit. If that is a personal organization (see the daytona login preflight line), run in the team organization: ${DAYTONA_TEAM_KEY_FROM_INFISICAL} pnpm world up ...; otherwise stop sandboxes you own there (daytona list).`);
  }
  if (/Unauthorized: Invalid credentials/.test(text)) {
    hints.push(`Daytona rejected the credentials. Use the team key: ${DAYTONA_TEAM_KEY_FROM_INFISICAL} pnpm world up ...; or run daytona login in a terminal.`);
  }
  const skew = daytonaVersionSkew(text);
  if (skew && hints.length === 0) hints.push(`${skew}; this is a warning, not necessarily the cause.`);
  return hints;
}
