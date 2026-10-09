import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { denFetch } from "@openwork/behaviors";
import { allocateFreePort } from "@openwork/cdp";
import type { Seed } from "@openwork/env";

const repoRoot = resolve(import.meta.dirname, "../..");
const pluginDirectory = join(repoRoot, "packages/opencode-plugin");

/**
 * OpenCode 2.0.26, the release the plugin is built against, from the npm
 * registry with its published integrity. The platform package holds the
 * `opencode` binary at package/bin/opencode.
 */
const OPENCODE_VERSION = "2.0.26";
const OPENCODE_BUILDS: Record<string, { tarball: string; integrity: string }> = {
  "darwin-arm64": {
    tarball: `https://registry.npmjs.org/@opencode/cli-darwin-arm64/-/cli-darwin-arm64-${OPENCODE_VERSION}.tgz`,
    integrity: "sha512-XklldeO6eWgG8vkPNLcdlBPEm1Y+/tyhEXGZvXbk8uytpPP7SEVV2R9oZ98NMSSPH9kBAO/+Xo4sKfvD6CHAsw==",
  },
  "darwin-x64": {
    tarball: `https://registry.npmjs.org/@opencode/cli-darwin-x64/-/cli-darwin-x64-${OPENCODE_VERSION}.tgz`,
    integrity: "sha512-051fIryTH4FK4Ml63TH+IP3s7Mi+jYfVyEXSBh9aGDJUS2VZfD+AwNJ9Ew9nBPTBKYvhMGhqHcudHagRL8SBbQ==",
  },
  "linux-x64": {
    tarball: `https://registry.npmjs.org/@opencode/cli-linux-x64/-/cli-linux-x64-${OPENCODE_VERSION}.tgz`,
    integrity: "sha512-UIA2/1Ik8HaN54C4xp7H+OHgRfq995XUixrX+kLmFs8EPn1fAcmn3OoiN+3c3Vc3jEV/LHmj0Cy1SL6nW4wdGw==",
  },
  "linux-arm64": {
    tarball: `https://registry.npmjs.org/@opencode/cli-linux-arm64/-/cli-linux-arm64-${OPENCODE_VERSION}.tgz`,
    integrity: "sha512-IG316I8wVqndohzFAoWNeH83eMA8sKQFRtMeuk2Wfg4DU1haCSgzAJz3/gbytjwh6bXdWR7V3FCSrfjoraKDgw==",
  },
};

export type OpenCodeRun = { status: number | null; stdout: string; stderr: string };

export type PluginLogin = {
  verificationUrl: string;
  userCode: string;
  finished: Promise<OpenCodeRun>;
  stop(): void;
};

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

function plain(text: string): string {
  return text.replace(ANSI, "").replace(/\r/g, "");
}

async function installOpenCode(directory: string): Promise<string> {
  const key = `${process.platform}-${process.arch}`;
  const build = OPENCODE_BUILDS[key];
  if (!build) throw new Error(`No OpenCode ${OPENCODE_VERSION} build pinned for ${key}`);
  const binary = join(directory, "package", "bin", "opencode");
  if (existsSync(binary)) return binary;
  mkdirSync(directory, { recursive: true });
  const response = await fetch(build.tarball, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`Downloading OpenCode ${OPENCODE_VERSION} failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  if (integrity !== build.integrity) throw new Error(`OpenCode ${OPENCODE_VERSION} tarball integrity mismatch for ${key}`);
  const archive = join(directory, "opencode.tgz");
  writeFileSync(archive, bytes);
  const extracted = spawnSync("tar", ["-xzf", archive, "-C", directory], { encoding: "utf8" });
  if (extracted.status !== 0) throw new Error(`Extracting OpenCode failed: ${extracted.stderr}`);
  chmodSync(binary, 0o755);
  return binary;
}

/**
 * A person with an OpenWork account signed in on Den web, and OpenCode 2 on
 * their machine with the OpenWork plugin installed and no OpenWork sign-in.
 * OpenCode runs as its own process with a private home and background service.
 */
export async function opencodePluginSignIn(seed: Seed) {
  const den = await seed.den({ org: { name: "OpenCode Plugin Org", members: {} } });
  const web = await seed.web({ den, signedInAs: "admin", headless: true, viewport: { width: 1280, height: 900 } });
  const home = seed.tmpPath("opencode-plugin-home");
  const binary = await installOpenCode(seed.tmpPath(`opencode-${OPENCODE_VERSION}`));
  const configDirectory = join(home, ".config", "opencode");
  mkdirSync(configDirectory, { recursive: true });
  writeFileSync(join(configDirectory, "opencode.json"), JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    plugins: [{ package: pathToFileURL(pluginDirectory).href, options: { apiBaseUrl: den.ref.apiUrl } }],
  }, null, 2));

  // Only this world's OpenCode: none of the host's OpenCode or OpenWork settings.
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || /^(OPENCODE|OPENWORK)[A-Z_]*$/.test(name)) continue;
    env[name] = value;
  }
  Object.assign(env, {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
  });
  const children = new Set<ReturnType<typeof spawn>>();

  function run(args: string[], timeoutMs = 120_000): Promise<OpenCodeRun> {
    return new Promise((done) => {
      const child = spawn(binary, args, { env, cwd: home });
      children.add(child);
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.on("close", (status) => {
        clearTimeout(timer);
        children.delete(child);
        done({ status, stdout: plain(stdout), stderr: plain(stderr) });
      });
    });
  }

  // OpenCode's background service has one fixed default port; give this home its own.
  const configured = await run(["service", "set", "port", String(await allocateFreePort())]);
  if (configured.status !== 0) throw new Error(`Configuring the OpenCode service failed: ${configured.stdout}${configured.stderr}`);

  /** Start `opencode auth login openwork` and resolve once it has printed the link and code. */
  function startLogin(method: "browser" | "code"): Promise<PluginLogin> {
    return new Promise((ready, fail) => {
      const child = spawn(binary, ["auth", "login", "openwork", "--method", method], { env, cwd: home });
      children.add(child);
      let output = "";
      let announced = false;
      const finished = new Promise<OpenCodeRun>((done) => {
        child.on("close", (status) => {
          children.delete(child);
          if (!announced) fail(new Error(`login exited before showing a code: ${plain(output).slice(0, 800)}`));
          done({ status, stdout: plain(output), stderr: "" });
        });
      });
      const onData = (chunk: Buffer) => {
        output += String(chunk);
        if (announced) return;
        const text = plain(output);
        const url = /(https?:\/\/\S+\/device\?\S+)/.exec(text)?.[1];
        const code = /code ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(text)?.[1];
        if (!url || !code) return;
        announced = true;
        ready({ verificationUrl: url, userCode: code, finished, stop: () => child.kill("SIGTERM") });
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
    });
  }

  /** Den's rollout switch for the plugin's sign-in client, as /admin › Features sets it. */
  async function setPluginSignIn(enabled: boolean) {
    const result = await denFetch(den.ref, "/v1/admin/features/opencodePlugin", {
      method: "PUT",
      headers: { authorization: `Bearer ${den.admin.token}` },
      body: JSON.stringify({ enabled }),
    });
    if (!result.response.ok) throw new Error(`Turning opencodePlugin ${enabled ? "on" : "off"} failed: HTTP ${result.response.status} ${result.text.slice(0, 300)}`);
  }

  return {
    den,
    web,
    run,
    startLogin,
    setPluginSignIn,
    async [Symbol.asyncDispose]() {
      for (const child of children) child.kill("SIGKILL");
      spawnSync(binary, ["service", "stop"], { env, cwd: home, timeout: 30_000 });
    },
  };
}
