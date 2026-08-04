import assert from "node:assert/strict";
import test from "node:test";
import { startEgressLab } from "@openwork/labs";
import { diagnoseTls } from "@openwork/matchers";
import { probeTls } from "../src/diagnostics.ts";

test("probeTls and diagnoseTls identify a TLS 1.3-only stall without the eval framework", async () => {
  await using lab = await startEgressLab({ profile: "tls12-only" });
  const url = new URL(lab.url);
  const facts = await probeTls({
    // The lab listens on IPv4. Keep certificate verification on the generated
    // localhost identity without depending on the runner's localhost family
    // preference.
    host: "127.0.0.1",
    port: Number(url.port),
    servername: url.hostname,
    // Chain verification is back on: the lab root is now generated with an
    // explicit basicConstraints extension, so it is a real CA on every openssl
    // build (1.1.1 silently emitted CA:FALSE before).
    ca: lab.rootPem,
  });

  const message = JSON.stringify(facts);
  assert.equal(facts.tls12.handshakeOk, true, message);
  assert.equal(facts.tls12.stalled, false, message);
  assert.equal(facts.tls12.chainVerified, true, message);
  assert.equal(facts.tls12.protocol, "TLSv1.2", message);
  assert.equal(facts.tls13.stalled, true, message);
  assert.equal(facts.tls13.errorCode, "ETIMEDOUT", message);
  assert.equal(diagnoseTls(facts).code, "tls_handshake_stall_tls13_only", message);
  // Lab-PKI chain trust is covered by the pure matcher tests (the tls_chain_untrusted branch) and the product-diagnostics spec; it is deliberately not asserted here because it varies with the runner's OpenSSL.
});
