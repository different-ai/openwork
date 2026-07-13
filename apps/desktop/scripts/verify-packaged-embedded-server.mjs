#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function readAsarPath(argv) {
  const index = argv.indexOf("--asar");
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value) {
    throw new Error(
      "Pass --asar <path> and run this script with ELECTRON_RUN_AS_NODE=1 under the packaged Electron executable.",
    );
  }
  return isAbsolute(value) ? value : resolve(value);
}

async function health(handle) {
  const response = await fetch(`${handle.url}/health`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(typeof body.version, "string");
  assert.equal(typeof body.opencodeVersion, "string");
  return body;
}

async function assertStopped(url) {
  let rejected = false;
  try {
    await fetch(`${url}/health`, { signal: AbortSignal.timeout(1_000) });
  } catch {
    rejected = true;
  }
  assert.equal(rejected, true, "stopped server still accepted a health request");
}

assert.ok(process.versions.electron, "proof must run under the packaged Electron runtime");
const asar = readAsarPath(process.argv.slice(2));
const embeddedPath = join(asar, "server", "dist", "embedded.js");
const proofRoot = await mkdtemp(join(tmpdir(), "openwork-packaged-embedded-proof-"));
const workspace = join(proofRoot, "workspace");
await mkdir(workspace, { recursive: true });

process.env.OPENWORK_DATA_DIR = join(proofRoot, "data");
process.env.OPENWORK_RUNTIME_DB = join(proofRoot, "runtime.sqlite");
process.env.OPENWORK_TOKEN_STORE = join(proofRoot, "tokens.json");

let first;
let second;
try {
  const imported = await import(pathToFileURL(embeddedPath).href);
  assert.equal(typeof imported.startEmbeddedServer, "function");

  const options = {
    host: "127.0.0.1",
    port: 0,
    configPath: join(proofRoot, "config", "server.json"),
    workspaces: [workspace],
    token: "packaged-proof-client-token",
    hostToken: "packaged-proof-host-token",
    approvalMode: "auto",
    corsOrigins: ["*"],
    logRequests: false,
    manageOpencode: false,
  };

  first = await imported.startEmbeddedServer(options);
  const firstHealth = await health(first);
  const workspaceResponse = await fetch(`${first.url}/workspaces`, {
    headers: { Authorization: "Bearer packaged-proof-client-token" },
  });
  const workspaceBody = await workspaceResponse.json();
  assert.equal(workspaceResponse.status, 200);
  assert.equal(workspaceBody.items.length, 1);
  assert.equal(workspaceBody.items[0].path, workspace);

  const firstUrl = first.url;
  const firstPort = first.port;
  await first.stop();
  first = undefined;
  await assertStopped(firstUrl);

  second = await imported.startEmbeddedServer({ ...options, port: firstPort });
  assert.equal(second.port, firstPort);
  const secondHealth = await health(second);
  const secondUrl = second.url;
  await second.stop();
  second = undefined;
  await assertStopped(secondUrl);

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        runtime: { electron: process.versions.electron, node: process.versions.node },
        asar,
        embeddedImport: embeddedPath,
        importContract: "startEmbeddedServer:function",
        manageOpencode: false,
        firstStart: {
          url: firstUrl,
          health: firstHealth,
          authenticatedWorkspaceCount: workspaceBody.items.length,
        },
        firstStop: "connection refused",
        restart: { url: secondUrl, samePort: true, health: secondHealth },
        secondStop: "connection refused",
      },
      null,
      2,
    )}\n`,
  );
} finally {
  if (first) await first.stop().catch(() => undefined);
  if (second) await second.stop().catch(() => undefined);
  await rm(proofRoot, { recursive: true, force: true });
}
