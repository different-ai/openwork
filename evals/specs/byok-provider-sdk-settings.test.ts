import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { eventually, test } from "@openwork/testkit";
import { expect } from "vitest";
import { aiSdkEnvSettings } from "../../ee/packages/utils/src/ai-sdk-env-settings";
import { toRuntimeProviderEnv } from "../../ee/apps/den-api/src/llm/provider-credentials";
import { createManagedOpencodeServer } from "../../apps/server/src/managed-opencode";
import versions from "../../constants.json";

/**
 * Bring-your-own-key catalog providers leave Den under provider-scoped env
 * names (LPR_<tag>_AWS_REGION), which the AI SDK never reads by itself. Den
 * binds them to SDK options from aiSdkEnvSettings (#5705). These tests prove,
 * against the pinned OpenCode engine:
 *
 *   1. aiSdkEnvSettings is exactly the env → option list that the SDK copies
 *      bundled in that engine read, so an engine bump that changes it fails here;
 *   2. a Bedrock provider with only scoped env names reaches the wire with its
 *      region and credentials, for both access keys and a Bedrock API key.
 */

const exec = promisify(execFile);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function pinnedEngineBinary(): string {
  return process.env.OPENWORK_EVAL_OPENCODE_BIN_V1
    ?? join(import.meta.dirname, "../../apps/desktop/resources/sidecars", process.platform === "win32" ? "opencode.exe" : "opencode");
}

async function expectPinnedEngine(binary: string): Promise<void> {
  expect((await exec(binary, ["--version"])).stdout.trim()).toBe(versions.opencodeVersion.replace(/^v/, ""));
}

// Minified forms of `loadSetting({ settingValue: options.region, settingName: "region",
// environmentVariableName: "AWS_REGION" })` and `loadApiKey({ apiKey: options.apiKey,
// environmentVariableName: "AZURE_API_KEY" })` as the SDKs ship inside the engine.
const SETTING_PATTERN = /(?:settingValue|apiKey):[A-Za-z_$][\w$]*\.([A-Za-z]+),(?:settingName:"[A-Za-z]+",)?environmentVariableName:"([A-Z][A-Z0-9_]*)"/g;

test("aiSdkEnvSettings matches the SDKs bundled in the pinned engine", { timeout: 60_000 }, async ({ evidence }) => {
  const binary = pinnedEngineBinary();
  await expectPinnedEngine(binary);
  const source = (await readFile(binary)).toString("latin1");

  const optionsByEnv = new Map<string, Set<string>>();
  for (const [, option, envName] of source.matchAll(SETTING_PATTERN)) {
    if (!option || !envName) continue;
    const options = optionsByEnv.get(envName) ?? new Set<string>();
    options.add(option);
    optionsByEnv.set(envName, options);
  }
  expect(optionsByEnv.size, "no SDK settings found: the engine bundle format changed, update SETTING_PATTERN").toBeGreaterThan(0);

  const extracted = Object.fromEntries([...optionsByEnv].sort(([left], [right]) => left.localeCompare(right))
    .map(([envName, options]) => [envName, [...options].sort().join(" | ")]));
  evidence.recordAssertionEvidence("env → SDK option pairs in the pinned engine", JSON.stringify(extracted), true);
  // One option per env name: the binding is keyed by env name alone.
  for (const [envName, options] of optionsByEnv) expect([...options], envName).toHaveLength(1);
  expect(aiSdkEnvSettings).toEqual(extracted);
});

test("a BYOK Bedrock provider with only scoped env names reaches the wire", { timeout: 180_000 }, async ({ evidence }) => {
  const binary = pinnedEngineBinary();
  await expectPinnedEngine(binary);

  const requests: { path: string; authorization: string }[] = [];
  const witness = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain */ }
    if (request.method === "POST") requests.push({ path: request.url ?? "", authorization: String(request.headers.authorization ?? "") });
    // Capture dispatch only; a 400 is non-retryable and no completion is claimed.
    response.writeHead(request.method === "POST" ? 400 : 200, { "content-type": "application/json" });
    response.end(request.method === "POST" ? JSON.stringify({ message: "Synthetic wire witness" }) : "{}");
  });
  await new Promise<void>((resolve) => witness.listen(0, "127.0.0.1", resolve));
  const address = witness.address();
  if (!address || typeof address === "string") throw new Error("Witness did not bind");
  const baseURL = `http://127.0.0.1:${address.port}`;
  const root = await mkdtemp(join(tmpdir(), "byok-bedrock-"));
  const directory = join(root, "workspace");
  await mkdir(directory);

  // The models.dev Bedrock entry as Den stores it, and two rows' credentials.
  const bedrockNpm = "@ai-sdk/amazon-bedrock";
  const catalogConfig: Record<string, unknown> = {
    npm: bedrockNpm,
    env: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION", "AWS_BEARER_TOKEN_BEDROCK"],
  };
  const rows: { id: string; apiKeys: Record<string, string> }[] = [
    { id: "lpr_01kx00000000000000000keys1", apiKeys: { AWS_ACCESS_KEY_ID: "AKIDSYNTHETIC", AWS_SECRET_ACCESS_KEY: "synthetic-secret", AWS_REGION: "eu-central-2" } },
    { id: "lpr_01kx00000000000000000tokn2", apiKeys: { AWS_BEARER_TOKEN_BEDROCK: "synthetic-bedrock-token", AWS_REGION: "ap-south-1" } },
  ];
  const modelId = "anthropic.synthetic-witness-v1:0";
  const provider: Record<string, unknown> = {};
  const scopedEnv: Record<string, string> = {};
  for (const row of rows) {
    const runtime = toRuntimeProviderEnv({ id: row.id, source: "models_dev", providerConfig: catalogConfig, apiKeys: row.apiKeys });
    const options = isRecord(runtime.providerConfig.options) ? runtime.providerConfig.options : {};
    evidence.recordAssertionEvidence(`${row.id} SDK options from Den`, JSON.stringify(options), true);
    Object.assign(scopedEnv, runtime.apiKeys);
    provider[row.id] = {
      id: "amazon-bedrock", name: row.id, env: runtime.providerConfig.env, npm: bedrockNpm,
      // Point the SDK at the witness; region and credentials still come from Den's bindings.
      options: { ...options, baseURL },
      models: { [modelId]: { id: modelId, name: "Synthetic witness" } },
    };
  }
  expect(Object.keys(scopedEnv).every((name) => name.startsWith("LPR_"))).toBe(true);

  const configPath = join(root, "opencode.json");
  await writeFile(configPath, JSON.stringify({ provider }));
  const server = await createManagedOpencodeServer({
    bin: binary, cwd: directory, timeoutMs: 60_000,
    env: {
      ...scopedEnv,
      // Bare names from the host would let the SDK succeed without the fix.
      AWS_REGION: undefined, AWS_DEFAULT_REGION: undefined, AWS_ACCESS_KEY_ID: undefined,
      AWS_SECRET_ACCESS_KEY: undefined, AWS_SESSION_TOKEN: undefined, AWS_BEARER_TOKEN_BEDROCK: undefined, AWS_PROFILE: undefined,
      HOME: root, OPENCODE_CONFIG: configPath, OPENCODE_MODELS_URL: baseURL, OPENCODE_DISABLE_MODELS_FETCH: "1",
      XDG_CONFIG_HOME: join(root, "xdg"), XDG_DATA_HOME: join(root, "data"),
      XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"),
    },
  });
  try {
    const request = async (path: string, body?: unknown): Promise<unknown> => {
      const url = new URL(path, server.url);
      url.searchParams.set("directory", directory);
      const response = await fetch(url, {
        method: body === undefined ? "GET" : "POST",
        headers: { "content-type": "application/json", authorization:
          `Basic ${Buffer.from(`${server.username}:${server.password}`).toString("base64")}` },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60_000),
      });
      expect(response.status).toBe(200);
      return response.json();
    };

    for (const row of rows) {
      const session = await request("/session", { title: "BYOK Bedrock witness" });
      if (!isRecord(session) || typeof session.id !== "string") throw new Error("Session ID missing");
      const offset = requests.length;
      await request(`/session/${session.id}/message`, {
        model: { providerID: row.id, modelID: modelId }, parts: [{ type: "text", text: "Reply hello." }],
      });
      const dispatched = await eventually(
        () => requests.slice(offset).find((entry) => entry.path.includes(encodeURIComponent(modelId))),
        { within: 30_000, intervalMs: 100, label: `${row.id} reaches the Bedrock witness`, until: (value) => value !== undefined },
      );
      if (!dispatched) throw new Error(`${row.id}: no request reached the witness`);
      const credential = /Credential=([^,]+)/.exec(dispatched.authorization)?.[1] ?? null;
      evidence.recordAssertionEvidence(`${row.id} request on the wire`, JSON.stringify({
        path: dispatched.path, scheme: dispatched.authorization.split(" ")[0], credentialScope: credential?.replace(/^[^/]+/, "<key id>"),
      }), true);
      if (row.apiKeys.AWS_BEARER_TOKEN_BEDROCK) {
        expect(dispatched.authorization).toBe(`Bearer ${row.apiKeys.AWS_BEARER_TOKEN_BEDROCK}`);
      } else {
        // SigV4 scope: <key id>/<date>/<region>/bedrock/aws4_request
        expect(credential?.split("/")).toEqual([row.apiKeys.AWS_ACCESS_KEY_ID, expect.stringMatching(/^\d{8}$/), row.apiKeys.AWS_REGION, "bedrock", "aws4_request"]);
      }
    }
  } finally {
    await server.close();
    witness.closeAllConnections();
    await new Promise<void>((resolve, reject) => witness.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
