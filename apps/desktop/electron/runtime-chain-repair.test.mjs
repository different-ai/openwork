import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

import { resolveSystemCaEnv } from "./runtime.mjs";

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "testdata", "chain-repair");
const rootPem = await readFixtureText("root.pem");
const intermediatePem = await readFixtureText("intermediate.pem");
const intermediateDer = await readFixtureBuffer("intermediate.der");
const leafPem = await readFixtureText("leaf.pem");
const leafKey = await readFixtureText("leaf.key.pem");
const systemCert = "-----BEGIN CERTIFICATE-----\nsystem\n-----END CERTIFICATE-----";

function fixturePath(name) {
  return path.join(fixtureDir, name);
}

function readFixtureText(name) {
  return readFile(fixturePath(name), "utf8");
}

function readFixtureBuffer(name) {
  return readFile(fixturePath(name));
}

function arrayBufferFromBuffer(buffer) {
  return Uint8Array.from(buffer).buffer;
}

function fetchResponse(buffer) {
  return { ok: true, arrayBuffer: async () => arrayBufferFromBuffer(buffer) };
}

async function withTlsServer(options, fn) {
  const server = tls.createServer(options, (socket) => socket.end());
  const port = await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("TLS server did not bind to a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
  try {
    return await fn(port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function connectWithCa(port, ca) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = tls.connect({ host: "127.0.0.1", port, servername: "localhost", ca, rejectUnauthorized: true });
    const timer = setTimeout(() => finish(new Error("TLS client timed out")), 4000);
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    }
    socket.once("secureConnect", () => finish(null));
    socket.once("error", finish);
  });
}

function authorizedSocket() {
  const socket = {
    authorized: true,
    authorizationError: null,
    destroy() {},
    setTimeout() {
      return socket;
    },
    once(eventName, listener) {
      if (eventName === "secureConnect") process.nextTick(() => listener());
      return socket;
    },
    off() {
      return socket;
    },
  };
  return socket;
}

function hangingSocket() {
  const socket = {
    destroy() {},
    setTimeout() {
      return socket;
    },
    once() {
      return socket;
    },
    off() {
      return socket;
    },
  };
  return socket;
}

test("repairs a leaf-only TLS chain from an AIA intermediate", async () => {
  await withTlsServer({ cert: leafPem, key: leafKey }, async (port) => {
    const userDataDir = await mkdtemp(path.join(tmpdir(), "openwork-chain-repair-"));
    const bundlePath = path.join(userDataDir, "system-ca-bundle.pem");
    const logs = [];

    const env = await resolveSystemCaEnv({
      tlsModule: { getCACertificates: () => [] },
      userDataDir,
      parentEnv: {},
      logInfo(message) {
        logs.push(String(message));
      },
      loadPlatformCertificates: async () => [],
      chainRepair: {
        origins: [`https://localhost:${port}`],
        fetchImpl: async () => fetchResponse(intermediateDer),
        rootsProvider: () => [rootPem],
      },
    });

    assert.deepEqual(env, { NODE_EXTRA_CA_CERTS: bundlePath });
    const bundleContent = await readFile(bundlePath, "utf8");
    assert.equal(bundleContent, `${intermediatePem.trim()}\n`);
    assert.ok(logs.some((line) => /chain repaired/.test(line)));

    await assert.rejects(connectWithCa(port, [rootPem]));
    await connectWithCa(port, [rootPem, bundleContent]);
  });
});

test("refuses repair when the failure is not leaf-only", async () => {
  await withTlsServer({ cert: `${leafPem}\n${intermediatePem}`, key: leafKey }, async (port) => {
    const userDataDir = await mkdtemp(path.join(tmpdir(), "openwork-chain-repair-"));
    const logs = [];
    let fetchCalled = false;

    const env = await resolveSystemCaEnv({
      tlsModule: { getCACertificates: () => [] },
      userDataDir,
      parentEnv: {},
      logInfo(message) {
        logs.push(String(message));
      },
      loadPlatformCertificates: async () => [],
      chainRepair: {
        origins: [`https://localhost:${port}`],
        fetchImpl: async () => {
          fetchCalled = true;
          return fetchResponse(intermediateDer);
        },
        rootsProvider: () => [rootPem],
      },
    });

    assert.deepEqual(env, {});
    assert.equal(fetchCalled, false);
    assert.ok(logs.some((line) => /chain repair skipped/.test(line)));
  });
});

test("refuses repair when the fetched certificate did not issue the leaf", async () => {
  await withTlsServer({ cert: leafPem, key: leafKey }, async (port) => {
    const userDataDir = await mkdtemp(path.join(tmpdir(), "openwork-chain-repair-"));
    const logs = [];

    const env = await resolveSystemCaEnv({
      tlsModule: { getCACertificates: () => [] },
      userDataDir,
      parentEnv: {},
      logInfo(message) {
        logs.push(String(message));
      },
      loadPlatformCertificates: async () => [],
      chainRepair: {
        origins: [`https://localhost:${port}`],
        fetchImpl: async () => fetchResponse(Buffer.from(rootPem, "utf8")),
        rootsProvider: () => [rootPem],
      },
    });

    assert.deepEqual(env, {});
    assert.ok(logs.some((line) => /chain repair refused/.test(line)));
  });
});

test("chain repair kill switch preserves system CA export", async () => {
  const userDataDir = await mkdtemp(path.join(tmpdir(), "openwork-chain-repair-"));
  const bundlePath = path.join(userDataDir, "system-ca-bundle.pem");
  let fetchCalled = false;
  let probeCalled = false;

  const env = await resolveSystemCaEnv({
    tlsModule: { getCACertificates: () => [systemCert] },
    userDataDir,
    parentEnv: { OPENWORK_DISABLE_CHAIN_REPAIR: " 1 " },
    logInfo: () => {},
    loadPlatformCertificates: async () => [],
    chainRepair: {
      origins: ["https://localhost:443"],
      fetchImpl: async () => {
        fetchCalled = true;
        return fetchResponse(intermediateDer);
      },
      tlsConnectImpl() {
        probeCalled = true;
        return authorizedSocket();
      },
      rootsProvider: () => [rootPem],
    },
  });

  assert.deepEqual(env, { NODE_EXTRA_CA_CERTS: bundlePath });
  assert.equal(await readFile(bundlePath, "utf8"), `${systemCert}\n`);
  assert.equal(fetchCalled, false);
  assert.equal(probeCalled, false);
});

test("user NODE_EXTRA_CA_CERTS disables repair", async () => {
  const userDataDir = await mkdtemp(path.join(tmpdir(), "openwork-chain-repair-"));
  let fetchCalled = false;
  let probeCalled = false;
  let logged = false;

  const env = await resolveSystemCaEnv({
    tlsModule: { getCACertificates: () => [systemCert] },
    userDataDir,
    parentEnv: { NODE_EXTRA_CA_CERTS: "/custom/ca.pem" },
    logInfo(message) {
      logged = String(message).includes("NODE_EXTRA_CA_CERTS is already set");
    },
    loadPlatformCertificates: async () => [systemCert],
    chainRepair: {
      origins: ["https://localhost:443"],
      fetchImpl: async () => {
        fetchCalled = true;
        return fetchResponse(intermediateDer);
      },
      tlsConnectImpl() {
        probeCalled = true;
        return authorizedSocket();
      },
    },
  });

  assert.deepEqual(env, {});
  assert.equal(fetchCalled, false);
  assert.equal(probeCalled, false);
  assert.equal(logged, true);
});

test("chain repair total timeout can be shortened by env", async () => {
  const userDataDir = await mkdtemp(path.join(tmpdir(), "openwork-chain-repair-"));
  const logs = [];
  const startTime = Date.now();

  const env = await resolveSystemCaEnv({
    tlsModule: { getCACertificates: () => [] },
    userDataDir,
    parentEnv: { OPENWORK_CHAIN_REPAIR_TIMEOUT_MS: "1500" },
    logInfo(message) {
      logs.push(String(message));
    },
    loadPlatformCertificates: async () => [],
    chainRepair: {
      origins: ["https://localhost:443"],
      fetchImpl: async () => {
        throw new Error("timed-out chain repair should not fetch");
      },
      tlsConnectImpl: hangingSocket,
      rootsProvider: () => [rootPem],
    },
  });

  assert.deepEqual(env, {});
  assert.ok(Date.now() - startTime < 5000);
  assert.ok(logs.some((line) => line.includes("chain repair skipped: timed out")));
});

test("activation bootstrap origin parsing is strict", async () => {
  const cases = [
    { fileName: "bootstrap-valid.json", expected: "localhost:4443" },
    { fileName: "bootstrap-http.json" },
    { fileName: "bootstrap-credentials.json" },
    { fileName: "bootstrap-query.json" },
    { fileName: "bootstrap-hash.json" },
    { fileName: "bootstrap-missing-activated-at.json" },
  ];

  for (const testCase of cases) {
    const userDataDir = await mkdtemp(path.join(tmpdir(), "openwork-chain-repair-"));
    const calls = [];
    const env = await resolveSystemCaEnv({
      tlsModule: { getCACertificates: () => [] },
      userDataDir,
      parentEnv: {},
      logInfo: () => {},
      loadPlatformCertificates: async () => [],
      chainRepair: {
        bootstrapPath: fixturePath(testCase.fileName),
        fetchImpl: async () => {
          throw new Error("bootstrap origin parsing should not fetch");
        },
        tlsConnectImpl(options) {
          calls.push(`${options.host}:${options.port}`);
          return authorizedSocket();
        },
        rootsProvider: () => [rootPem],
      },
    });

    assert.deepEqual(env, {});
    assert.deepEqual(calls, testCase.expected ? [testCase.expected] : []);
  }
});
