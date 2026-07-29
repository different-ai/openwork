import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { startEgressLab } from "@openwork/labs";
import { diagnoseTls } from "@openwork/matchers";
import { probeTls } from "../src/diagnostics.ts";

test("probeTls and diagnoseTls identify a TLS 1.3-only stall without the eval framework", async () => {
  await using lab = await startEgressLab({ profile: "tls12-only" });
  const url = new URL(lab.url);
  if (!lab.rootPem) throw new Error("TLS lab did not provide a root certificate");
  if (!lab.intermediatePemPath) throw new Error("TLS lab did not provide an intermediate certificate");
  const intermediatePem = await readFile(lab.intermediatePemPath, "utf8");
  const facts = await probeTls({
    // The lab listens on IPv4. Keep certificate verification on the generated
    // localhost identity without depending on the runner's localhost family
    // preference.
    host: "127.0.0.1",
    port: Number(url.port),
    servername: url.hostname,
    // Some macOS runner/OpenSSL combinations do not use the server-provided
    // intermediate when the trust input contains only the root.
    ca: [lab.rootPem, intermediatePem],
  });

  assert.equal(facts.tls12.ok, true, JSON.stringify(facts));
  assert.equal(facts.tls12.protocol, "TLSv1.2");
  assert.equal(facts.tls13.stalled, true);
  assert.equal(facts.tls13.errorCode, "ETIMEDOUT");
  assert.equal(diagnoseTls(facts).code, "tls_handshake_stall_tls13_only");
});
