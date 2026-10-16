import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { test } from "@openwork/testkit";
import versions from "../../../constants.json";
import { startEmbeddedServer } from "../src/embedded.ts";
import { createManagedOpencodeV2Server, installOpencodeV2Binary } from "../src/managed-opencode-v2.ts";

/**
 * A user with their own OpenCode install keeps its global config in
 * ~/.config/opencode. OpenWork's bundled engine must start no matter what is
 * in that folder, must not load it, and must not write into it.
 */

const SENTINEL_PROVIDER = "sentinel-user-provider";
const SENTINEL_PLUGIN = "file:///sentinel-user-plugin/index.js";
const GLOBAL_SKILL = "global-skill-sentinel";
const BROKEN_JSON = '{\n  "$schema": "https://opencode.ai/config.json"\n  "model": "missing/comma"\n}\n';
const SENTINEL_JSON = `${JSON.stringify({
  $schema: "https://opencode.ai/config.json",
  plugin: [SENTINEL_PLUGIN],
  provider: { [SENTINEL_PROVIDER]: { name: "Sentinel", npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://127.0.0.1:9/v1" }, models: { m: { name: "m" } } } },
}, null, 2)}\n`;

const ENV_KEYS = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME",
  "OPENWORK_DATA_DIR", "OPENWORK_TOKEN_STORE", "OPENWORK_RUNTIME_DB"];

const v1Binary = () => process.env.OPENWORK_EVAL_OPENCODE_BIN_V1
  ?? join(import.meta.dirname, "../../desktop/resources/sidecars", process.platform === "win32" ? "opencode.exe" : "opencode");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A fake user profile with their own OpenCode global config, used as this process's environment. */
async function fakeUserProfile(userConfig: string) {
  const root = await mkdtemp(join(tmpdir(), "openwork-user-opencode-"));
  const home = join(root, "home");
  const userConfigDir = join(home, ".config", "opencode");
  const workspace = join(root, "workspace");
  await mkdir(userConfigDir, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(join(userConfigDir, "opencode.json"), userConfig, "utf8");
  // OpenWork's skill picker lists this folder as global skills, so it stays usable.
  await mkdir(join(userConfigDir, "skills", GLOBAL_SKILL), { recursive: true });
  await writeFile(join(userConfigDir, "skills", GLOBAL_SKILL, "SKILL.md"),
    `---\nname: ${GLOBAL_SKILL}\ndescription: A global skill the skill picker lists.\n---\nSay hello.\n`, "utf8");
  // Also drop any OPENCODE_* settings of the shell running the test.
  const keys = [...new Set([...ENV_KEYS, ...Object.keys(process.env).filter((key) => key.startsWith("OPENCODE_"))])];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, {
    HOME: home,
    USERPROFILE: home,
    // The user's shell may set XDG_CONFIG_HOME explicitly; the engine must still ignore it.
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    OPENWORK_DATA_DIR: join(root, "openwork"),
    OPENWORK_TOKEN_STORE: join(root, "openwork", "tokens.json"),
    OPENWORK_RUNTIME_DB: join(root, "openwork", "runtime.sqlite"),
  });
  return {
    root,
    workspace,
    userConfigDir,
    async restore() {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}

for (const [label, userConfig] of [["invalid JSON", BROKEN_JSON], ["a valid sentinel provider and plugin", SENTINEL_JSON]] as const) {
  test(`v1: the desktop's managed engine starts and ignores a user OpenCode config with ${label}`, { timeout: 120_000 }, async ({ evidence }) => {
    const profile = await fakeUserProfile(userConfig);
    let stop: (() => Promise<void>) | undefined;
    try {
      const server = await startEmbeddedServer({
        host: "127.0.0.1",
        port: 0,
        token: "owt_isolation_client",
        hostToken: "owt_isolation_host",
        approvalMode: "auto",
        configPath: join(profile.root, "openwork", "server.json"),
        workspaces: [profile.workspace],
        manageOpencode: true,
        opencodeBin: v1Binary(),
      });
      stop = server.stop;
      expect(server.managedOpencode?.isAlive()).toBe(true);

      const { opencodeBaseUrl, opencodeUsername, opencodePassword } = server.config;
      const read = (path: string) => {
        const url = new URL(path, opencodeBaseUrl);
        url.searchParams.set("directory", profile.workspace);
        return fetch(url, {
          headers: { authorization: `Basic ${Buffer.from(`${opencodeUsername}:${opencodePassword}`).toString("base64")}` },
          signal: AbortSignal.timeout(30_000),
        });
      };
      const response = await read("/config");
      expect(response.status).toBe(200);
      const config: unknown = await response.json();
      expect(isRecord(config)).toBe(true);
      const providers = isRecord(config) && isRecord(config.provider) ? Object.keys(config.provider) : [];
      const plugins = isRecord(config) && Array.isArray(config.plugin) ? config.plugin : [];
      expect(providers).not.toContain(SENTINEL_PROVIDER);
      expect(plugins).not.toContain(SENTINEL_PLUGIN);

      const xdgConfigHome = server.managedOpencodeExecution?.env.find((entry) => entry.name === "XDG_CONFIG_HOME")?.value;
      expect(xdgConfigHome?.startsWith(join(profile.root, "openwork"))).toBe(true);

      const skills: unknown = await (await read("/skill")).json();
      const skillNames = Array.isArray(skills) ? skills.flatMap((skill) => isRecord(skill) && typeof skill.name === "string" ? [skill.name] : []) : [];
      expect(skillNames).toContain(GLOBAL_SKILL);

      // Nothing was written into the user's folder (no seeded schema, plugin install or .gitignore).
      expect(await readFile(join(profile.userConfigDir, "opencode.json"), "utf8")).toBe(userConfig);
      expect((await readdir(profile.userConfigDir)).sort()).toEqual(["opencode.json", "skills"]);
      evidence.recordAssertionEvidence(
        `Engine started with a user config containing ${label}`,
        `Engine XDG_CONFIG_HOME is inside OpenWork storage; /config has ${providers.length} providers and ${plugins.length} plugins, none from the user's file; the user's folder is unchanged.`,
        true,
      );
    } finally {
      await stop?.();
      await profile.restore();
    }
  });

  test(`v2: the managed engine starts and ignores a user OpenCode config with ${label}`, { timeout: 180_000 }, async ({ evidence }) => {
    const bin = process.env.OPENWORK_EVAL_OPENCODE2_BIN
      ?? await installOpencodeV2Binary(join(tmpdir(), "openwork-opencode-v2-verified"), versions.opencodeV2Version);
    const profile = await fakeUserProfile(userConfig);
    const rootDir = join(profile.root, "openwork", "engine-v2");
    const server = await createManagedOpencodeV2Server({ bin, rootDir, env: { OPENCODE_DISABLE_MODELS_FETCH: "1" } });
    try {
      expect((await server.health()).healthy).toBe(true);
      const sources = await server.fetchJson("/api/config", { directory: profile.workspace });
      expect(sources.status).toBe(200);
      expect(JSON.stringify(sources.json)).not.toContain(profile.userConfigDir);
      const providers = await server.fetchJson("/api/provider", { directory: profile.workspace });
      expect(providers.status).toBe(200);
      expect(JSON.stringify(providers.json)).not.toContain(SENTINEL_PROVIDER);
      expect(await readFile(join(profile.userConfigDir, "opencode.json"), "utf8")).toBe(userConfig);
      expect((await readdir(profile.userConfigDir)).sort()).toEqual(["opencode.json", "skills"]);
      evidence.recordAssertionEvidence(
        `Engine v2 started with a user config containing ${label}`,
        "Config sources list only OpenWork's folders, the sentinel provider is absent, and the user's folder is unchanged.",
        true,
      );
    } finally {
      await server.close();
      await profile.restore();
    }
  });
}

test("v1: a broken workspace opencode.json does not stop the engine and names the file", { timeout: 120_000 }, async ({ evidence }) => {
  const profile = await fakeUserProfile("{}\n");
  const other = join(profile.root, "other-workspace");
  await mkdir(other, { recursive: true });
  await writeFile(join(profile.workspace, "opencode.json"), BROKEN_JSON, "utf8");
  let stop: (() => Promise<void>) | undefined;
  try {
    const server = await startEmbeddedServer({
      host: "127.0.0.1",
      port: 0,
      token: "owt_isolation_client",
      hostToken: "owt_isolation_host",
      approvalMode: "auto",
      configPath: join(profile.root, "openwork", "server.json"),
      workspaces: [profile.workspace, other],
      manageOpencode: true,
      opencodeBin: v1Binary(),
    });
    stop = server.stop;
    expect(server.managedOpencode?.isAlive()).toBe(true);
    const { opencodeBaseUrl, opencodeUsername, opencodePassword } = server.config;
    const read = async (directory: string) => {
      const url = new URL("/config", opencodeBaseUrl);
      url.searchParams.set("directory", directory);
      return fetch(url, {
        headers: { authorization: `Basic ${Buffer.from(`${opencodeUsername}:${opencodePassword}`).toString("base64")}` },
        signal: AbortSignal.timeout(30_000),
      });
    };
    const broken = await read(profile.workspace);
    expect(broken.ok).toBe(false);
    const body = await broken.text();
    expect(body).toContain("ConfigJsonError");
    expect(body).toContain(join(profile.workspace, "opencode.json"));
    expect((await read(other)).status).toBe(200);
    evidence.recordAssertionEvidence(
      "Broken workspace config is reported, not fatal",
      `The engine stays up; the broken folder answers ${broken.status} ConfigJsonError naming its opencode.json; another folder still answers 200.`,
      true,
    );
  } finally {
    await stop?.();
    await profile.restore();
  }
});
