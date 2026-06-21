import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  findFreePort,
  parseArgs,
} from "./_util.mjs";

const args = parseArgs(process.argv.slice(2));
const directory = args.get("dir") ?? process.cwd();
const outDir = resolve(args.get("out") ?? join(process.cwd(), "evals", "results", `managed-voice-${Date.now()}`));

const proofFrames = [];
const results = {
  ok: true,
  outDir,
  steps: [],
};

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function frame(name, data) {
  const file = `${String(proofFrames.length + 1).padStart(2, "0")}-${name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase()}.html`;
  const safeData = redactProofData(data);
  proofFrames.push({ file, name, data: safeData });
  await writeFile(join(outDir, file), `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(name)}</title>
  <style>
    body { margin: 0; background: #f8fafc; color: #111827; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    main { max-width: 980px; margin: 0 auto; padding: 32px; }
    h1 { font-family: system-ui, sans-serif; margin-top: 0; }
    pre { white-space: pre-wrap; word-break: break-word; padding: 18px; border: 1px solid #d1d5db; border-radius: 14px; background: white; }
  </style>
</head>
<body><main><h1>${escapeHtml(name)}</h1><pre>${escapeHtml(JSON.stringify(safeData, null, 2))}</pre></main></body>
</html>`, "utf8");
}

function redactProofData(value) {
  if (Array.isArray(value)) return value.map(redactProofData);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (/token|secret|authorization|api.?key/i.test(key)) return [key, "[redacted]"];
    if (typeof entry === "string" && /^(owt_|ow_inf_|sk-)/.test(entry)) return [key, "[redacted]"];
    return [key, redactProofData(entry)];
  }));
}

async function renderIndex() {
  const frames = proofFrames.map((entry) => `
    <section>
      <h2>${escapeHtml(entry.name)}</h2>
      <iframe src="${escapeHtml(entry.file)}" title="${escapeHtml(entry.name)}"></iframe>
      <p><a href="${escapeHtml(entry.file)}">Open frame</a></p>
    </section>`).join("\n");
  await writeFile(join(outDir, "index.html"), `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Managed Voice E2E Proof</title>
  <style>
    body { margin: 0; background: #f3f4f6; color: #111827; font-family: system-ui, sans-serif; }
    main { max-width: 1180px; margin: 0 auto; padding: 32px; }
    h1 { margin-bottom: 4px; }
    .meta { color: #4b5563; margin-bottom: 24px; }
    section { margin: 24px 0; padding: 18px; border: 1px solid #d1d5db; border-radius: 16px; background: white; }
    iframe { width: 100%; min-height: 430px; border: 1px solid #e5e7eb; border-radius: 12px; background: white; }
    code { background: #e5e7eb; padding: 2px 5px; border-radius: 5px; }
  </style>
</head>
<body><main>
  <h1>Managed Voice E2E Proof</h1>
  <div class="meta">Result: <code>${results.ok ? "passed" : "failed"}</code> · Output: <code>${escapeHtml(outDir)}</code></div>
${frames}
</main></body>
</html>`, "utf8");
}

function step(name, fn) {
  results.steps.push({ name, status: "running" });
  const idx = results.steps.length - 1;
  return Promise.resolve()
    .then(fn)
    .then(async (data) => {
      results.steps[idx] = { name, status: "ok", data };
      await frame(name, data);
      return data;
    })
    .catch(async (error) => {
      results.ok = false;
      const message = error instanceof Error ? error.message : String(error);
      results.steps[idx] = { name, status: "error", error: message };
      await frame(`${name} failure`, { error: message });
      throw error;
    });
}

async function startMockBroker() {
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += String(chunk);
    });
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization ?? null, body });
      if (req.method !== "POST" || req.url !== "/voice/realtime/session") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
        return;
      }
      if (req.headers.authorization !== "Bearer ow_inf_e2e") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "invalid_api_key" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        clientSecret: "managed-e2e-client-secret",
        expiresAt: 987654321,
        model: "gpt-realtime-2",
        transcriptionModel: "gpt-4o-transcribe",
        tools: ["openwork_snapshot", "openwork_list_actions", "openwork_execute_action"],
        source: "openwork-models",
      }));
    });
  });
  const port = await findFreePort();
  await new Promise((resolveReady) => server.listen(port, "127.0.0.1", resolveReady));
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  };
}

async function startOpenWorkServer({ directory, port, env }) {
  const token = "owt_managed_voice_client";
  const hostToken = "owt_managed_voice_host";
  const child = spawn("bun", [
    "apps/server/src/cli.ts",
    "--host", "127.0.0.1",
    "--port", String(port),
    "--token", token,
    "--host-token", hostToken,
    "--workspace", directory,
    "--approval", "auto",
    "--no-log-requests",
  ], {
    cwd: resolve(join(import.meta.dirname, "..", "..", "..")),
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env, OPENWORK_DEV_MODE: "1" },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    token,
    hostToken,
    getStdout: () => stdout,
    getStderr: () => stderr,
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      await Promise.race([
        new Promise((resolveExit) => child.once("exit", resolveExit)),
        new Promise((resolveTimeout) => setTimeout(resolveTimeout, 2500)),
      ]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    },
  };
}

async function waitForServerHealthy(baseUrl) {
  const startedAt = Date.now();
  let lastError = "";
  while (Date.now() - startedAt < 30_000) {
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2500) });
      if (response.ok) return response.json();
      lastError = `${response.status} ${response.statusText}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 250));
  }
  throw new Error(`Timed out waiting for OpenWork server health: ${lastError}`);
}

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
const envDir = await mkdtemp(join(tmpdir(), "openwork-managed-voice-e2e-"));
const mockBroker = await startMockBroker();
const port = await findFreePort();
const server = await startOpenWorkServer({
  directory,
  port,
  env: {
    OPENWORK_ENV_STORE: join(envDir, "env.json"),
    OPENWORK_TOKEN_STORE: join(envDir, "tokens.json"),
    OPENWORK_API_KEY: "ow_inf_e2e",
    OPENWORK_INFERENCE_BASE_URL: mockBroker.baseUrl,
  },
});

try {
  await step("server health", async () => waitForServerHealthy(server.baseUrl));

  const owner = await step("owner token", async () => {
    const response = await fetch(`${server.baseUrl}/tokens`, {
      method: "POST",
      headers: { "x-openwork-host-token": server.hostToken, "content-type": "application/json" },
      body: JSON.stringify({ scope: "owner", label: "managed voice e2e" }),
    });
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(typeof body.token, "string");
    return body;
  });

  const session = await step("managed voice session", async () => {
    const response = await fetch(`${server.baseUrl}/voice/realtime/session`, {
      method: "POST",
      headers: { authorization: `Bearer ${owner.token}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.clientSecret, "managed-e2e-client-secret");
    assert.equal(body.source, "openwork-models");
    return body;
  });

  await step("broker received authenticated request", async () => {
    assert.equal(mockBroker.requests.length, 1);
    assert.equal(mockBroker.requests[0].authorization, "Bearer ow_inf_e2e");
    assert.equal(session.model, "gpt-realtime-2");
    return mockBroker.requests[0];
  });

  await renderIndex();
  console.log(JSON.stringify({ ...results, proof: join(outDir, "index.html") }, null, 2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  results.ok = false;
  results.error = message;
  results.stderr = server.getStderr();
  results.stdout = server.getStdout?.() ?? "";
  await renderIndex();
  console.error(JSON.stringify({ ...results, proof: join(outDir, "index.html") }, null, 2));
  process.exitCode = 1;
} finally {
  await server.close();
  await mockBroker.close();
}
