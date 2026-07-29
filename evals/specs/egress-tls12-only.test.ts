import { describe, expect, test } from "vitest";
import { startEgressLab } from "@openwork/labs";
import {
  diagnoseEgressLabProduct,
  probeTls,
  productDiagnosticsPrecondition,
  readBunTls12PinningFinding,
} from "@openwork/behaviors";
import { diagnoseTls, matchVerdictExpectations } from "@openwork/matchers";

describe("TLS 1.2-only egress", () => {
  test("reports the TLS 1.3 ClientHello stall from transport facts", async () => {
    await using lab = await startEgressLab({ profile: "tls12-only" });
    const url = new URL(lab.url);
    const tls = await probeTls({
      host: url.hostname,
      port: Number(url.port),
      servername: url.hostname,
      ca: lab.rootPem,
    });

    const message = JSON.stringify(tls);
    expect(tls.tls12.handshakeOk, message).toBe(true);
    expect(tls.tls12.stalled, message).toBe(false);
    if (tls.tls12.chainVerified) {
      expect(tls.tls12.protocol, message).toBe("TLSv1.2");
    } else {
      expect(tls.tls12.protocol === null || tls.tls12.protocol === "TLSv1.2", message).toBe(true);
    }
    expect(tls.tls13.stalled, message).toBe(true);
    expect(tls.tls13.errorCode, message).toBe("ETIMEDOUT");
    expect(diagnoseTls(tls).code, message).toBe("tls_handshake_stall_tls13_only");
    // Lab-PKI chain trust is covered by the pure matcher tests (the tls_chain_untrusted branch) and the product-diagnostics spec; it is deliberately not asserted here because it varies with the runner's OpenSSL.
  });

  const skipReason = productDiagnosticsPrecondition(process.env);
  test.skipIf(skipReason !== null)(
    skipReason ? `product diagnostics skipped: ${skipReason}` : "product diagnostics name the fault and record Bun TLS pinning facts",
    async () => {
      await using lab = await startEgressLab({ profile: "tls12-only" });
      const product = await diagnoseEgressLabProduct(lab);
      expect(product.available).toBe(true);
      expect(matchVerdictExpectations(product.text, "tls12-only").ok).toBe(true);

      const pinning = await readBunTls12PinningFinding(lab);
      expect(pinning.nodeTls12Ok).toBe(true);
      expect(pinning.bunTls12Stalled).toBe(true);
      expect(pinning.nodeFetchPinnedOk).toBe(true);
      expect(pinning.bunFetchPinnedStalled).toBe(true);
      expect(pinning.nodeClientHelloTls12Only).toBe(true);
      expect(pinning.bunClientHelloOffersTls13).toBe(true);
    },
  );
});
