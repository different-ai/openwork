import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { mergeSystemCaChildEnv, resolveSystemCaEnv } from "./runtime.mjs";
import {
  dedupeCertificates,
  parseDarwinSecurityCertificates,
  parseWindowsPowerShellCertificates,
  resolveSystemCaBundle,
  summarizeSystemCaSources,
} from "./system-ca.mjs";

const CERT_ONE = "-----BEGIN CERTIFICATE-----\none\n-----END CERTIFICATE-----";
const CERT_TWO = "-----BEGIN CERTIFICATE-----\ntwo\n-----END CERTIFICATE-----";
const CERT_THREE = "-----BEGIN CERTIFICATE-----\nthree\n-----END CERTIFICATE-----";

function windowsPowerShellCertBlock(base64) {
  return `-----OPENWORK-CERTIFICATE-----\n${base64}\n-----END-OPENWORK-CERTIFICATE-----`;
}

function pemForBase64(base64) {
  const lines = [];
  for (let index = 0; index < base64.length; index += 64) {
    lines.push(base64.slice(index, index + 64));
  }
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----`;
}

test("writes system CA bundle when certificates are available", async () => {
  const userDataDir = await mkdtemp(path.join(tmpdir(), "openwork-runtime-ca-"));
  const bundlePath = path.join(userDataDir, "system-ca-bundle.pem");

  const env = await resolveSystemCaEnv({
    tlsModule: {
      getCACertificates(scope) {
        assert.equal(scope, "system");
        return [CERT_ONE, CERT_TWO];
      },
    },
    userDataDir,
    parentEnv: {},
    logInfo: () => {},
    loadPlatformCertificates: async () => [],
  });

  assert.deepEqual(env, { NODE_EXTRA_CA_CERTS: bundlePath });
  assert.equal(await readFile(bundlePath, "utf8"), `${CERT_ONE}\n${CERT_TWO}\n`);
});

test("sets NODE_EXTRA_CA_CERTS for a child env merge", async () => {
  const userDataDir = await mkdtemp(path.join(tmpdir(), "openwork-runtime-ca-"));
  const caEnv = await resolveSystemCaEnv({
    tlsModule: { getCACertificates: () => [CERT_ONE] },
    userDataDir,
    parentEnv: {},
    logInfo: () => {},
    loadPlatformCertificates: async () => [],
  });
  /** @type {NodeJS.ProcessEnv} */
  const childEnv = { PATH: "/bin", ...caEnv };

  assert.equal(childEnv.NODE_EXTRA_CA_CERTS, path.join(userDataDir, "system-ca-bundle.pem"));
});

test("keeps NODE_EXTRA_CA_CERTS from user env file over generated bundle", () => {
  const userEnvFile = { NODE_EXTRA_CA_CERTS: "/user/file-ca.pem" };
  const processEnv = {};
  const baseEnv = {
    ...userEnvFile,
    ...processEnv,
    BUN_CONFIG_DNS_RESULT_ORDER: "verbatim",
  };
  const childEnv = mergeSystemCaChildEnv(baseEnv, { NODE_EXTRA_CA_CERTS: "/generated/system-ca-bundle.pem" });

  assert.equal(childEnv.NODE_EXTRA_CA_CERTS, "/user/file-ca.pem");
});

test("respects user-set NODE_EXTRA_CA_CERTS", async () => {
  const userDataDir = await mkdtemp(path.join(tmpdir(), "openwork-runtime-ca-"));
  let called = false;
  let logged = false;

  const env = await resolveSystemCaEnv({
    tlsModule: {
      getCACertificates() {
        called = true;
        return [CERT_ONE];
      },
    },
    userDataDir,
    parentEnv: { NODE_EXTRA_CA_CERTS: "/custom/ca.pem" },
    logInfo(message) {
      logged = String(message).includes("NODE_EXTRA_CA_CERTS is already set");
    },
    loadPlatformCertificates: async () => {
      called = true;
      return [CERT_TWO];
    },
  });

  assert.deepEqual(env, {});
  assert.equal(called, false);
  assert.equal(logged, true);
});

test("no-ops when tls.getCACertificates is unavailable", async () => {
  const userDataDir = await mkdtemp(path.join(tmpdir(), "openwork-runtime-ca-"));

  const env = await resolveSystemCaEnv({
    tlsModule: {},
    userDataDir,
    parentEnv: {},
    logInfo: () => {},
    loadPlatformCertificates: async () => [],
  });

  assert.deepEqual(env, {});
  await assert.rejects(readFile(path.join(userDataDir, "system-ca-bundle.pem"), "utf8"));
});

test("incident case: macOS runtime returns no certs but platform keychains produce a bundle", async () => {
  const userDataDir = await mkdtemp(path.join(tmpdir(), "openwork-runtime-ca-"));
  const bundlePath = path.join(userDataDir, "system-ca-bundle.pem");
  const logs = [];
  const setDefaultCalls = [];

  const env = await resolveSystemCaEnv({
    tlsModule: {
      getCACertificates(scope) {
        if (scope === "default") return ["default-root"];
        assert.equal(scope, "system");
        return [];
      },
      setDefaultCACertificates(certs) {
        setDefaultCalls.push(certs);
      },
    },
    userDataDir,
    parentEnv: {},
    logInfo(message) {
      logs.push(String(message));
    },
    loadPlatformCertificates: async () => [CERT_ONE, CERT_TWO],
    platformSourceName: "macos-keychains",
  });

  assert.deepEqual(env, { NODE_EXTRA_CA_CERTS: bundlePath });
  assert.equal(await readFile(bundlePath, "utf8"), `${CERT_ONE}\n${CERT_TWO}\n`);
  assert.deepEqual(setDefaultCalls, [["default-root", CERT_ONE, CERT_TWO]]);
  assert.ok(logs.some((line) => line.includes("runtime=0 macos-keychains=2")));
});

test("dedupes certificates across runtime and platform sources", async () => {
  const userDataDir = await mkdtemp(path.join(tmpdir(), "openwork-runtime-ca-"));
  const bundlePath = path.join(userDataDir, "system-ca-bundle.pem");

  const env = await resolveSystemCaEnv({
    tlsModule: { getCACertificates: () => [CERT_ONE, CERT_TWO] },
    userDataDir,
    parentEnv: {},
    logInfo: () => {},
    loadPlatformCertificates: async () => [CERT_TWO, CERT_THREE, CERT_ONE],
    platformSourceName: "windows-cert-stores",
  });

  assert.deepEqual(env, { NODE_EXTRA_CA_CERTS: bundlePath });
  assert.equal(await readFile(bundlePath, "utf8"), `${CERT_ONE}\n${CERT_TWO}\n${CERT_THREE}\n`);
});

test("does not set main-process defaults when no additions are available", async () => {
  const userDataDir = await mkdtemp(path.join(tmpdir(), "openwork-runtime-ca-"));
  let setDefaultCalled = false;

  const env = await resolveSystemCaEnv({
    tlsModule: {
      getCACertificates: () => [],
      setDefaultCACertificates() {
        setDefaultCalled = true;
      },
    },
    userDataDir,
    parentEnv: {},
    logInfo: () => {},
    loadPlatformCertificates: async () => [],
  });

  assert.deepEqual(env, {});
  assert.equal(setDefaultCalled, false);
});

test("main-process default extension is optional", async () => {
  const userDataDir = await mkdtemp(path.join(tmpdir(), "openwork-runtime-ca-"));
  const bundlePath = path.join(userDataDir, "system-ca-bundle.pem");

  const env = await resolveSystemCaEnv({
    tlsModule: { getCACertificates: () => [CERT_ONE] },
    userDataDir,
    parentEnv: {},
    logInfo: () => {},
    loadPlatformCertificates: async () => [],
  });

  assert.deepEqual(env, { NODE_EXTRA_CA_CERTS: bundlePath });
});

test("system CA bundle resolver keeps platform sources additive and reports counts", async () => {
  const bundle = await resolveSystemCaBundle({
    runtime: () => [CERT_ONE],
    platform: { name: "macos-keychains", load: async () => [CERT_ONE, CERT_TWO] },
  });

  assert.deepEqual(bundle.certificates, [CERT_ONE, CERT_TWO]);
  assert.equal(summarizeSystemCaSources(bundle.sources), "runtime=1 macos-keychains=2");
});

test("system CA bundle resolver keeps other sources when platform enumeration fails", async () => {
  const bundle = await resolveSystemCaBundle({
    runtime: () => [CERT_ONE],
    platform: {
      name: "windows-cert-stores",
      load: async () => {
        throw new Error("powershell blocked by policy");
      },
    },
  });

  assert.deepEqual(bundle.certificates, [CERT_ONE]);
  assert.equal(summarizeSystemCaSources(bundle.sources), "runtime=1 windows-cert-stores=0");
});

test("parses and dedupes windows PowerShell certificate output", () => {
  const first = Buffer.from("first certificate with enough bytes to require PEM wrapping across more than one output line").toString("base64");
  const second = Buffer.from("second certificate").toString("base64");
  const output = [
    windowsPowerShellCertBlock(first),
    "noise",
    windowsPowerShellCertBlock(second),
    windowsPowerShellCertBlock("not-valid-base64"),
    windowsPowerShellCertBlock(first),
  ].join("\n");

  assert.deepEqual(parseWindowsPowerShellCertificates(output), [pemForBase64(first), pemForBase64(second)]);
});

test("parses darwin security PEM output", () => {
  const output = `noise\n${CERT_ONE}\nmore noise\n${CERT_TWO}\n${CERT_ONE}\n`;

  assert.deepEqual(parseDarwinSecurityCertificates(output), [CERT_ONE, CERT_TWO]);
});

test("ignores garbage certificate command output", () => {
  assert.deepEqual(parseDarwinSecurityCertificates("not certificate output"), []);
  assert.deepEqual(parseWindowsPowerShellCertificates("not certificate output"), []);
  assert.deepEqual(dedupeCertificates(["", "  ", CERT_ONE, CERT_ONE]), [CERT_ONE]);
});
