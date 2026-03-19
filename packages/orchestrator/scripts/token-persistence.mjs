import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { access } from "node:fs/promises";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(__dirname, "..", "dist", "cli.js");
const serverBinPath = resolve(__dirname, "..", "..", "server", "dist", "bin", "openwork-server");
const routerBinPath = resolve(__dirname, "..", "..", "opencode-router", "dist", "bin", "opencode-router");

function workspaceIdForLocal(path) {
  return `ws-${createHash("sha1").update(path).digest("hex").slice(0, 12)}`;
}

async function assertExecutable(path, label) {
  try {
    await access(path);
  } catch {
    throw new Error(`${label} not found at ${path}`);
  }
}

async function resolveOpencodeBin() {
  const configured = process.env.OPENCODE_BIN?.trim();
  if (configured) return configured;
  return "opencode";
}

function extractJsonPayload(raw) {
  const start = raw.indexOf("{\n");
  if (start === -1) {
    throw new Error(`No JSON payload found in output:\n${raw}`);
  }

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (char === "\\") {
        escape = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return JSON.parse(raw.slice(start, index + 1));
      }
    }
  }

  throw new Error(`Incomplete JSON payload in output:\n${raw}`);
}

async function runStart({ workspace, dataDir, opencodeBin }) {
  const child = spawn(
    "node",
    [
      cliPath,
      "start",
      "--workspace",
      workspace,
      "--data-dir",
      dataDir,
      "--check",
      "--json",
      "--allow-external",
      "--sidecar-source",
      "external",
      "--opencode-source",
      "external",
      "--openwork-server-bin",
      serverBinPath,
      "--opencode-router-bin",
      routerBinPath,
      "--opencode-bin",
      opencodeBin,
    ],
    {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const [code] = await once(child, "exit");
  if (code !== 0) {
    throw new Error(`openwork start failed with code ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }

  return {
    payload: extractJsonPayload(stdout),
    stdout,
    stderr,
  };
}

const root = await mkdtemp(join(tmpdir(), "openwork-token-persistence-"));
const dataDir = join(root, "data");
const workspace = join(root, "workspace");
const opencodeBin = await resolveOpencodeBin();

await mkdir(workspace, { recursive: true });
await assertExecutable(serverBinPath, "openwork-server binary");
await assertExecutable(routerBinPath, "opencode-router binary");

try {
  const first = await runStart({ workspace, dataDir, opencodeBin });
  const second = await runStart({ workspace, dataDir, opencodeBin });

  assert.equal(second.payload.openwork.collaboratorToken, first.payload.openwork.collaboratorToken);
  assert.equal(second.payload.openwork.ownerToken, first.payload.openwork.ownerToken);
  assert.equal(second.payload.openwork.hostToken, first.payload.openwork.hostToken);
  assert.equal(second.payload.openwork.port, first.payload.openwork.port);

  const authPath = join(dataDir, "openwork-auth", `${workspaceIdForLocal(workspace)}.json`);
  const authState = JSON.parse(await readFile(authPath, "utf8"));
  assert.equal(authState.token, first.payload.openwork.collaboratorToken);
  assert.equal(authState.ownerToken, first.payload.openwork.ownerToken);
  assert.equal(authState.hostToken, first.payload.openwork.hostToken);
  assert.equal(authState.port, first.payload.openwork.port);

  console.log(
    JSON.stringify(
      {
        ok: true,
        workspace,
        authPath,
        openwork: {
          port: first.payload.openwork.port,
          collaboratorToken: first.payload.openwork.collaboratorToken,
          ownerToken: first.payload.openwork.ownerToken,
          hostToken: first.payload.openwork.hostToken,
        },
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
} finally {
  await rm(root, { recursive: true, force: true });
}
