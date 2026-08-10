import { readFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createBlipSchedule,
  denyHostsFromOutboundManifest,
  opensslCertificateCommands,
  opensslFlavor,
  outboundManifestFromUnknown,
  parseClientHelloVersions,
  resolveEgressProfileConfig,
  startEgressLab,
} from "../src/egress.ts";
import { productDiagnosticsPrecondition } from "@openwork/behaviors";
import { matchVerdictExpectations } from "@openwork/matchers";

function hi(value: number): number {
  return (value >> 8) & 0xff;
}

function lo(value: number): number {
  return value & 0xff;
}

function clientHelloFixture(versions: number[]): Buffer {
  const supportedVersions = versions.flatMap((version) => [hi(version), lo(version)]);
  const extensions = supportedVersions.length > 0
    ? [0x00, 0x2b, 0x00, supportedVersions.length + 1, supportedVersions.length, ...supportedVersions]
    : [];
  const body = [
    0x03,
    0x03,
    ...Array.from({ length: 32 }, () => 0),
    0x00,
    0x00,
    0x02,
    0x00,
    0x2f,
    0x01,
    0x00,
    hi(extensions.length),
    lo(extensions.length),
    ...extensions,
  ];
  const handshakeLength = body.length;
  const recordLength = handshakeLength + 4;
  return Buffer.from([
    0x16,
    0x03,
    0x01,
    hi(recordLength),
    lo(recordLength),
    0x01,
    0x00,
    hi(handshakeLength),
    lo(handshakeLength),
    ...body,
  ]);
}

test("ClientHello parser distinguishes TLS 1.2-only from TLS 1.3-capable clients", () => {
  const tls12 = parseClientHelloVersions(clientHelloFixture([0x0303]));
  if (tls12.kind !== "parsed") throw new Error(`unexpected parse result: ${tls12.kind}`);
  assert.equal(tls12.offersTls13, false);
  assert.deepEqual(tls12.supportedVersionLabels, ["TLSv1.2"]);

  const tls13 = parseClientHelloVersions(clientHelloFixture([0x0304, 0x0303]));
  if (tls13.kind !== "parsed") throw new Error(`unexpected parse result: ${tls13.kind}`);
  assert.equal(tls13.offersTls13, true);
  assert.deepEqual(tls13.supportedVersionLabels, ["TLSv1.3", "TLSv1.2"]);
});

test("profile config resolution normalizes defaults", () => {
  const config = resolveEgressProfileConfig({
    profile: "deny",
    port: 0,
    denyHosts: ["GitHub.com", "github.com.", ""],
    denyMode: "blackhole",
    slow: { totalBytes: 10, chunkBytes: 4, delayMs: 0, latencyMs: 1 },
    blip: { route: "api/den", count: 2, fault: "reset" },
  });

  assert.equal(config.port, null);
  assert.deepEqual(config.denyHosts, ["github.com"]);
  assert.equal(config.denyMode, "blackhole");
  assert.equal(config.slow.totalBytes, 10);
  assert.equal(config.blip.route, "/api/den");
  assert.equal(config.blip.count, 2);
  assert.equal(config.blip.fault, "reset");
});

test("openssl argv construction includes CA, AIA, and fullchain prerequisites", () => {
  const commands = opensslCertificateCommands({
    dir: "/tmp/openwork-egress-test",
    hostname: "localhost",
    aiaUrl: "http://127.0.0.1:9000/__egress-lab/intermediate.der",
    corporateIssuer: true,
  });
  const labels = commands.map((command) => command.label);

  assert.deepEqual(labels, [
    "root-key",
    "root-csr",
    "root-cert",
    "intermediate-key",
    "intermediate-csr",
    "intermediate-cert",
    "intermediate-der",
    "leaf-key",
    "leaf-csr",
    "leaf-cert",
  ]);
  assert.ok(commands.some((command) => command.args.includes("/CN=OpenWork Egress Lab Corporate Interception CA")));
  assert.ok(commands.some((command) => command.args.includes("-extfile")));
  const rootCert = commands.find((command) => command.label === "root-cert");
  assert.ok(rootCert, "root-cert command must exist");
  assert.ok(
    rootCert.args.includes("-extfile"),
    "root CA extensions must come from -extfile; openssl 1.1.1 ignores `req -x509 -addext`",
  );
  assert.ok(!rootCert.args.includes("-addext"), "root-cert must not depend on -addext");
});

test("openssl flavor probe returns a known value", async () => {
  const flavor = await opensslFlavor();
  assert.ok(["openssl", "libressl", "unknown"].includes(flavor));
});

test("deny-list seeding reads installer-critical hosts from the outbound manifest", () => {
  const manifest = outboundManifestFromUnknown({
    hosts: [
      { host: "github.com", kind: "fetched", components: ["installer"], requirement: "required-in-practice", blockedEffect: "installer dead" },
      { host: "release-assets.githubusercontent.com", kind: "redirect-target", components: ["installer"], requirement: "required-in-practice", blockedEffect: "download fails" },
      { host: "cdn.simpleicons.org", kind: "fetched", components: ["renderer"], requirement: "optional", blockedEffect: "icons missing" },
    ],
  });
  if (!manifest) throw new Error("manifest fixture did not parse");

  assert.deepEqual(denyHostsFromOutboundManifest(manifest), ["github.com", "release-assets.githubusercontent.com"]);
});

test("blip schedule fires once, then stops", () => {
  const schedule = createBlipSchedule({ route: "/v1/me", count: 1, fault: "401", status: 401, body: "proxy" });
  const first = schedule.next("/v1/me");
  const second = schedule.next("/v1/me");

  assert.deepEqual(first, { kind: "status", status: 401, body: "proxy" });
  assert.deepEqual(second, { kind: "pass" });
  assert.equal(schedule.snapshot()[0]?.remaining, 0);
});

test("verdict matcher names injected faults and rejects vague output", () => {
  assert.equal(matchVerdictExpectations("LIKELY TLS VERSION/HANDSHAKE FAULT: TLS 1.3 timed out while TLS 1.2 completed", "tls12-only").ok, true);
  assert.equal(matchVerdictExpectations("endpoint_tls_handshake_timeout_tls12_comparison_failed: TLS 1.3 timed out and the runtime TLS 1.2 comparison also timed out", "tls12-only").ok, true);
  assert.equal(matchVerdictExpectations("LIKELY MISSING INTERMEDIATE OR UNTRUSTED ROOT", "broken-chain").ok, true);
  assert.equal(matchVerdictExpectations("LIKELY TLS INTERCEPTION: endpoint leaf is re-signed by Corporate CA", "intercept").ok, true);
  assert.equal(matchVerdictExpectations("BLOCKED HOST / PROXY DENY: github.com is blocked", "deny").ok, true);
  assert.deepEqual(matchVerdictExpectations("TypeError: fetch failed", ["tls12-only", "broken-chain"]), {
    ok: false,
    missing: ["tls12-only", "broken-chain"],
  });
});

test("product diagnostics precondition skips clearly when Bun is unavailable", () => {
  const reason = productDiagnosticsPrecondition({ PATH: "/definitely-no-bun-here" });

  if (!reason) throw new Error("Expected a missing-Bun skip reason");
  assert.ok(reason.includes("Bun is required"));
  assert.ok(reason.includes("product-verdict egress proofs"));
});

test("generated egress lab CA certificates carry basicConstraints on every openssl build", async () => {
  await using lab = await startEgressLab({ profile: "tls12-only" });
  assert.ok(lab.rootPem, "lab must expose its root PEM");
  const root = new X509Certificate(lab.rootPem);
  // openssl 1.1.1 silently produced a non-CA root, which broke chain building
  // only on runners shipping 1.1.1 (macos-14).
  assert.equal(root.ca, true, `root must be a CA (subject: ${root.subject})`);
  assert.ok(lab.intermediatePemPath, "lab must expose its intermediate path");
  const intermediate = new X509Certificate(readFileSync(lab.intermediatePemPath, "utf8"));
  assert.equal(intermediate.ca, true, `intermediate must be a CA (subject: ${intermediate.subject})`);
});
