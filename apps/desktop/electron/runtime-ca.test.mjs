import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { mergeSystemCaChildEnv, resolveSystemCaEnv } from "./runtime.mjs";

const CERT_ONE = "-----BEGIN CERTIFICATE-----\none\n-----END CERTIFICATE-----";
const CERT_TWO = "-----BEGIN CERTIFICATE-----\ntwo\n-----END CERTIFICATE-----";

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
  });

  assert.deepEqual(env, {});
  await assert.rejects(readFile(path.join(userDataDir, "system-ca-bundle.pem"), "utf8"));
});
