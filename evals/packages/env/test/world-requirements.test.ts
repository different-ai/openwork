import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DAYTONA_API_URL,
  DAYTONA_TEAM_KEY_FROM_INFISICAL,
  FREESTYLE_KEY_FROM_INFISICAL,
  activeDaytonaProfile,
  daytonaConfigPath,
  daytonaFailure,
  daytonaLoginCheck,
  daytonaVersionSkew,
  diagnoseWorldFailure,
  freestyleKeyCheck,
} from "../src/world-requirements.ts";

const COMMAND = "pnpm world up preview-desktop --place daytona --stage alpha --detach";
const SKEW = "level=warning msg=\"Version mismatch: Daytona CLI is on v0.214.0 and API is on v0.220.0.\\nMake sure the versions are aligned\"";
const PERSONAL = { id: "org-personal", name: "Personal", personal: true };
const TEAM = { id: "org-team", name: "OpenWork", personal: false };

async function withEnv<T>(vars: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(vars).map((name) => [name, process.env[name]]));
  const apply = (values: Record<string, string | undefined>): void => {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  apply(vars);
  try {
    return await run();
  } finally {
    apply(previous);
  }
}

/** A fake `daytona` on PATH and an isolated DAYTONA_CONFIG_DIR; no real credentials are involved. */
async function fakeDaytona(options: {
  probe?: { ok: boolean; stderr?: string };
  organizations?: typeof PERSONAL[] | "api-key";
  profile?: { auth: "api-key" | "browser"; organizationId?: string };
  installed?: boolean;
}): Promise<{ env: Record<string, string>; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "openwork-fake-daytona-"));
  const bin = join(root, "bin");
  const config = join(root, "config");
  await mkdir(bin);
  await mkdir(config);
  if (options.profile) {
    await writeFile(join(config, "config.json"), JSON.stringify({
      activeProfile: "p1",
      profiles: [{
        id: "p1",
        name: "fixture",
        api: { url: DAYTONA_API_URL, ...(options.profile.auth === "api-key" ? { key: "fixture-key" } : { token: { accessToken: "fixture-token" } }) },
        ...(options.profile.organizationId ? { activeOrganizationId: options.profile.organizationId } : {}),
      }],
    }));
  }
  if (options.installed !== false) {
    const probe = options.probe ?? { ok: true };
    const organizations = options.organizations ?? [];
    const quote = (text: string): string => `'${text.replaceAll("'", "'\"'\"'")}'`;
    const script = [
      "#!/bin/sh",
      'case "$1 $2" in',
      `  "snapshot list") ${probe.stderr ? `printf '%s\\n' ${quote(probe.stderr)} >&2; ` : ""}${probe.ok ? "printf '[]\\n'; exit 0" : "exit 1"} ;;`,
      organizations === "api-key"
        ? `  "organization list") printf '%s\\n' ${quote('level=fatal msg="organization commands are not available when using API key authentication"')} >&2; exit 1 ;;`
        : `  "organization list") printf '%s\\n' ${quote(JSON.stringify(organizations))}; exit 0 ;;`,
      "esac",
      "exit 2",
      "",
    ].join("\n");
    await writeFile(join(bin, "daytona"), script, "utf8");
    await chmod(join(bin, "daytona"), 0o755);
  }
  return {
    env: { PATH: bin, DAYTONA_CONFIG_DIR: config },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

/** Pass command "" to check the way world plan does, without a command to rerun. */
async function daytonaCheck(fake: Awaited<ReturnType<typeof fakeDaytona>>, extra: Record<string, string | undefined> = {}, command = COMMAND) {
  try {
    return await withEnv({ DAYTONA_API_KEY: undefined, DAYTONA_API_URL: undefined, ...fake.env, ...extra }, () => daytonaLoginCheck.run({ place: "daytona", ...(command ? { command } : {}) }));
  } finally {
    await fake.cleanup();
  }
}

test("the Freestyle requirement names the missing key, its Infisical location, and the exact rerun", async () => {
  assert.deepEqual(freestyleKeyCheck.places, ["freestyle"]);
  assert.equal(freestyleKeyCheck.blocking, true);
  assert.match(FREESTYLE_KEY_FROM_INFISICAL, /--env dev --path \/openwork-ops --plain --silent\)"$/);
  const command = "pnpm world up preview-desktop --place freestyle --stage alpha --detach";

  const missing = await withEnv({ FREESTYLE_API_KEY: undefined }, () => freestyleKeyCheck.run({ place: "freestyle", command }));
  assert.equal(missing.ok, false);
  assert.equal(missing.detail, "FREESTYLE_API_KEY is not set");
  assert.ok(missing.hint?.endsWith(`${FREESTYLE_KEY_FROM_INFISICAL} ${command}`), missing.hint);

  // Older Infisical CLIs print "*not found*" with exit 0, so `$(...)` "succeeds" with it.
  const placeholder = await withEnv({ FREESTYLE_API_KEY: "*not found*" }, () => freestyleKeyCheck.run({ place: "freestyle", command }));
  assert.equal(placeholder.ok, false);
  assert.match(placeholder.detail ?? "", /not found/);

  const planned = await withEnv({ FREESTYLE_API_KEY: " " }, () => freestyleKeyCheck.run({ place: "freestyle" }));
  assert.match(planned.hint ?? "", /^from the repo root .*prefix the world command with FREESTYLE_API_KEY=/);

  assert.deepEqual(await withEnv({ FREESTYLE_API_KEY: "fs-test-value" }, () => freestyleKeyCheck.run({ place: "freestyle" })), { ok: true });
});

test("Daytona CLI output becomes one actionable line", () => {
  assert.equal(
    daytonaFailure('time="2026-09-30T15:46:24-07:00" level=fatal msg="Unauthorized: Invalid credentials - run \'daytona login\' to reauthenticate"\n'),
    "the Daytona CLI is not logged in (Unauthorized: Invalid credentials - run 'daytona login' to reauthenticate)",
  );
  assert.equal(
    daytonaFailure('level=fatal msg="no profiles found. Run `daytona login` to authenticate"'),
    "the Daytona CLI is not logged in (no profiles found. Run `daytona login` to authenticate)",
  );
  // The version warning comes first on every call; the fatal line is the cause.
  assert.equal(
    daytonaFailure(`${SKEW}\nlevel=fatal msg="Bad Request: Total memory limit exceeded. Maximum allowed: 10GiB.\\nTo increase concurrency limits, upgrade"`),
    "daytona snapshot list failed (Bad Request: Total memory limit exceeded. Maximum allowed: 10GiB.)",
  );
  assert.equal(daytonaFailure("dial tcp: lookup app.daytona.io: no such host\n"), "daytona snapshot list failed (dial tcp: lookup app.daytona.io: no such host)");
  assert.equal(daytonaFailure(""), "daytona snapshot list failed (no output)");
  assert.equal(daytonaVersionSkew(SKEW), "Daytona CLI v0.214.0 does not match the API v0.220.0 (brew upgrade daytonaio/cli/daytona)");
  assert.equal(daytonaVersionSkew("all good"), undefined);
});

test("the Daytona profile location and its non-secret facts", async () => {
  assert.equal(daytonaConfigPath({ DAYTONA_CONFIG_DIR: "/tmp/cfg" }, "darwin", "/Users/me"), join("/tmp/cfg", "config.json"));
  assert.equal(daytonaConfigPath({}, "darwin", "/Users/me"), join("/Users/me", "Library", "Application Support", "daytona", "config.json"));
  assert.equal(daytonaConfigPath({}, "linux", "/home/me"), join("/home/me", ".config", "daytona", "config.json"));
  assert.equal(daytonaConfigPath({ XDG_CONFIG_HOME: "/xdg" }, "linux", "/home/me"), join("/xdg", "daytona", "config.json"));
  const fake = await fakeDaytona({ profile: { auth: "browser", organizationId: "org-team" } });
  try {
    assert.deepEqual(await activeDaytonaProfile(join(fake.env.DAYTONA_CONFIG_DIR, "config.json")), { auth: "browser", name: "fixture", organizationId: "org-team" });
    assert.equal(await activeDaytonaProfile(join(fake.env.DAYTONA_CONFIG_DIR, "missing.json")), undefined);
  } finally {
    await fake.cleanup();
  }
});

test("the Daytona requirement says which identity and organization a world will use", async () => {
  assert.deepEqual(daytonaLoginCheck.places, ["daytona"]);
  assert.equal(daytonaLoginCheck.blocking, true);
  const teamRerun = `${DAYTONA_TEAM_KEY_FROM_INFISICAL} ${COMMAND}`;

  // The main-thread trap: a browser login to a personal organization passes, loudly.
  const personal = await daytonaCheck(await fakeDaytona({ profile: { auth: "browser", organizationId: "org-personal" }, organizations: [PERSONAL] }));
  assert.equal(personal.ok, true);
  assert.equal(personal.warning, true);
  assert.equal(personal.detail, 'using your Daytona browser login, organization "Personal", a personal organization with small limits and none of the team\'s warm snapshots');
  assert.equal(personal.hint, `run in the team organization: ${teamRerun}`);

  const team = await daytonaCheck(await fakeDaytona({ profile: { auth: "browser", organizationId: "org-team" }, organizations: [PERSONAL, TEAM] }));
  assert.deepEqual(team, { ok: true, detail: 'using your Daytona browser login, organization "OpenWork"' });

  const savedKey = await daytonaCheck(await fakeDaytona({ profile: { auth: "api-key" }, organizations: "api-key" }));
  assert.deepEqual(savedKey, { ok: true, detail: 'using the API key saved in Daytona CLI profile "fixture"' });

  const scoped = await daytonaCheck(await fakeDaytona({ profile: { auth: "browser", organizationId: "org-personal" }, organizations: [PERSONAL] }), { DAYTONA_API_KEY: "team-key", DAYTONA_API_URL: DAYTONA_API_URL });
  assert.deepEqual(scoped, { ok: true, detail: "using the API key in this command's environment (DAYTONA_API_KEY)" });

  // `infisical run --env dev` injects DAYTONA_API_KEY without DAYTONA_API_URL: the CLI ignores it.
  const ignored = await daytonaCheck(await fakeDaytona({ profile: { auth: "browser", organizationId: "org-personal" }, organizations: [PERSONAL] }), { DAYTONA_API_KEY: "team-key" });
  assert.equal(ignored.warning, true);
  assert.match(ignored.detail ?? "", /^DAYTONA_API_KEY is set but the Daytona CLI ignores it without DAYTONA_API_URL; using your Daytona browser login, organization "Personal", a personal organization/);
  const ignoredWithTeam = await daytonaCheck(await fakeDaytona({ profile: { auth: "browser", organizationId: "org-team" }, organizations: [TEAM] }), { DAYTONA_API_KEY: "team-key" });
  assert.equal(ignoredWithTeam.warning, true);
  assert.equal(ignoredWithTeam.hint, `the CLI reads an environment key only with DAYTONA_API_URL=${DAYTONA_API_URL}; for the team key: ${teamRerun}`);

  const skewed = await daytonaCheck(await fakeDaytona({ probe: { ok: true, stderr: SKEW }, profile: { auth: "api-key" }, organizations: "api-key" }));
  assert.equal(skewed.detail, 'using the API key saved in Daytona CLI profile "fixture"; Daytona CLI v0.214.0 does not match the API v0.220.0 (brew upgrade daytonaio/cli/daytona)');
});

test("the Daytona requirement fails with the team key as the fix", async () => {
  const teamRerun = `${DAYTONA_TEAM_KEY_FROM_INFISICAL} ${COMMAND}`;
  const placeholder = await daytonaCheck(await fakeDaytona({ installed: false }), { DAYTONA_API_KEY: "*not found*", DAYTONA_API_URL: DAYTONA_API_URL });
  assert.deepEqual(placeholder, { ok: false, detail: 'DAYTONA_API_KEY holds Infisical\'s "*not found*" placeholder', hint: `the team key lives at --env dev --path /openwork-ops: ${teamRerun}` });

  const expired = await daytonaCheck(await fakeDaytona({ probe: { ok: false, stderr: `${SKEW}\ntime="now" level=fatal msg="Unauthorized: Invalid credentials - run 'daytona login' to reauthenticate"` } }));
  assert.equal(expired.ok, false);
  assert.equal(expired.detail, "the Daytona CLI is not logged in (Unauthorized: Invalid credentials - run 'daytona login' to reauthenticate)");
  assert.equal(expired.hint, `use the team key: ${teamRerun}; or run daytona login in a terminal (a person completes the browser sign-in)`);

  const absent = await daytonaCheck(await fakeDaytona({ installed: false }), {}, "");
  assert.deepEqual(absent, { ok: false, detail: "the daytona CLI is not installed", hint: `brew install daytonaio/cli/daytona, then: prefix the world command with ${DAYTONA_TEAM_KEY_FROM_INFISICAL}` });
});

test("known provider failures come back with their fix", () => {
  const quota = `stderr:\n${SKEW}\ntime="now" level=fatal msg="Bad Request: Total memory limit exceeded. Maximum allowed: 10GiB.\\nTo increase concurrency limits, upgrade your organization's Tier"`;
  const hints = diagnoseWorldFailure(quota);
  assert.equal(hints.length, 1, "the version warning is not blamed when a real cause exists");
  assert.match(hints[0] ?? "", /^the Daytona organization this world ran in is at its 10GiB total memory limit\. If that is a personal organization/);
  assert.ok(hints[0]?.includes(DAYTONA_TEAM_KEY_FROM_INFISICAL));
  assert.match(diagnoseWorldFailure("level=fatal msg=\"Unauthorized: Invalid credentials - run 'daytona login'\"")[0] ?? "", /^Daytona rejected the credentials\. Use the team key/);
  assert.deepEqual(diagnoseWorldFailure(SKEW), ["Daytona CLI v0.214.0 does not match the API v0.220.0 (brew upgrade daytonaio/cli/daytona); this is a warning, not necessarily the cause."]);
  assert.deepEqual(diagnoseWorldFailure("TypeError: something unrelated"), []);
});
