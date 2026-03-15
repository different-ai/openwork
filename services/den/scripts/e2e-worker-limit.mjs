import { randomUUID } from "node:crypto";
import { once } from "node:events";
import net from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node:child_process";
import mysql from "mysql2/promise";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serviceDir = resolve(__dirname, "..");

function log(message) {
  process.stdout.write(`${message}\n`);
}

function fail(message, detail) {
  if (detail !== undefined) {
    console.error(message, detail);
  } else {
    console.error(message);
  }
  process.exit(1);
}

async function getFreePort() {
  return await new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("failed_to_resolve_free_port"));
        return;
      }
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolvePort(port)));
    });
    server.on("error", reject);
  });
}

function spawnCommand(command, args, options = {}) {
  return spawn(command, args, {
    cwd: serviceDir,
    env: process.env,
    stdio: "pipe",
    ...options,
  });
}

async function runCommand(command, args, options = {}) {
  const child = spawnCommand(command, args, options);
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const [code] = await once(child, "exit");
  if (code !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
  }
  return { stdout, stderr };
}

async function waitForMysqlConnection(databaseUrl, attempts = 60) {
  for (let index = 0; index < attempts; index += 1) {
    try {
      const connection = await mysql.createConnection(databaseUrl);
      await connection.query("SELECT 1");
      await connection.end();
      return;
    } catch {
      await delay(1000);
    }
  }

  throw new Error("mysql_not_ready");
}

async function waitForHttp(url, attempts = 60) {
  for (let index = 0; index < attempts; index += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // ignore until retries are exhausted
    }
    await delay(500);
  }

  throw new Error(`http_not_ready:${url}`);
}

async function requestJson(baseUrl, path, { method = "GET", body, token, cookie } = {}) {
  const headers = new Headers();
  const origin = new URL(baseUrl).origin;
  headers.set("Accept", "application/json");
  headers.set("Origin", origin);
  headers.set("Referer", `${origin}/`);
  if (body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  if (cookie) {
    headers.set("Cookie", cookie);
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  return {
    response,
    payload,
    cookie: response.headers.get("set-cookie"),
  };
}

async function main() {
  const mysqlPort = await getFreePort();
  const appPort = await getFreePort();
  const containerName = `openwork-den-e2e-${randomUUID().slice(0, 8)}`;
  const dbName = "openwork_den_e2e";
  const dbPassword = "openwork-root";
  const baseUrl = `http://127.0.0.1:${appPort}`;
  const databaseUrl = `mysql://root:${dbPassword}@127.0.0.1:${mysqlPort}/${dbName}`;
  const env = {
    ...process.env,
    OPENWORK_DEV_MODE: "1",
    DATABASE_URL: databaseUrl,
    BETTER_AUTH_SECRET: "openwork-den-e2e-secret-000000000000",
    BETTER_AUTH_URL: baseUrl,
    PORT: String(appPort),
    CORS_ORIGINS: baseUrl,
    PROVISIONER_MODE: "stub",
    WORKER_URL_TEMPLATE: "https://workers.example.com/{workerId}",
    POLAR_FEATURE_GATE_ENABLED: "false",
  };

  let serviceProcess = null;

  const cleanup = async () => {
    if (serviceProcess && !serviceProcess.killed) {
      serviceProcess.kill("SIGINT");
      await once(serviceProcess, "exit").catch(() => {});
    }

    await runCommand("docker", ["rm", "-f", containerName], { cwd: serviceDir }).catch(() => {});
  };

  process.on("SIGINT", async () => {
    await cleanup();
    process.exit(130);
  });

  try {
    log("Starting disposable MySQL container...");
    await runCommand("docker", [
      "run",
      "-d",
      "--rm",
      "--name",
      containerName,
      "-e",
      `MYSQL_ROOT_PASSWORD=${dbPassword}`,
      "-e",
      `MYSQL_DATABASE=${dbName}`,
      "-p",
      `${mysqlPort}:3306`,
      "mysql:8.4",
    ]);

    log("Waiting for MySQL...");
    await waitForMysqlConnection(databaseUrl);

    log("Running Den migrations...");
    await runCommand("pnpm", ["db:migrate"], { cwd: serviceDir, env });

    log("Starting Den service...");
    serviceProcess = spawn("pnpm", ["exec", "tsx", "src/index.ts"], {
      cwd: serviceDir,
      env,
      stdio: "pipe",
    });

    let serviceOutput = "";
    serviceProcess.stdout?.on("data", (chunk) => {
      serviceOutput += chunk.toString();
    });
    serviceProcess.stderr?.on("data", (chunk) => {
      serviceOutput += chunk.toString();
    });

    serviceProcess.on("exit", (code) => {
      if (code !== 0) {
        console.error(serviceOutput);
      }
    });

    await waitForHttp(`${baseUrl}/health`);

    const email = `den-e2e-${Date.now()}@example.com`;
    const password = "TestPass123!";

    log("Creating account...");
    const signup = await requestJson(baseUrl, "/api/auth/sign-up/email", {
      method: "POST",
      body: {
        name: "Den E2E",
        email,
        password,
      },
    });

    if (!signup.response.ok) {
      fail("Signup failed", signup.payload);
    }

    log("Fetching dev verification link...");
    const verification = await requestJson(
      baseUrl,
      `/v1/dev/email-verification?email=${encodeURIComponent(email)}`,
      { method: "GET" },
    );

    if (!verification.response.ok || typeof verification.payload?.url !== "string") {
      fail("Could not load dev verification link", verification.payload);
    }

    log("Verifying email...");
    await fetch(verification.payload.url, { redirect: "manual" });

    log("Signing in with verified account...");
    const signin = await requestJson(baseUrl, "/api/auth/sign-in/email", {
      method: "POST",
      body: { email, password },
    });

    if (!signin.response.ok) {
      fail("Sign-in failed", signin.payload);
    }

    const token = null;
    const cookie = signin.cookie;
    if (!cookie) {
      fail("Sign-in did not return a session cookie", signin.payload);
    }

    log("Validating authenticated session...");
    const me = await requestJson(baseUrl, "/v1/me", { token, cookie });
    if (!me.response.ok) {
      fail("Session lookup failed", me.payload);
    }

    log("Checking billing summary is disabled...");
    const billing = await requestJson(baseUrl, "/v1/workers/billing", { token, cookie });
    if (!billing.response.ok) {
      fail("Billing summary request failed", billing.payload);
    }

    if (
      !billing.payload?.billing ||
      billing.payload.billing.featureGateEnabled !== false ||
      billing.payload.billing.checkoutRequired !== false ||
      billing.payload.billing.checkoutUrl !== null
    ) {
      fail("Billing summary should be disabled for the experiment", billing.payload);
    }

    log("Creating first cloud worker...");
    const firstWorker = await requestJson(baseUrl, "/v1/workers", {
      method: "POST",
      token,
      cookie,
      body: {
        name: "first-worker",
        destination: "cloud",
      },
    });

    if (firstWorker.response.status !== 202) {
      fail("First worker did not launch successfully", {
        status: firstWorker.response.status,
        payload: firstWorker.payload,
      });
    }

    log("Attempting second cloud worker...");
    const secondWorker = await requestJson(baseUrl, "/v1/workers", {
      method: "POST",
      token,
      cookie,
      body: {
        name: "second-worker",
        destination: "cloud",
      },
    });

    if (secondWorker.response.status !== 409) {
      fail("Second worker was not blocked by the one-worker limit", {
        status: secondWorker.response.status,
        payload: secondWorker.payload,
      });
    }

    if (!secondWorker.payload || secondWorker.payload.error !== "worker_limit_reached") {
      fail("Second worker returned the wrong error payload", secondWorker.payload);
    }

    log("Listing workers...");
    const workers = await requestJson(baseUrl, "/v1/workers?limit=20", { token, cookie });
    if (!workers.response.ok) {
      fail("Worker list request failed", workers.payload);
    }

    const items = Array.isArray(workers.payload?.workers) ? workers.payload.workers : null;
    if (!items || items.length !== 1) {
      fail("Expected exactly one worker after limit enforcement", workers.payload);
    }

    log("E2E worker limit check passed.");
  } finally {
    await cleanup();
  }
}

await main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
