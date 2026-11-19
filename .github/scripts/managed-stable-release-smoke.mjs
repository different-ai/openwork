#!/usr/bin/env node
// Exact-digest, production-mode container health. NOT cloud/TLS, model-access,
// fresh-install or approved-Update qualification. No inference requests are sent.
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { imageConfiguration } from "./ee-image-inputs.mjs";
import { assertReleaseImages, releaseRepositories } from "./managed-stable-release.mjs";

const targets = { den_api: "den-api", den_web: "den-web", headless_runner: "headless-runner", workbot: "workbot", ai_gateway: "inference" };
const encryption = "ci-den-db-encryption-key-value-123456";
const runnerToken = "ci-headless-runner-token-value-1234567890";
export function smokeServices(candidate, names) {
  // Validate the WHOLE inventory before creating any local resources.
  assertReleaseImages(candidate.provider, candidate.images);
  const database = { DB_MODE: "mysql", DATABASE_URL: `mysql://smoke:smoke@${names.mysql}:3306/smoke`, DEN_DB_ENCRYPTION_KEY: encryption };
  const gateway = candidate.provider === "aws" ? {
    GATEWAY_ENABLED: "true", GATEWAY_PROXY_BASE_URL: `http://${names.ai_gateway}:8791`,
    GATEWAY_PUBLIC_BASE_URL: "https://models.example.test", INFERENCE_PROXY_BASE_URL: "https://models.example.test",
  } : {};
  const agents = candidate.provider === "aws" ? {
    DEN_HEADLESS_RUNNER_URL: `http://${names.headless_runner}:8795`, DEN_HEADLESS_RUNNER_TOKEN: runnerToken,
    DEN_SLACK_ASSISTANT_WORKER_ENABLED: "true", DEN_AUTOMATIONS_ENABLED: "true", DEN_WORKBOT_URL: "https://chat.example.test",
  } : {};
  const environments = {
    den_api: { ...database, ...gateway, ...agents, BETTER_AUTH_SECRET: "ci-better-auth-secret-value-123456",
      BETTER_AUTH_URL: candidate.provider === "aws" ? "https://api.example.test" : "http://127.0.0.1:8788" },
    den_web: {},
    ai_gateway: { ...database, ...gateway },
    headless_runner: {
      HEADLESS_API_TOKEN: runnerToken, HEADLESS_MODEL_PROTOCOL: "openai", HEADLESS_MODEL_BASE_URL: "https://models.example.test",
      HEADLESS_MODEL: "openai/gpt-6-luna", HEADLESS_MCP_URL: "https://api.example.test/mcp/agent",
      HEADLESS_COMPUTER: "off", HEADLESS_DB_PATH: "/tmp/headless.sqlite", HEADLESS_FILES: "disk",
    },
    workbot: {
      WORKBOT_PUBLIC_URL: "https://chat.example.test", WORKBOT_DEN_API_URL: "https://api.example.test", WORKBOT_DEN_WEB_URL: "https://den.example.test",
      WORKBOT_RUNNER_URL: `http://${names.headless_runner}:8795`, WORKBOT_RUNNER_TOKEN: runnerToken,
      WORKBOT_SESSION_SECRET: "ci-workbot-session-secret-value-123456789",
    },
  };
  // Start Gateway before Den so its configured upstream is present at startup.
  return ["ai_gateway", "den_api", "den_web", "headless_runner", "workbot"]
    .filter((kind) => Object.hasOwn(releaseRepositories(candidate.provider), kind)).map((kind) => ({
      kind, pin: candidate.images[kind], name: names[kind], ...imageConfiguration(targets[kind]),
      paths: kind === "ai_gateway" ? ["/health", "/ready"] : [imageConfiguration(targets[kind]).health_path],
      environment: { NODE_ENV: "production", OPENWORK_DEV_MODE: "0", ...environments[kind] },
    }));
}
async function healthyResponse(response, kind, path) {
  if (!response.ok) return false;
  if (kind !== "ai_gateway" || path !== "/ready") return true;
  const body = await response.json();
  return body?.ok === true && body.checks?.database === "ok";
}
const runDocker = (args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
export async function runSmoke(candidate, { docker = runDocker, fetchImpl = fetch, wait = (ms) => new Promise((done) => setTimeout(done, ms)), suffix = randomUUID().replaceAll("-", "").slice(0, 16) } = {}) {
  if (!/^[a-zA-Z0-9-]{1,24}$/.test(suffix)) throw new Error("Invalid local smoke identifier.");
  const prefix = `exp-managed-release-${suffix}`;
  const network = `${prefix}-network`;
  const volume = `${prefix}-mysql-data`;
  const names = Object.fromEntries(["mysql", ...Object.keys(targets)].map((kind) => [kind, `${prefix}-${kind.replaceAll("_", "-")}`]));
  const services = smokeServices(candidate, names);
  const containers = [];
  let networkCreated = false;
  let volumeCreated = false;
  try {
    docker(["network", "create", network]);
    networkCreated = true;
    docker(["volume", "create", volume]);
    volumeCreated = true;
    containers.push(names.mysql);
    docker(["run", "-d", "--name", names.mysql, "--network", network, "-v", `${volume}:/var/lib/mysql`,
      "-e", "MYSQL_ROOT_PASSWORD=smoke-root-password", "-e", "MYSQL_DATABASE=smoke", "-e", "MYSQL_USER=smoke", "-e", "MYSQL_PASSWORD=smoke",
      "mysql:8.4@sha256:b3b90af2a6552ae30c266fdb7d5dd55f3afb72404bb78d37fe8a23eb857fd3fb"]);
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        docker(["exec", "-e", "MYSQL_PWD=smoke-root-password", names.mysql, "mysqladmin", "ping", "--host=127.0.0.1", "--user=root", "--silent"]);
        ready = true;
        break;
      } catch { await wait(2_000); }
    }
    if (!ready) throw new Error("Local smoke database unavailable.");
    const api = services.find(({ kind }) => kind === "den_api");
    docker(["run", "--rm", "--platform=linux/amd64", "--entrypoint", "sh", api.pin, "-lc",
      "test -s /app/ee/packages/den-db/dist/scripts/bootstrap.js && test -s /app/ee/packages/den-db/dist/current-schema.sql && test -s /app/ee/packages/den-db/dist/drizzle/meta/_journal.json"]);
    docker(["run", "--rm", "--platform=linux/amd64", "--network", network,
      "-e", `DATABASE_URL=${api.environment.DATABASE_URL}`, "-e", `DEN_DB_ENCRYPTION_KEY=${encryption}`,
      "--entrypoint", "node", api.pin, "/app/ee/packages/den-db/dist/scripts/bootstrap.js"]);
    const checked = [];
    const probes = [];
    for (const service of services) {
      containers.push(service.name);
      docker(["run", "-d", "--platform=linux/amd64", "--name", service.name, "--network", network,
        "-p", `127.0.0.1::${service.port}`, ...Object.entries(service.environment).flatMap(([key, value]) => ["-e", `${key}=${value}`]), service.pin]);
      const mapping = docker(["port", service.name, `${service.port}/tcp`]).split("\n")[0];
      const port = mapping.split(":").at(-1);
      if (!/^\d+$/.test(port ?? "")) throw new Error("Missing local smoke port.");
      for (const path of service.paths) {
        let healthy = false;
        for (let attempt = 0; attempt < 60; attempt++) {
          try {
            const response = await fetchImpl(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(2_000) });
            if (await healthyResponse(response, service.kind, path)) {
              healthy = true;
              break;
            }
          } catch { /* local startup may still be in progress */ }
          await wait(2_000);
        }
        if (!healthy) throw new Error(`Exact-digest runtime health smoke failed: ${service.kind}.`);
        checked.push(`${service.kind}${path}`);
        probes.push({ kind: service.kind, name: service.name, path, url: `http://127.0.0.1:${port}${path}` });
      }
    }
    // Earlier services must still be healthy with the entire stack running.
    for (const { kind, name, path, url } of probes) {
      const state = docker(["inspect", "--format", "{{.State.Running}} {{.State.OOMKilled}}", name]);
      if (state !== "true false") throw new Error(`Complete runtime stack stopped: ${kind}${state === "false true" ? " (local Docker OOM)" : ""}.`);
      let response;
      try { response = await fetchImpl(url, { signal: AbortSignal.timeout(2_000) }); }
      catch { throw new Error(`Complete runtime stack lost readiness: ${kind}.`); }
      if (!await healthyResponse(response, kind, path)) throw new Error(`Complete runtime stack lost readiness: ${kind}.`);
    }
    return checked;
  } finally {
    // Never prune or touch a shared engine's other containers, networks or volumes.
    // Cleanup failure also fails the smoke rather than silently leaving resources.
    const failures = [];
    for (const name of containers.reverse()) { try { docker(["rm", "-f", "-v", name]); } catch { failures.push(name); } }
    if (volumeCreated) { try { docker(["volume", "rm", volume]); } catch { failures.push(volume); } }
    if (networkCreated) { try { docker(["network", "rm", network]); } catch { failures.push(network); } }
    if (failures.length) throw new Error("Local smoke cleanup incomplete; inspect only this run's exp-managed-release resources.");
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const candidate = JSON.parse(readFileSync(resolve(process.env.RELEASE_DIRECTORY ?? "dist/managed-stable", "candidate.json"), "utf8"));
    console.log(`Exact-digest production-mode migration and health passed: ${(await runSmoke(candidate)).join(", ")}. Not cloud/TLS or model-access qualification.`);
  } catch {
    console.error("Exact-digest container/bootstrap smoke failed. No production credentials or customer resources were used.");
    process.exitCode = 1;
  }
}
