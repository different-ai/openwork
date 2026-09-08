import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { allocateFreePort } from "@openwork/cdp";
import { createDaytonaHost, defaultDaytonaExec, execInSandbox } from "@openwork/hosts";
import type { Seed } from "@openwork/env";

const root = fileURLToPath(new URL("../../", import.meta.url));
const fixture = "evals/packages/labs/src/anonymous-inference-fixture.mjs";
const loader = "./ee/apps/den-api/node_modules/tsx/dist/loader.mjs";
const encryptionKey = "anonymous-inference-fixture-encryption-key-not-production";
const tokenSecret = "anonymous-inference-fixture-token-secret-not-production";
const accountingIdentityKey = "anonymous-inference-fixture-accounting-key-not-production";
const anonymousUpstreamKey = "anonymous-inference-fixture-upstream";
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const remoteSourcePaths = [
  "apps/app/src/app/constants.ts",
  "apps/app/src/components/chat/message-list.tsx",
  "apps/app/src/react-app/domains/cloud/openwork-models-promo.ts",
  "apps/app/src/react-app/domains/connections/provider-auth/store.ts",
  "apps/app/src/react-app/domains/onboarding/provider-selection-step.tsx",
  "apps/app/src/react-app/domains/session/chat/session-empty-hero.tsx",
  "apps/app/src/react-app/domains/session/sync/session-error.ts",
  "apps/app/src/react-app/kernel/model-config.ts",
  "apps/app/src/react-app/shell/settings-route.tsx",
  "apps/app/src/react-app/shell/welcome-route.tsx",
  "apps/desktop/electron/main.mjs",
  "apps/desktop/electron/runtime.mjs",
  "apps/server/src/anonymous-inference.ts",
  "apps/server/src/embedded.ts",
  "apps/server/src/openwork-runtime-config.ts",
  "apps/server/src/runtime-opencode-config-store.ts",
  "apps/server/src/server.ts",
  "apps/server/src/types.ts",
  "ee/apps/inference/src/anonymous-identity.ts",
  "ee/apps/inference/src/anonymous-limits.ts",
  "ee/apps/inference/src/anonymous.ts",
  "ee/apps/inference/src/app.ts",
  "ee/apps/inference/src/env.ts",
  "ee/packages/den-db/drizzle/0094_anonymous_inference.sql",
  "ee/packages/den-db/src/schema/inference.ts",
  fixture,
];

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected an object");
  return Object.fromEntries(Object.entries(value));
}

export async function anonymousInferenceWorld(seed: Seed) {
  const den = await seed.den({
    org: { name: "Anonymous Inference Boundary", admin: { name: "Models Admin" } },
    env: { DEN_DB_ENCRYPTION_KEY: encryptionKey, DEN_ORG_MODE: "multi_org", DEN_PLAN_GATING_ENABLED: "true" },
  });
  const context = object((await seed.api(den.admin, "/v1/org")).body);
  const orgId = String(object(context.organization).id);
  const memberId = String(object(context.currentMember).id);
  const remote = den.placement?.kind === "daytona" ? den.placement.sandboxId : null;
  const ports = remote
    ? { primary: 8791, secondary: 8793, expiring: 8794, unconfigured: 8795, rotated: 8796, trustedNeighbor: 8797, slow: 8798, globalSpend: 8799, witness: 8792, clientProxy: 8800 }
    : {
        primary: await allocateFreePort(), secondary: await allocateFreePort(), expiring: await allocateFreePort(),
        unconfigured: await allocateFreePort(), rotated: await allocateFreePort(), trustedNeighbor: await allocateFreePort(),
        slow: await allocateFreePort(), globalSpend: await allocateFreePort(), witness: await allocateFreePort(), clientProxy: await allocateFreePort(),
      };
  const host = remote ? createDaytonaHost({ sandboxId: remote, repoRoot: root, log: () => {} }) : null;
  const url = async (port: number) => host ? host.previewUrl(port) : `http://127.0.0.1:${port}`;
  const [primaryUrl, secondaryUrl, expiringUrl, unconfiguredUrl, rotatedUrl, slowUrl, globalSpendUrl, witnessUrl, clientUrl] = await Promise.all([
    url(ports.primary), url(ports.secondary), url(ports.expiring), url(ports.unconfigured), url(ports.rotated),
    url(ports.slow), url(ports.globalSpend), url(ports.witness), url(ports.clientProxy),
  ]);
  const trustedNeighborUrl = remote ? await url(ports.trustedNeighbor) : `http://[::1]:${ports.trustedNeighbor}`;
  const databaseUrlCandidate = remote ? "mysql://root:password@127.0.0.1:3306/openwork_den" : den.database?.url;
  if (!databaseUrlCandidate) throw new Error("Anonymous inference proof requires an isolated Den database");
  const databaseUrl = databaseUrlCandidate;
  const baseEnv: Record<string, string> = {
    OPENWORK_DEV_MODE: "1", DATABASE_URL: databaseUrl, DB_MODE: "mysql", DEN_DB_ENCRYPTION_KEY: encryptionKey,
    SENTRY_DSN: "", OPENROUTER_UPSTREAM_URL: `http://127.0.0.1:${ports.witness}`,
    ANONYMOUS_INFERENCE_ENABLED: "true", ANONYMOUS_OPENROUTER_API_KEY: anonymousUpstreamKey,
    ANONYMOUS_TOKEN_SECRET: tokenSecret, ANONYMOUS_ACCOUNTING_IDENTITY_KEY: accountingIdentityKey,
    ANONYMOUS_OPENROUTER_PROVIDER: "fixture-provider",
    ANONYMOUS_OPENROUTER_BYOK_ONLY_VERIFIED: "true", ANONYMOUS_TOKEN_TTL_SECONDS: "300",
    ANONYMOUS_INSTALL_DAILY_MICRO_USD: "1000000", ANONYMOUS_INSTALL_MONTHLY_MICRO_USD: "10000000",
    ANONYMOUS_IP_DAILY_MICRO_USD: "83200", ANONYMOUS_GLOBAL_DAILY_MICRO_USD: "10000000",
    ANONYMOUS_GLOBAL_MONTHLY_MICRO_USD: "100000000", ANONYMOUS_GLOBAL_INFLIGHT: "2",
    ANONYMOUS_SESSION_INSTALL_HOURLY: "4", ANONYMOUS_SESSION_IP_HOURLY: "4",
    ANONYMOUS_SESSION_GLOBAL_HOURLY: "1000", ANONYMOUS_REQUEST_INSTALL_HOURLY: "100",
    ANONYMOUS_REQUEST_IP_HOURLY: "100", ANONYMOUS_REQUEST_GLOBAL_HOURLY: "1000",
    ANONYMOUS_REQUEST_TIMEOUT_MS: "10000",
  };
  const children: ReturnType<typeof spawn>[] = [];
  const diagnostics: string[] = [];
  async function sandboxExec(sandbox: string, script: string, label: string, timeoutMs = 60_000) {
    const encoded = Buffer.from(script).toString("base64");
    const result = await execInSandbox(defaultDaytonaExec, sandbox, `printf %s ${encoded} | base64 -d | bash`, { timeoutMs, context: label });
    if (result.code !== 0) throw new Error(`${label} failed: ${(result.stderr || result.stdout).slice(-1000)}`);
    return result.stdout;
  }
  async function remoteExec(script: string, label: string, timeoutMs = 60_000) {
    if (!remote) throw new Error("Missing remote sandbox");
    return sandboxExec(remote, script, label, timeoutMs);
  }
  async function syncRemoteSources(sandbox: string) {
    const sources = await Promise.all(remoteSourcePaths.map(async (path) => ({ path, content: await readFile(`${root}/${path}`, "utf8") })));
    const archive = gzipSync(Buffer.from(JSON.stringify(sources))).toString("base64");
    const archivePath = "/tmp/openwork-anonymous-sources.json.gz.b64";
    await sandboxExec(sandbox, `: > ${archivePath}`, "Prepare anonymous source upload");
    for (let offset = 0; offset < archive.length; offset += 6_000) {
      await sandboxExec(sandbox, `printf %s ${archive.slice(offset, offset + 6_000)} >> ${archivePath}`, "Upload anonymous sources");
    }
    await sandboxExec(sandbox, `python3 - <<'PY'
import base64,gzip,json,os
archive='${archivePath}'
sources=json.loads(gzip.decompress(base64.b64decode(open(archive,'rb').read())).decode())
for source in sources:
 target=os.path.join('/workspace',source['path'])
 os.makedirs(os.path.dirname(target),exist_ok=True)
 with open(target,'w',encoding='utf-8') as output: output.write(source['content'])
os.remove(archive)
PY`, "Install anonymous sources");
  }
  function processEnv(env: Record<string, string>) { return { ...process.env, ...env }; }
  async function start(args: string[], env: Record<string, string>, label: string) {
    if (remote) {
      const config = Buffer.from(JSON.stringify(env)).toString("base64");
      const command = Buffer.from(JSON.stringify(args)).toString("base64");
      await remoteExec(`python3 - <<'PY'\nimport os,json,base64,subprocess\ne=dict(os.environ);e.update(json.loads(base64.b64decode('${config}')))\na=json.loads(base64.b64decode('${command}'))\nwith open('/tmp/${label}.log','ab',buffering=0) as log:\n subprocess.Popen(a,cwd='/workspace',env=e,stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)\nPY`, `Start ${label}`);
      return;
    }
    const child = spawn(args[0] ?? "node", args.slice(1), { cwd: root, env: processEnv(env), stdio: ["ignore", "pipe", "pipe"] });
    const collect = (chunk: Buffer) => { diagnostics.push(`${label}: ${chunk.toString()}`); if (diagnostics.length > 200) diagnostics.shift(); };
    child.stdout?.on("data", collect); child.stderr?.on("data", collect);
    children.push(child);
  }
  async function fixtureCommand(command: string, ...args: string[]) {
    const commandArgs = ["node", "--conditions=development", "--import", loader, fixture, command, ...args];
    if (remote) {
      const shell = `cd /workspace && env ${Object.entries(baseEnv).map(([key, value]) => `${key}=${quote(value)}`).join(" ")} ${commandArgs.map(quote).join(" ")}`;
      return remoteExec(shell, `Anonymous fixture ${command}`);
    }
    return new Promise<string>((resolve, reject) => {
      const child = spawn(commandArgs[0] ?? "node", commandArgs.slice(1), { cwd: root, env: processEnv(baseEnv), stdio: ["ignore", "pipe", "pipe"] });
      let stdout = ""; let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      child.once("exit", (code) => code === 0 ? resolve(stdout) : reject(new Error(`Fixture ${command} failed: ${stderr.slice(-1000)}`)));
    });
  }

  if (remote) await syncRemoteSources(remote);
  await fixtureCommand("migrate-anonymous");
  await fixtureCommand("subscription", orgId, memberId);
  await fixtureCommand("ensure-control");
  const enabled = await seed.api(den.admin, "/v1/inference", { method: "PATCH", body: JSON.stringify({ enabled: true, tier: "tier1" }) });
  if (!enabled.response.ok) throw new Error(`Paid Models setup failed: HTTP ${enabled.response.status}`);
  await fixtureCommand("configure-paid", orgId, memberId);
  await start(["node", "--conditions=development", "--import", loader, fixture, "witness"], { ...baseEnv, ANONYMOUS_WITNESS_PORT: String(ports.witness) }, "anonymous-witness");
  const serverArgs = ["node", "--conditions=development", "--import", loader, "ee/apps/inference/src/server.ts"];
  await start(serverArgs, { ...baseEnv, PORT: String(ports.primary) }, "anonymous-primary");
  await start(serverArgs, { ...baseEnv, PORT: String(ports.secondary) }, "anonymous-secondary");
  await start(serverArgs, { ...baseEnv, PORT: String(ports.expiring), ANONYMOUS_TOKEN_TTL_SECONDS: "1" }, "anonymous-expiring");
  await start(serverArgs, { ...baseEnv, PORT: String(ports.rotated), ANONYMOUS_TOKEN_SECRET: `${tokenSecret}-rotated` }, "anonymous-rotated");
  await start(serverArgs, {
    ...baseEnv, PORT: String(ports.trustedNeighbor), ANONYMOUS_TRUST_PROXY_HOPS: "1", ANONYMOUS_TRUSTED_PROXY_IPS: "::2",
  }, "anonymous-trusted-neighbor");
  await start(serverArgs, { ...baseEnv, PORT: String(ports.slow), ANONYMOUS_REQUEST_TIMEOUT_MS: "1000" }, "anonymous-slow");
  await start(serverArgs, { ...baseEnv, PORT: String(ports.globalSpend), ANONYMOUS_GLOBAL_DAILY_MICRO_USD: "41600" }, "anonymous-global-spend");
  await start(serverArgs, {
    ...baseEnv, PORT: String(ports.unconfigured), ANONYMOUS_OPENROUTER_API_KEY: "", ANONYMOUS_INFERENCE_ENABLED: "true",
  }, "anonymous-unconfigured");
  await start(["node", "--conditions=development", "--import", loader, fixture, "client-proxy"], {
    ...baseEnv,
    ANONYMOUS_CLIENT_PROXY_PORT: String(ports.clientProxy),
    ANONYMOUS_CLIENT_UPSTREAM_URL: `http://127.0.0.1:${ports.primary}`,
  }, "anonymous-client-proxy");
  for (const serviceUrl of [witnessUrl, primaryUrl, secondaryUrl, expiringUrl, unconfiguredUrl, rotatedUrl, trustedNeighborUrl, slowUrl, globalSpendUrl, clientUrl]) {
    const deadline = Date.now() + 60_000;
    let ready = false;
    while (Date.now() < deadline) {
      ready = await fetch(`${serviceUrl}/health`, { signal: AbortSignal.timeout(2_000) }).then((response) => response.ok).catch(() => false);
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!ready) throw new Error(`Anonymous inference service did not start: ${serviceUrl}\n${diagnostics.slice(-20).join("")}`);
  }

  return {
    primaryUrl, secondaryUrl, expiringUrl, unconfiguredUrl, rotatedUrl, trustedNeighborUrl, slowUrl, globalSpendUrl,
    witnessUrl, clientUrl, orgId, memberId, den,
    syncRemoteSources,
    paidKey: `ow_inf_anonymous-fixture-${memberId}`,
    async reset() { await fixtureCommand("reset-anonymous"); },
    async outage(unavailable: boolean) { await fixtureCommand(unavailable ? "pause-anonymous" : "resume-anonymous"); },
    async accounting() {
      const output = await fixtureCommand("accounting");
      const line = output.trim().split(/\r?\n/).findLast((entry) => entry.startsWith("{"));
      if (!line) throw new Error(`Accounting fixture returned no JSON: ${output.slice(-500)}`);
      return object(JSON.parse(line));
    },
    async clientSnapshot() {
      return object(await (await fetch(`${clientUrl}/fixture/client/state`, { signal: AbortSignal.timeout(5_000) })).json());
    },
    async expireClientToken() {
      await fetch(`${clientUrl}/fixture/client/expire`, { method: "POST", signal: AbortSignal.timeout(5_000) });
    },
    async failClientWith(failure: "limit" | "capacity" | "unavailable" | null) {
      await fetch(`${clientUrl}/fixture/client/failure`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ failure }), signal: AbortSignal.timeout(5_000),
      });
    },
    async nextClientSession(input: { delayMs?: number; fail?: boolean }) {
      await fetch(`${clientUrl}/fixture/client/session`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input), signal: AbortSignal.timeout(5_000),
      });
    },
    async upstreamSnapshot() {
      return object(await (await fetch(`${witnessUrl}/fixture/requests`, { signal: AbortSignal.timeout(5_000) })).json());
    },
    async slowChat(token: string, body: string, delayMs: number) {
      const target = new URL(`${slowUrl}/api/anonymous/v1/chat/completions`);
      const send = target.protocol === "https:" ? httpsRequest : httpRequest;
      return new Promise<{ status: number; body: string }>((resolve, reject) => {
        const request = send(target, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        }, (response) => {
          let responseBody = "";
          response.on("data", (chunk) => { responseBody += chunk.toString(); });
          response.once("end", () => resolve({ status: response.statusCode ?? 0, body: responseBody }));
        });
        request.once("error", reject);
        const split = Math.max(1, Math.floor(body.length / 2));
        request.write(body.slice(0, split));
        setTimeout(() => request.end(body.slice(split)), delayMs);
      });
    },
    async [Symbol.asyncDispose]() { for (const child of children) child.kill("SIGTERM"); },
  };
}
