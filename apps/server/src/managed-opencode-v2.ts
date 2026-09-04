// Parallel v2 lane prototype: provider injection is a watched-config write. This module
// deliberately has no reload/dispose call, unlike managed-opencode.ts and server.ts reloadOpencodeEngine.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";

export { installOpencodeV2Binary } from "./opencode-v2-binary.js";

import { loopbackFetch } from "./server-fetch.js";

export interface OpencodeV2ModelSpec {
  id: string;
  name: string;
}

export interface OpencodeV2ProviderSpec {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  models: OpencodeV2ModelSpec[];
}

export interface ManagedOpencodeV2ServerOptions {
  bin: string;
  rootDir: string;
  hostname?: string;
  port?: number;
  env?: Record<string, string>;
  bootTimeoutMs?: number;
}

export interface OpencodeV2Health {
  healthy: boolean;
  version: string;
  pid: number;
}

export interface ManagedOpencodeV2Server {
  url: string;
  username: string;
  password: string;
  childPid: number | undefined;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  health(): Promise<OpencodeV2Health>;
  fetchJson(path: string, init?: { method?: string; body?: unknown; directory?: string; timeoutMs?: number }): Promise<{ status: number; json: unknown }>;
  injectProvider(spec: OpencodeV2ProviderSpec): Promise<void>;
  setProviders(specs: OpencodeV2ProviderSpec[]): Promise<void>;
  close(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function freePort(hostname: string): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, hostname, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate a free TCP port"));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

function diagnostics(exitCode: number | null, stdout: string, stderr: string): Error {
  const tail = (value: string) => value.slice(-4_000);
  return new Error(
    `OpenCode v2 server exited with code ${String(exitCode)}\nstdout:\n${tail(stdout)}\nstderr:\n${tail(stderr)}`,
  );
}

export async function createManagedOpencodeV2Server(
  options: ManagedOpencodeV2ServerOptions,
): Promise<ManagedOpencodeV2Server> {
  const hostname = options.hostname ?? "127.0.0.1";
  const port = options.port ?? await freePort(hostname);
  const bootTimeoutMs = options.bootTimeoutMs ?? 60_000;
  const configDir = join(options.rootDir, "config");
  const password = randomBytes(24).toString("base64url");
  const username = "opencode";
  const url = `http://${hostname}:${port}`;
  const providers = new Map<string, OpencodeV2ProviderSpec>();
  const opencodeModelsUrl = (options.env?.OPENCODE_MODELS_URL ?? process.env.OPENCODE_MODELS_URL)?.replace(/\/+$/, "");
  // v2 runs its own plugin/catalog bootstrap; the v1 pure-mode escape hatch must not reach the sidecar.
  const inherited = { ...process.env, ...options.env };
  delete inherited.OPENCODE_PURE;
  // OpenWork control-plane credentials belong to the server, never engine tools/plugins.
  for (const key of Object.keys(inherited)) {
    if (key.startsWith("OPENWORK_")) delete inherited[key];
  }

  await mkdir(configDir, { recursive: true });
  const child = spawn(options.bin, ["serve", "--hostname", hostname, "--port", String(port)], {
    env: {
      ...inherited,
      OPENCODE_PASSWORD: password,
      OPENCODE_DB: join(options.rootDir, "opencode.db"),
      OPENCODE_CONFIG_DIR: configDir,
      ...(opencodeModelsUrl === undefined ? {} : { OPENCODE_MODELS_URL: opencodeModelsUrl }),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  let spawnError: Error | undefined;
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  child.on("error", (error) => {
    spawnError = error;
  });

  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;

  async function fetchJson(
    path: string,
    init: { method?: string; body?: unknown; directory?: string; timeoutMs?: number } = {},
  ): Promise<{ status: number; json: unknown }> {
    const separator = path.includes("?") ? "&" : "?";
    const requestPath = init.directory === undefined
      ? path
      : `${path}${separator}location%5Bdirectory%5D=${encodeURIComponent(init.directory)}`;
    const response = await loopbackFetch(`${url}${requestPath}`, {
      method: init.method,
      headers: {
        authorization,
        "content-type": "application/json",
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: init.timeoutMs === undefined ? undefined : AbortSignal.timeout(init.timeoutMs),
    });
    const text = await response.text();
    let json: unknown = text;
    try {
      json = JSON.parse(text);
    } catch {
      // Non-JSON engine responses remain observable as raw text.
    }
    return { status: response.status, json };
  }

  async function health(): Promise<OpencodeV2Health> {
    const response = await fetchJson("/api/health", { timeoutMs: 5_000 });
    if (response.status !== 200 || !isRecord(response.json)) {
      throw new Error(`OpenCode v2 health returned HTTP ${response.status}`);
    }
    const { healthy, version, pid } = response.json;
    if (typeof healthy !== "boolean" || typeof version !== "string" || typeof pid !== "number") {
      throw new Error("OpenCode v2 health returned an invalid payload");
    }
    return { healthy, version, pid };
  }

  async function writeProviders(): Promise<void> {
    const providerConfig: Record<string, unknown> = {};
    for (const provider of providers.values()) {
      const models: Record<string, unknown> = {};
      for (const model of provider.models) {
        models[model.id] = {
          name: model.name,
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          limit: { context: 128_000, output: 8_192 },
        };
      }
      providerConfig[provider.id] = {
        name: provider.name,
        package: "@opencode-ai/ai/providers/openai-compatible",
        settings: { baseURL: provider.baseUrl, apiKey: provider.apiKey, name: provider.id },
        models,
      };
    }
    const target = join(configDir, "opencode.json");
    const temporary = `${target}.tmp-${randomBytes(8).toString("hex")}`;
    await writeFile(temporary, `${JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      providers: providerConfig,
    }, null, 2)}\n`);
    await rename(temporary, target);
  }

  async function close(): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exit = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    const exited = await Promise.race([
      exit.then(() => true),
      sleep(2_000).then(() => false),
    ]);
    if (!exited && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exit;
    }
  }

  const managed: ManagedOpencodeV2Server = {
    url,
    username,
    password,
    childPid: child.pid,
    get exitCode() {
      return child.exitCode;
    },
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    health,
    fetchJson,
    async injectProvider(spec) {
      providers.set(spec.id, spec);
      await writeProviders();
    },
    async setProviders(specs) {
      providers.clear();
      for (const spec of specs) {
        providers.set(spec.id, spec);
      }
      await writeProviders();
    },
    close,
  };

  const deadline = Date.now() + bootTimeoutMs;
  while (Date.now() < deadline) {
    if (spawnError !== undefined) {
      await close();
      throw new Error(`Failed to start OpenCode v2 server: ${spawnError.message}`);
    }
    if (child.exitCode !== null || child.signalCode !== null) throw diagnostics(child.exitCode, stdout, stderr);
    try {
      const state = await health();
      if (state.healthy) return managed;
    } catch {
      // The engine can return 503 or refuse connections while booting.
    }
    await sleep(250);
  }

  await close();
  throw new Error(`Timed out waiting ${bootTimeoutMs}ms for OpenCode v2 health\nstdout:\n${stdout.slice(-4_000)}\nstderr:\n${stderr.slice(-4_000)}`);
}
