import assert from "node:assert/strict";
import test from "node:test";

import { diagnoseTls, type TlsFacts } from "../src/index.ts";

test("diagnoseTls reports both version stalls as unreachable", () => {
  const facts: TlsFacts = {
    tls12: { handshakeOk: false, chainVerified: false, protocol: null, errorCode: "ETIMEDOUT", stalled: true },
    tls13: { handshakeOk: false, chainVerified: false, protocol: null, errorCode: "ETIMEDOUT", stalled: true },
  };

  assert.equal(diagnoseTls(facts).code, "tls_unreachable");
});

test("diagnoseTls prioritizes a TLS 1.3-only stall", () => {
  const facts: TlsFacts = {
    tls12: { handshakeOk: true, chainVerified: false, protocol: "TLSv1.2", errorCode: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", stalled: false },
    tls13: { handshakeOk: false, chainVerified: false, protocol: null, errorCode: "ETIMEDOUT", stalled: true },
  };
  const verdict = diagnoseTls(facts);

  assert.equal(verdict.code, "tls_handshake_stall_tls13_only");
  assert.match(verdict.summary, /TLS 1\.2 completed while TLS 1\.3 timed out/u);
  assert.match(verdict.action, /egress proxy or firewall passes TLS ClientHello traffic/u);
});

test("diagnoseTls reports an untrusted chain after a completed handshake", () => {
  const facts: TlsFacts = {
    tls12: { handshakeOk: true, chainVerified: false, protocol: "TLSv1.2", errorCode: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", stalled: false },
    tls13: { handshakeOk: false, chainVerified: false, protocol: null, errorCode: "ECONNRESET", stalled: false },
  };
  const verdict = diagnoseTls(facts);

  assert.equal(verdict.code, "tls_chain_untrusted");
  assert.match(verdict.summary, /UNABLE_TO_GET_ISSUER_CERT_LOCALLY/u);
  assert.match(verdict.action, /trust the issuing CA in every runtime/u);
});

test("diagnoseTls reports success when both chains verify", () => {
  const facts: TlsFacts = {
    tls12: { handshakeOk: true, chainVerified: true, protocol: "TLSv1.2", errorCode: null, stalled: false },
    tls13: { handshakeOk: true, chainVerified: true, protocol: "TLSv1.3", errorCode: null, stalled: false },
  };
  const verdict = diagnoseTls(facts);

  assert.equal(verdict.code, "tls_ok");
  assert.equal(verdict.ok, true);
});

test("diagnoseTls reports other connection failures as unreachable", () => {
  const facts: TlsFacts = {
    tls12: { handshakeOk: false, chainVerified: false, protocol: null, errorCode: "ECONNREFUSED", stalled: false },
    tls13: { handshakeOk: false, chainVerified: false, protocol: null, errorCode: "ECONNRESET", stalled: false },
  };

  assert.equal(diagnoseTls(facts).code, "tls_unreachable");
});
