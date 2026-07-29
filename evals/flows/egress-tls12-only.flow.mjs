import tls from "node:tls";
import { startEgressLab } from "../runner/labs/egress.mjs";
import { expectBunTls12PinningFinding, expectVerdictNames, productDiagnosticsPrecondition } from "../runner/journeys/diagnostics.mjs";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "egress-tls12-only";
const vo = await loadVoiceoverParagraphs(FLOW_ID);

function witness(ctx, condition, assertion, actual = "") {
  ctx.recordEvidence({ type: "assertion", status: condition ? "passed" : "failed", assertion, actual });
  ctx.assert(condition, assertion);
}

function tlsHandshake(lab, version) {
  const url = new URL(lab.url);
  return new Promise((resolve) => {
    let settled = false;
    const socket = tls.connect({
      host: url.hostname,
      port: Number(url.port),
      servername: url.hostname,
      minVersion: version,
      maxVersion: version,
      ca: lab.rootPem,
      rejectUnauthorized: true,
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.once("secureConnect", () => finish({ ok: true, protocol: socket.getProtocol(), errorCode: null }));
    socket.once("timeout", () => finish({ ok: false, protocol: null, errorCode: "ETIMEDOUT" }));
    socket.once("error", (error) => finish({ ok: false, protocol: null, errorCode: error?.code ?? error?.message ?? String(error) }));
    socket.setTimeout(1500);
  });
}

export default {
  id: FLOW_ID,
  title: "Egress lab names the TLS 1.3 stall while TLS 1.2 succeeds",
  kind: "internal",
  requiresApp: false,
  precondition: (ctx) => productDiagnosticsPrecondition(ctx.env),
  steps: [
    {
      name: "Frame 1",
      run: async (ctx) => {
        let lab;
        let tls13;
        let tls12;
        await ctx.prove("TLS 1.3 times out, Node TLS 1.2 succeeds, OpenWork product diagnostics name the handshake fault, and the Bun pinning gap is recorded", {
          voiceover: vo[0],
          action: async () => {
            lab = await startEgressLab({ profile: "tls12-only" });
            try {
              tls13 = await tlsHandshake(lab, "TLSv1.3");
              tls12 = await tlsHandshake(lab, "TLSv1.2");
            } finally {
              // Lab cleanup happens after assertions so diagnostics can still inspect it.
            }
          },
          assert: async () => {
            try {
              ctx.output("TLS version split", JSON.stringify({ tls13, tls12 }, null, 2));
              witness(ctx, tls13?.ok === false && tls13?.errorCode === "ETIMEDOUT", "a TLS 1.3-only client times out against the egress proxy stall", JSON.stringify(tls13));
              witness(ctx, tls12?.ok === true && tls12?.protocol === "TLSv1.2", "a TLS 1.2-only client completes the handshake", JSON.stringify(tls12));
              await expectVerdictNames(ctx, { lab, expect: "tls12-only" });
              await expectBunTls12PinningFinding(ctx, { lab });
            } finally {
              await lab?.stop();
            }
          },
        });
      },
    },
  ],
};
