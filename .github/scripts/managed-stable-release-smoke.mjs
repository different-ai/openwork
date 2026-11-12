#!/usr/bin/env node
// Same migration/bootstrap/health contract as Publish EE Artifacts, but run
// against the selected release's exact Linux/amd64 pins. This is NOT a cloud
// fresh install, a customer update, or real-cloud qualification evidence.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { imageConfiguration } from "./ee-image-inputs.mjs";

const candidate = JSON.parse(readFileSync(resolve(process.env.RELEASE_DIRECTORY ?? "dist/managed-stable", "candidate.json"), "utf8"));
const suffix = process.pid;
const network = `managed-smoke-${suffix}`;
const mysql = `managed-mysql-${suffix}`;
const containers = [mysql];
const docker = (args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
try {
  docker(["network", "create", network]);
  docker(["run", "-d", "--name", mysql, "--network", network,
    "-e", "MYSQL_ROOT_PASSWORD=smoke-root-password", "-e", "MYSQL_DATABASE=smoke", "-e", "MYSQL_USER=smoke", "-e", "MYSQL_PASSWORD=smoke",
    "mysql:8.4@sha256:b3b90af2a6552ae30c266fdb7d5dd55f3afb72404bb78d37fe8a23eb857fd3fb"]);
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      docker(["exec", "-e", "MYSQL_PWD=smoke-root-password", mysql, "mysqladmin", "ping", "--host=127.0.0.1", "--user=root", "--silent"]);
      ready = true;
      break;
    } catch { await wait(2_000); }
  }
  if (!ready) throw new Error("Local smoke database unavailable.");
  for (const [kind, target] of [["den_api", "den-api"], ["den_web", "den-web"]]) {
    const pin = candidate.images[kind];
    if (!/^ghcr\.io\/different-ai\/openwork-den-(?:api|web)@sha256:[a-f0-9]{64}$/.test(pin ?? "")) throw new Error("Invalid exact smoke image.");
    const config = imageConfiguration(target);
    const databaseUrl = `mysql://smoke:smoke@${mysql}:3306/smoke`;
    if (kind === "den_api") {
      docker(["run", "--rm", "--platform=linux/amd64", "--entrypoint", "sh", pin, "-lc",
        "test -s /app/ee/packages/den-db/dist/scripts/bootstrap.js && test -s /app/ee/packages/den-db/dist/current-schema.sql && test -s /app/ee/packages/den-db/dist/drizzle/meta/_journal.json"]);
      docker(["run", "--rm", "--platform=linux/amd64", "--network", network,
        "-e", `DATABASE_URL=${databaseUrl}`, "-e", "DEN_DB_ENCRYPTION_KEY=ci-den-db-encryption-key-value-123456",
        "--entrypoint", "node", pin, "/app/ee/packages/den-db/dist/scripts/bootstrap.js"]);
    }
    const name = `managed-${kind}-${suffix}`;
    containers.push(name);
    // Reuse the publisher's fixture environment, never production credentials.
    const args = config.smoke_env ? config.smoke_env.split(" ") : [];
    docker(["run", "-d", "--platform=linux/amd64", "--name", name, "--network", network, "-P",
      ...(kind === "den_api" ? ["-e", `DATABASE_URL=${databaseUrl}`] : []), ...args, pin]);
    const mapping = docker(["port", name, `${config.port}/tcp`]).split("\n")[0];
    const port = mapping.split(":").at(-1);
    if (!/^\d+$/.test(port ?? "")) throw new Error("Missing local smoke port.");
    let healthy = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}${config.health_path}`, { signal: AbortSignal.timeout(2_000) });
        if (response.ok) { healthy = true; break; }
      } catch { /* local startup may still be in progress */ }
      await wait(2_000);
    }
    if (!healthy) throw new Error("Exact-digest runtime health smoke failed.");
  }
  console.log("Exact-digest migration bootstrap and runtime health smoke passed (not real-cloud qualification).");
} catch {
  console.error("Exact-digest container/bootstrap smoke failed. No production credentials or customer resources were used.");
  process.exitCode = 1;
} finally {
  for (const name of containers.reverse()) { try { docker(["rm", "-f", name]); } catch { /* best-effort local cleanup */ } }
  try { docker(["network", "rm", network]); } catch { /* best-effort local cleanup */ }
}
