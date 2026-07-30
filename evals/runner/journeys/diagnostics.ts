import { spawnSync } from "node:child_process";
import {
  diagnoseEgressLabCorroboration,
  diagnoseEgressLabProduct,
  productDiagnosticsPrecondition,
  readBunTls12PinningFinding,
} from "@openwork/behaviors";
import { matchVerdictExpectations } from "@openwork/matchers";
import type { DiagnosticVerdict } from "@openwork/behaviors";
import type { DiagnosticVerdictExpectation } from "@openwork/matchers";
import type { EgressLabHandle } from "@openwork/labs";
import type { FlowContext } from "../flow.ts";

export {
  diagnoseEgressLabCorroboration,
  diagnoseEgressLabProduct,
  matchVerdictExpectations,
  productDiagnosticsPrecondition,
};
export type { DiagnosticVerdict, DiagnosticVerdictExpectation };

function evidence(ctx: FlowContext, passed: boolean, assertion: string, actual: unknown): void {
  ctx.recordEvidence({ type: "assertion", status: passed ? "passed" : "failed", assertion, actual });
  ctx.assert(passed, assertion);
}

export async function expectBunTls12PinningFinding(ctx: FlowContext, options: { lab: EgressLabHandle }): Promise<void> {
  const facts = await readBunTls12PinningFinding(options.lab, ctx.env);
  ctx.output("Bun vs Node TLS 1.2 pinning finding", JSON.stringify(facts, null, 2));
  evidence(ctx, facts.nodeTls12Ok, "Node node:tls did not complete a TLSv1.2-pinned handshake.", facts.nodeTls12);
  evidence(ctx, facts.bunTls12Stalled, "Bun node:tls no longer times out under TLSv1.2 pinning; update the egress TLS finding and product workaround guidance.", facts.bunTls12);
  evidence(ctx, facts.nodeFetchPinnedOk, "Node fetch did not honor NODE_OPTIONS=--tls-max-v1.2.", facts.nodeFetchPinned);
  evidence(ctx, facts.bunFetchPinnedStalled, "Bun fetch no longer times out with NODE_OPTIONS=--tls-max-v1.2; update the egress TLS finding and product workaround guidance.", facts.bunFetchPinned);
  evidence(ctx, facts.nodeClientHelloTls12Only, "Node's TLSv1.2-pinned ClientHello did not look TLSv1.2-only.", facts.nodeClientHello);
  evidence(ctx, facts.bunClientHelloOffersTls13, "Bun no longer advertises TLS 1.3 under TLSv1.2 pinning; update the egress TLS finding and product workaround guidance.", facts.bunClientHello);
}

export async function expectVerdictNames(
  ctx: FlowContext,
  options: { lab: EgressLabHandle; expect: DiagnosticVerdictExpectation | DiagnosticVerdictExpectation[] },
): Promise<DiagnosticVerdict> {
  const skipReason = productDiagnosticsPrecondition(ctx.env);
  if (skipReason) ctx.skip(skipReason);
  const verdict = await diagnoseEgressLabProduct(options.lab);
  const corroboration = await diagnoseEgressLabCorroboration(options.lab);
  const matched = matchVerdictExpectations(verdict.text, options.expect);
  ctx.output(`${options.lab.profile} OpenWork product diagnostics verdict`, `${verdict.text}\n\n${verdict.evidence}`);
  ctx.output(`${options.lab.profile} lab-local corroborating probes`, `${corroboration.text}\n\n${corroboration.evidence}`);
  evidence(
    ctx,
    verdict.available && matched.ok,
    `OpenWork product diagnostics verdict did not name expected fault(s): ${matched.missing.join(", ")}. Verdict: ${verdict.text}`,
    verdict.text,
  );
  return verdict;
}

type RuntimeProbePayload = {
  reproVisible: boolean;
  fileCount: number;
  extraCount: number;
  systemCount: number;
  defaultCount: number;
  bundledCount: number;
};

const RUNTIME_CA_PROBE = String.raw`
const { X509Certificate } = require("node:crypto");
const fs = require("node:fs");
let tls;
try { tls = require("node:tls"); } catch { tls = {}; }
const needle = (process.env.OPENWORK_TLS_REPRO_CA_MATCH || "OpenWork Egress Lab").toLowerCase();
function countMatching(certs) {
  let count = 0;
  for (const pem of certs || []) {
    try {
      const cert = new X509Certificate(pem);
      if (cert.subject.toLowerCase().includes(needle)) count += 1;
    } catch {}
  }
  return count;
}
function certs(scope) {
  try { return typeof tls.getCACertificates === "function" ? tls.getCACertificates(scope) : []; } catch { return []; }
}
function fileCerts() {
  try { return fs.readFileSync(process.env.NODE_EXTRA_CA_CERTS || "", "utf8").match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || []; } catch { return []; }
}
const payload = {
  fileCount: countMatching(fileCerts()),
  extraCount: countMatching(certs("extra")),
  systemCount: countMatching(certs("system")),
  defaultCount: countMatching(certs("default")),
  bundledCount: countMatching(certs("bundled")),
};
payload.reproVisible = Object.values(payload).reduce((sum, value) => sum + value, 0) > 0;
console.log(JSON.stringify(payload));
process.exitCode = payload.reproVisible ? 0 : 1;
`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRuntimeProbe(stdout: string): RuntimeProbePayload | null {
  try {
    const value: unknown = JSON.parse(stdout.trim());
    if (!isRecord(value)) return null;
    if (
      typeof value.reproVisible !== "boolean"
      || typeof value.fileCount !== "number"
      || typeof value.extraCount !== "number"
      || typeof value.systemCount !== "number"
      || typeof value.defaultCount !== "number"
      || typeof value.bundledCount !== "number"
    ) return null;
    return {
      reproVisible: value.reproVisible,
      fileCount: value.fileCount,
      extraCount: value.extraCount,
      systemCount: value.systemCount,
      defaultCount: value.defaultCount,
      bundledCount: value.bundledCount,
    };
  } catch {
    return null;
  }
}

export async function expectRuntimeTrust(ctx: FlowContext, options: { caPath: string }): Promise<void> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_EXTRA_CA_CERTS: options.caPath,
    OPENWORK_TLS_REPRO_CA_MATCH: "OpenWork Egress Lab",
  };
  for (const runtime of [
    { name: "node", command: process.execPath },
    { name: "bun", command: "bun" },
  ]) {
    const result = spawnSync(runtime.command, ["--eval", RUNTIME_CA_PROBE], { env, encoding: "utf8", timeout: 10_000 });
    const payload = parseRuntimeProbe(result.stdout ?? "");
    const ok = result.status === 0 && payload?.reproVisible === true;
    ctx.output(`${runtime.name} CA visibility`, JSON.stringify({ status: result.status, error: result.error?.message ?? null, payload, stderr: result.stderr }, null, 2));
    evidence(ctx, ok, `${runtime.name} did not see the lab CA through NODE_EXTRA_CA_CERTS.`, payload ?? result.stderr);
  }
  const opencode = spawnSync("opencode", ["--version"], { env, encoding: "utf8", timeout: 10_000 });
  if (opencode.error) {
    ctx.output("opencode CA visibility", `opencode sidecar not reachable: ${opencode.error.message}`);
    return;
  }
  evidence(ctx, opencode.status === 0, "opencode sidecar was reachable but did not start with the CA environment.", opencode.stdout || opencode.stderr);
}
