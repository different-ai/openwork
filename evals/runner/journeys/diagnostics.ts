import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import type { DetailedPeerCertificate } from "node:tls";

import type { FlowContext } from "../flow.ts";
import { parseClientHelloVersions } from "../labs/egress.ts";
import type { ClientHelloParseResult, EgressLabHandle, EgressLabProfile } from "../labs/egress.ts";

export type DiagnosticVerdictExpectation =
  | EgressLabProfile
  | "tls-version-handshake"
  | "missing-intermediate"
  | "untrusted-chain"
  | "tls-interception"
  | "blocked-host"
  | "proxy"
  | "redirect"
  | "slow-link"
  | "transient-401";

export type DiagnosticVerdict = {
  profile: EgressLabProfile;
  text: string;
  evidence: string;
  source: "product" | "lab-corroboration";
  available: boolean;
};

type CommandResult = {
  status: number;
  stdout: string;
  stderr: string;
  error: string | null;
};

type ProductDiagnosticsOkPayload = {
  status: "ok";
  profile: string;
  verdictText: string;
  checks: unknown;
  cloudProbe: unknown;
  transportProbe: unknown;
};

type ProductDiagnosticsErrorPayload = {
  status: "error";
  message: string;
  stack: string | null;
};

type ProductDiagnosticsPayload = ProductDiagnosticsOkPayload | ProductDiagnosticsErrorPayload;

type RuntimeProbePayload = {
  reproVisible: boolean;
  fileCount: number;
  extraCount: number;
  systemCount: number;
  defaultCount: number;
  bundledCount: number;
};

type TlsHandshakeProbe = {
  ok: boolean;
  protocol: string | null;
  errorCode: string | null;
};

type ServedCertificateEvidence = {
  subjectCN: string | null;
  issuerCN: string | null;
  selfIssued: boolean;
};

type TransportProbe = {
  verifiedHandshake: "ok" | "failed";
  verifyErrorCode: string | null;
  servedChain: ServedCertificateEvidence[];
  servedChainLength: number | null;
};

type TlsAttempt = {
  ok: true;
  certificate: DetailedPeerCertificate | null;
} | {
  ok: false;
  errorCode: string | null;
};

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const PRODUCT_DIAGNOSTICS_TIMEOUT_MS = 30_000;
const TLS_RUNTIME_PROBE_TIMEOUT_MS = 1_500;
const TLS_RUNTIME_COMMAND_TIMEOUT_MS = 8_000;

const PRODUCT_DIAGNOSTICS_SCRIPT = String.raw`
const profile = process.env.EGRESS_LAB_PRODUCT_PROFILE || "unknown";
const endpoint = process.env.EGRESS_LAB_PRODUCT_ENDPOINT || "";
const timeoutMs = Number(process.env.EGRESS_LAB_PRODUCT_TIMEOUT_MS || "1500");
function checkLine(check) {
  return [
    check.id,
    check.status,
    check.code,
    check.message,
    "Action: " + check.action,
  ].filter(Boolean).join(" | ");
}
async function main() {
  const transportModule = await import("./apps/server/src/agent-context-transport-probe.ts");
  const cloudModule = await import("./apps/server/src/agent-context-cloud-probe.ts");
  const diagnosticsModule = await import("./apps/server/src/agent-context-diagnostics.ts");
  const cloudProbe = await cloudModule.probeOpenworkCloudCatalog({
    workspaceId: "ws_egress_lab_product_diagnostics",
    workspaceType: "local",
    runtimeConfigAvailable: true,
    config: {
      type: "remote",
      enabled: true,
      url: endpoint,
      headers: { Authorization: "Bearer ow_diagnostics_token_abcdefghijklmnopqrstuvwxyz" },
    },
    engineRegistration: { status: "failed", source: "transport_failure", recordAgeMs: 1000 },
    requestId: "11111111-1111-4111-8111-111111111111",
    timeoutMs,
    env: process.env,
  });
  const transportProbe = await transportModule.probeCloudEndpointTransport({
    endpointUrl: endpoint,
    performProbe: endpoint.startsWith("https:"),
    timeoutMs,
    env: process.env,
  });
  const checks = [
    diagnosticsModule.cloudCatalogCheck(cloudProbe),
    diagnosticsModule.cloudDifferentialCheck(cloudProbe, false),
    diagnosticsModule.cloudEndpointTransportCheck(transportProbe, false),
  ];
  console.log(JSON.stringify({
    status: "ok",
    profile,
    verdictText: checks.map(checkLine).join("\n"),
    checks,
    cloudProbe,
    transportProbe,
  }));
}
main().catch((error) => {
  console.log(JSON.stringify({
    status: "error",
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack ?? null : null,
  }));
  process.exitCode = 1;
});
`;

const TLS_RUNTIME_PROBE_SCRIPT = String.raw`
const fs = require("node:fs");
const tls = require("node:tls");
const url = new URL(process.env.EGRESS_LAB_TLS_URL || "");
const timeoutMs = Number(process.env.EGRESS_LAB_TLS_TIMEOUT_MS || "1500");
function errorCode(error) {
  if (error && typeof error === "object" && typeof error.code === "string") return error.code;
  if (error && typeof error === "object" && error.cause && typeof error.cause.code === "string") return error.cause.code;
  if (error && typeof error === "object" && typeof error.name === "string" && error.name === "TimeoutError") return "TimeoutError";
  if (error instanceof Error) return error.message;
  return String(error);
}
async function main() {
  if (process.env.EGRESS_LAB_TLS_MODE === "fetch") {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      console.log(JSON.stringify({ ok: true, status: response.status, body: await response.text() }));
      return;
    } catch (error) {
      console.log(JSON.stringify({
        ok: false,
        name: error && typeof error === "object" && "name" in error ? error.name : null,
        message: error instanceof Error ? error.message : String(error),
        causeCode: error && typeof error === "object" && error.cause && typeof error.cause.code === "string" ? error.cause.code : null,
        code: errorCode(error),
      }));
      process.exitCode = 1;
      return;
    }
  }
  const caPath = process.env.NODE_EXTRA_CA_CERTS || "";
  const options = {
    host: url.hostname,
    port: Number(url.port) || 443,
    servername: url.hostname,
    ca: caPath ? fs.readFileSync(caPath, "utf8") : undefined,
    rejectUnauthorized: true,
    ALPNProtocols: ["http/1.1"],
  };
  if (process.env.EGRESS_LAB_TLS_MIN_VERSION) options.minVersion = process.env.EGRESS_LAB_TLS_MIN_VERSION;
  if (process.env.EGRESS_LAB_TLS_MAX_VERSION) options.maxVersion = process.env.EGRESS_LAB_TLS_MAX_VERSION;
  await new Promise((resolve) => {
    let settled = false;
    const socket = tls.connect(options);
    const finish = (payload, status) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      console.log(JSON.stringify(payload));
      process.exitCode = status;
      resolve();
    };
    socket.once("secureConnect", () => finish({ ok: true, protocol: typeof socket.getProtocol === "function" ? socket.getProtocol() : null }, 0));
    socket.once("timeout", () => finish({ ok: false, errorCode: "ETIMEDOUT" }, 1));
    socket.once("error", (error) => finish({ ok: false, errorCode: errorCode(error) }, 1));
    socket.setTimeout(timeoutMs);
  });
}
main();
`;

const TLS_CLIENT_HELLO_CAPTURE_SCRIPT = String.raw`
const tls = require("node:tls");
const socket = tls.connect({
  host: "127.0.0.1",
  port: Number(process.env.EGRESS_LAB_CAPTURE_PORT || "0"),
  servername: "localhost",
  minVersion: "TLSv1.2",
  maxVersion: "TLSv1.2",
  rejectUnauthorized: false,
});
socket.on("error", () => undefined);
socket.setTimeout(1000, () => socket.destroy());
setTimeout(() => process.exit(0), 1200).unref?.();
`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRuntimeProbePayload(value: unknown): value is RuntimeProbePayload {
  return isRecord(value)
    && typeof value.reproVisible === "boolean"
    && typeof value.fileCount === "number"
    && typeof value.extraCount === "number"
    && typeof value.systemCount === "number"
    && typeof value.defaultCount === "number"
    && typeof value.bundledCount === "number";
}

function isProductDiagnosticsOkPayload(value: unknown): value is ProductDiagnosticsOkPayload {
  return isRecord(value)
    && value.status === "ok"
    && typeof value.profile === "string"
    && typeof value.verdictText === "string"
    && Object.hasOwn(value, "checks")
    && Object.hasOwn(value, "cloudProbe")
    && Object.hasOwn(value, "transportProbe");
}

function isProductDiagnosticsErrorPayload(value: unknown): value is ProductDiagnosticsErrorPayload {
  return isRecord(value)
    && value.status === "error"
    && typeof value.message === "string"
    && (typeof value.stack === "string" || value.stack === null);
}

function productDiagnosticsPayloadFromStdout(stdout: string): ProductDiagnosticsPayload | null {
  try {
    const parsed = JSON.parse(stdout.trim());
    if (isProductDiagnosticsOkPayload(parsed) || isProductDiagnosticsErrorPayload(parsed)) return parsed;
    return null;
  } catch {
    return null;
  }
}

function endpointForDiagnostics(lab: EgressLabHandle): string {
  const url = new URL(lab.url);
  url.pathname = "/mcp/agent";
  return url.toString();
}

function productDiagnosticsCaPath(lab: EgressLabHandle): string | undefined {
  if (lab.profile === "tls12-only" || lab.profile === "broken-chain" || lab.profile === "healthy") return lab.caPath;
  return undefined;
}

function productDiagnosticsEnv(lab: EgressLabHandle, baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    EGRESS_LAB_PRODUCT_PROFILE: lab.profile,
    EGRESS_LAB_PRODUCT_ENDPOINT: endpointForDiagnostics(lab),
    EGRESS_LAB_PRODUCT_TIMEOUT_MS: "1500",
  };
  const caPath = productDiagnosticsCaPath(lab);
  if (caPath) env.NODE_EXTRA_CA_CERTS = caPath;
  return env;
}

function runBunProductDiagnostics(lab: EgressLabHandle): Promise<CommandResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const child = spawn("bun", ["--conditions", "development", "--eval", PRODUCT_DIAGNOSTICS_SCRIPT], {
      cwd: REPO_ROOT,
      env: productDiagnosticsEnv(lab, process.env),
    });
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve(result);
    };
    timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ status: -1, stdout, stderr, error: `Timed out after ${PRODUCT_DIAGNOSTICS_TIMEOUT_MS}ms` });
    }, PRODUCT_DIAGNOSTICS_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => finish({ status: -1, stdout, stderr, error: error.message }));
    child.on("close", (code) => finish({ status: typeof code === "number" ? code : -1, stdout, stderr, error: null }));
  });
}

export function productDiagnosticsPrecondition(env: NodeJS.ProcessEnv = process.env): string | null {
  const bun = spawnSync("bun", ["--version"], { env, encoding: "utf8", timeout: 5_000 });
  if (bun.status !== 0) {
    const reason = bun.error?.message ?? bun.stderr?.trim() ?? "bun --version failed";
    return `Bun is required to import OpenWork's shipped TypeScript diagnostics modules for product-verdict egress proofs (${reason}).`;
  }
  const openssl = spawnSync("openssl", ["version"], { env, encoding: "utf8", timeout: 5_000 });
  if (openssl.status !== 0) {
    const reason = openssl.error?.message ?? openssl.stderr?.trim() ?? "openssl version failed";
    return `OpenSSL is required to mint per-run egress lab certificates for product-verdict egress proofs (${reason}).`;
  }
  return null;
}

function runTlsRuntimeProbe(input: {
  command: string;
  label: string;
  lab: EgressLabHandle;
  env: NodeJS.ProcessEnv;
  mode: "tls" | "fetch";
  minVersion?: "TLSv1.2" | "TLSv1.3";
  maxVersion?: "TLSv1.2" | "TLSv1.3";
  nodeOptions?: string;
}): Promise<CommandResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const childEnv: NodeJS.ProcessEnv = {
      ...input.env,
      EGRESS_LAB_TLS_URL: input.lab.url,
      EGRESS_LAB_TLS_MODE: input.mode,
      EGRESS_LAB_TLS_TIMEOUT_MS: String(TLS_RUNTIME_PROBE_TIMEOUT_MS),
    };
    if (input.lab.caPath) childEnv.NODE_EXTRA_CA_CERTS = input.lab.caPath;
    if (input.minVersion) childEnv.EGRESS_LAB_TLS_MIN_VERSION = input.minVersion;
    if (input.maxVersion) childEnv.EGRESS_LAB_TLS_MAX_VERSION = input.maxVersion;
    if (input.nodeOptions) childEnv.NODE_OPTIONS = input.nodeOptions;
    const child = spawn(input.command, ["--eval", TLS_RUNTIME_PROBE_SCRIPT], {
      cwd: REPO_ROOT,
      env: childEnv,
    });
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve(result);
    };
    timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ status: -1, stdout, stderr, error: `${input.label} timed out after ${TLS_RUNTIME_COMMAND_TIMEOUT_MS}ms` });
    }, TLS_RUNTIME_COMMAND_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => finish({ status: -1, stdout, stderr, error: error.message }));
    child.on("close", (code) => finish({ status: typeof code === "number" ? code : -1, stdout, stderr, error: null }));
  });
}

function listenCaptureServer(server: net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      const address = server.address();
      if (address && typeof address === "object") {
        resolve(address.port);
        return;
      }
      reject(new Error("ClientHello capture server did not bind a TCP port."));
    });
  });
}

function closeCaptureServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

async function captureRuntimeClientHello(command: string, env: NodeJS.ProcessEnv): Promise<ClientHelloParseResult | { kind: "not-captured"; reason: string }> {
  const server = net.createServer();
  const port = await listenCaptureServer(server);
  let child: ReturnType<typeof spawn> | null = null;
  const captured = new Promise<ClientHelloParseResult | { kind: "not-captured"; reason: string }>((resolve) => {
    const timer = setTimeout(() => {
      resolve({ kind: "not-captured", reason: "Timed out waiting for TLS ClientHello." });
    }, TLS_RUNTIME_COMMAND_TIMEOUT_MS);
    server.once("connection", (socket) => {
      const chunks: Buffer[] = [];
      let total = 0;
      socket.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        total += chunk.byteLength;
        const parsed = parseClientHelloVersions(Buffer.concat(chunks, total));
        if (parsed.kind === "incomplete") return;
        clearTimeout(timer);
        socket.destroy();
        resolve(parsed);
      });
      socket.on("error", () => undefined);
    });
    server.once("error", (error) => {
      clearTimeout(timer);
      resolve({ kind: "not-captured", reason: error.message });
    });
  });
  try {
    child = spawn(command, ["--eval", TLS_CLIENT_HELLO_CAPTURE_SCRIPT], {
      cwd: REPO_ROOT,
      env: { ...env, EGRESS_LAB_CAPTURE_PORT: String(port) },
    });
    child.on("error", () => undefined);
    const result = await captured;
    return result;
  } finally {
    if (child) child.kill("SIGKILL");
    await closeCaptureServer(server);
  }
}

function outputCommandResult(result: CommandResult): Record<string, unknown> {
  return {
    status: result.status,
    error: result.error,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function commandSucceededWith(result: CommandResult, needle: string): boolean {
  return result.status === 0 && result.stdout.includes(needle);
}

function commandFailedWith(result: CommandResult, needle: string): boolean {
  return result.status !== 0 && result.stdout.includes(needle);
}

export async function expectBunTls12PinningFinding(ctx: FlowContext, options: { lab: EgressLabHandle }): Promise<void> {
  const nodeTls12 = await runTlsRuntimeProbe({
    command: process.execPath,
    label: "node node:tls TLSv1.2",
    lab: options.lab,
    env: ctx.env,
    mode: "tls",
    minVersion: "TLSv1.2",
    maxVersion: "TLSv1.2",
  });
  const bunTls12 = await runTlsRuntimeProbe({
    command: "bun",
    label: "bun node:tls TLSv1.2",
    lab: options.lab,
    env: ctx.env,
    mode: "tls",
    minVersion: "TLSv1.2",
    maxVersion: "TLSv1.2",
  });
  const nodeFetchPinned = await runTlsRuntimeProbe({
    command: process.execPath,
    label: "node fetch NODE_OPTIONS=--tls-max-v1.2",
    lab: options.lab,
    env: ctx.env,
    mode: "fetch",
    nodeOptions: "--tls-max-v1.2",
  });
  const bunFetchPinned = await runTlsRuntimeProbe({
    command: "bun",
    label: "bun fetch NODE_OPTIONS=--tls-max-v1.2",
    lab: options.lab,
    env: ctx.env,
    mode: "fetch",
    nodeOptions: "--tls-max-v1.2",
  });
  const nodeClientHello = await captureRuntimeClientHello(process.execPath, ctx.env);
  const bunClientHello = await captureRuntimeClientHello("bun", ctx.env);
  const summary = {
    finding: "Bun 1.3.x does not currently honor Node-style TLS 1.2 pinning in node:tls or fetch for this lab; it still offers TLS 1.3 and stalls.",
    nodeTls12: outputCommandResult(nodeTls12),
    bunTls12: outputCommandResult(bunTls12),
    nodeFetchPinned: outputCommandResult(nodeFetchPinned),
    bunFetchPinned: outputCommandResult(bunFetchPinned),
    nodeClientHello,
    bunClientHello,
  };
  ctx.output("Bun vs Node TLS 1.2 pinning finding", JSON.stringify(summary, null, 2));
  const nodeHelloOk = nodeClientHello.kind === "parsed" && !nodeClientHello.offersTls13 && nodeClientHello.supportedVersionLabels.includes("TLSv1.2");
  const bunHelloShowsTls13 = bunClientHello.kind === "parsed" && bunClientHello.offersTls13 && bunClientHello.supportedVersionLabels.includes("TLSv1.3");
  ctx.recordEvidence({
    type: "assertion",
    status: commandSucceededWith(nodeTls12, '"protocol":"TLSv1.2"') ? "passed" : "failed",
    assertion: "Node node:tls honors minVersion/maxVersion TLSv1.2 against the lab",
    actual: outputCommandResult(nodeTls12),
  });
  ctx.assert(commandSucceededWith(nodeTls12, '"protocol":"TLSv1.2"'), "Node node:tls did not complete a TLSv1.2-pinned handshake.");
  ctx.recordEvidence({
    type: "assertion",
    status: commandFailedWith(bunTls12, "ETIMEDOUT") ? "passed" : "failed",
    assertion: "Bun node:tls currently times out despite minVersion/maxVersion TLSv1.2",
    actual: outputCommandResult(bunTls12),
  });
  ctx.assert(commandFailedWith(bunTls12, "ETIMEDOUT"), "Bun node:tls no longer times out under TLSv1.2 pinning; update the egress TLS finding and product workaround guidance.");
  ctx.recordEvidence({
    type: "assertion",
    status: commandSucceededWith(nodeFetchPinned, '"status":200') ? "passed" : "failed",
    assertion: "Node fetch honors NODE_OPTIONS=--tls-max-v1.2 against the lab",
    actual: outputCommandResult(nodeFetchPinned),
  });
  ctx.assert(commandSucceededWith(nodeFetchPinned, '"status":200'), "Node fetch did not honor NODE_OPTIONS=--tls-max-v1.2.");
  ctx.recordEvidence({
    type: "assertion",
    status: commandFailedWith(bunFetchPinned, "Timeout") ? "passed" : "failed",
    assertion: "Bun fetch currently ignores NODE_OPTIONS=--tls-max-v1.2 for this lab and times out",
    actual: outputCommandResult(bunFetchPinned),
  });
  ctx.assert(commandFailedWith(bunFetchPinned, "Timeout"), "Bun fetch no longer times out with NODE_OPTIONS=--tls-max-v1.2; update the egress TLS finding and product workaround guidance.");
  ctx.recordEvidence({
    type: "assertion",
    status: nodeHelloOk ? "passed" : "failed",
    assertion: "Node's TLSv1.2-pinned ClientHello omits TLS 1.3",
    actual: nodeClientHello,
  });
  ctx.assert(nodeHelloOk, "Node's TLSv1.2-pinned ClientHello did not look TLSv1.2-only.");
  ctx.recordEvidence({
    type: "assertion",
    status: bunHelloShowsTls13 ? "passed" : "failed",
    assertion: "Bun's TLSv1.2-pinned ClientHello still advertises TLS 1.3 today",
    actual: bunClientHello,
  });
  ctx.assert(bunHelloShowsTls13, "Bun no longer advertises TLS 1.3 under TLSv1.2 pinning; update the egress TLS finding and product workaround guidance.");
}

function endpointForTransport(lab: EgressLabHandle): URL {
  const url = new URL(lab.url);
  url.pathname = "/mcp/agent";
  return url;
}

function tlsHandshake(lab: EgressLabHandle, version: "TLSv1.2" | "TLSv1.3", timeoutMs = 1500): Promise<TlsHandshakeProbe> {
  const url = new URL(lab.url);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: TlsHandshakeProbe) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    const socket = tls.connect({
      host: url.hostname,
      port: Number(url.port) || 443,
      servername: url.hostname,
      minVersion: version,
      maxVersion: version,
      ca: lab.rootPem,
      rejectUnauthorized: true,
    });
    socket.once("secureConnect", () => finish({ ok: true, protocol: socket.getProtocol(), errorCode: null }));
    socket.once("timeout", () => finish({ ok: false, protocol: null, errorCode: "ETIMEDOUT" }));
    socket.once("error", (error) => {
      const code = isRecord(error) && typeof error.code === "string" ? error.code : messageText(error);
      finish({ ok: false, protocol: null, errorCode: code });
    });
    socket.setTimeout(timeoutMs);
  });
}

function tlsErrorCode(error: unknown): string | null {
  if (isRecord(error) && typeof error.code === "string") return error.code;
  if (error instanceof Error) return error.message;
  return String(error);
}

function connectTransport(input: { url: URL; ca: string | undefined; rejectUnauthorized: boolean; inspect: boolean; timeoutMs: number }): Promise<TlsAttempt> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = tls.connect({
      host: input.url.hostname,
      port: Number(input.url.port) || 443,
      servername: input.url.hostname,
      ca: input.ca,
      rejectUnauthorized: input.rejectUnauthorized,
      ALPNProtocols: ["http/1.1"],
    });
    const finish = (attempt: TlsAttempt) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(attempt);
    };
    socket.once("secureConnect", () => {
      const certificate = input.inspect ? socket.getPeerCertificate(true) : null;
      finish({ ok: true, certificate });
    });
    socket.once("timeout", () => finish({ ok: false, errorCode: "ETIMEDOUT" }));
    socket.once("error", (error) => finish({ ok: false, errorCode: tlsErrorCode(error) }));
    socket.setTimeout(input.timeoutMs);
  });
}

function certificateField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 120) : null;
}

function servedChainFromCertificate(certificate: DetailedPeerCertificate | null): ServedCertificateEvidence[] {
  if (!certificate || Object.keys(certificate).length === 0) return [];
  const chain: ServedCertificateEvidence[] = [];
  const seen = new Set<DetailedPeerCertificate>();
  let current: DetailedPeerCertificate | undefined = certificate;
  while (current && chain.length < 5 && !seen.has(current)) {
    seen.add(current);
    const subjectCN = certificateField(current.subject?.CN);
    const issuerCN = certificateField(current.issuer?.CN);
    chain.push({
      subjectCN,
      issuerCN,
      selfIssued: current.issuerCertificate === current || (subjectCN !== null && subjectCN === issuerCN),
    });
    if (!current.issuerCertificate || current.issuerCertificate === current) break;
    current = current.issuerCertificate;
  }
  return chain;
}

async function probeTransport(lab: EgressLabHandle, ca: string | undefined): Promise<TransportProbe> {
  const url = endpointForTransport(lab);
  const verified = await connectTransport({ url, ca, rejectUnauthorized: true, inspect: false, timeoutMs: 1500 });
  if (verified.ok) return { verifiedHandshake: "ok", verifyErrorCode: null, servedChain: [], servedChainLength: null };
  const chainAttempt = await connectTransport({ url, ca: undefined, rejectUnauthorized: false, inspect: true, timeoutMs: 1500 });
  const servedChain = chainAttempt.ok ? servedChainFromCertificate(chainAttempt.certificate) : [];
  return {
    verifiedHandshake: "failed",
    verifyErrorCode: verified.errorCode,
    servedChain,
    servedChainLength: servedChain.length,
  };
}

async function diagnoseTlsLab(lab: EgressLabHandle): Promise<DiagnosticVerdict> {
  const useCa = lab.profile === "broken-chain" || lab.profile === "tls12-only" || lab.profile === "healthy";
  const probe = await probeTransport(lab, useCa ? lab.rootPem : undefined);
  const lines = [`transport=${JSON.stringify(probe, null, 2)}`];

  if (lab.profile === "tls12-only") {
    const tls13 = await tlsHandshake(lab, "TLSv1.3");
    const tls12 = await tlsHandshake(lab, "TLSv1.2");
    lines.push(`tls13=${JSON.stringify(tls13)}`);
    lines.push(`tls12=${JSON.stringify(tls12)}`);
    const text = !tls13.ok && tls13.errorCode === "ETIMEDOUT" && tls12.ok
      ? "LIKELY TLS VERSION/HANDSHAKE FAULT: TLS 1.3 ClientHello stalls or times out, while TLS 1.2 completes. Force TLS 1.2 or fix the egress proxy."
      : "TLS VERSION VERDICT INCONCLUSIVE: the TLS 1.3 and TLS 1.2 probes did not match the expected stall/success split.";
    return { profile: lab.profile, text, evidence: lines.join("\n"), source: "lab-corroboration", available: true };
  }

  const servedIssuer = probe.servedChain[0]?.issuerCN ?? "";
  const issuerLower = servedIssuer.toLowerCase();
  if (lab.profile === "intercept" && /corporate|interception|proxy|mitm/u.test(issuerLower)) {
    return {
      profile: lab.profile,
      text: `LIKELY TLS INTERCEPTION: endpoint leaf is re-signed by ${servedIssuer}, not the expected public issuer. Install or pass the corporate root, or bypass TLS inspection for OpenWork hosts.`,
      evidence: lines.join("\n"),
      source: "lab-corroboration",
      available: true,
    };
  }

  const code = probe.verifyErrorCode ?? "";
  if (lab.profile === "broken-chain" && /UNABLE_TO_VERIFY_LEAF_SIGNATURE|unable|cert|certificate/iu.test(code)) {
    return {
      profile: lab.profile,
      text: `LIKELY MISSING INTERMEDIATE OR UNTRUSTED ROOT: verified TLS failed with ${code}; served-chain length ${probe.servedChainLength ?? 0}. Fetch the AIA intermediate or fix the server fullchain.`,
      evidence: lines.join("\n"),
      source: "lab-corroboration",
      available: true,
    };
  }

  if (probe.verifiedHandshake === "ok") {
    return { profile: lab.profile, text: "NO EGRESS/TLS FAULT DETECTED: credential-free TLS handshake verified.", evidence: lines.join("\n"), source: "lab-corroboration", available: true };
  }
  return {
    profile: lab.profile,
    text: `LIKELY NETWORK/TLS FAULT: transport probe failed with ${probe.verifyErrorCode ?? "unknown error"}.`,
    evidence: lines.join("\n"),
    source: "lab-corroboration",
    available: true,
  };
}

async function diagnoseDenyLab(lab: EgressLabHandle): Promise<DiagnosticVerdict> {
  // Exact-match lookup (not a substring test) so the denied host is unambiguous.
  const host = lab.deniedHosts.find((entry) => entry === "github.com") ?? lab.deniedHosts[0] ?? "github.com";
  const url = new URL("/fetch", lab.url);
  url.searchParams.set("url", `https://${host}/different-ai/openwork/releases/latest`);
  const response = await fetch(url);
  const body = await response.text();
  const text = response.status === 451
    ? `BLOCKED HOST / PROXY DENY: ${host} is blocked by the selective-deny profile; docs/enterprise/outbound-access.json names the required host and its blocked effect.`
    : `DENY VERDICT INCONCLUSIVE: expected ${host} to be blocked, got HTTP ${response.status}.`;
  return { profile: lab.profile, text, evidence: [`status=${response.status}`, body].join("\n"), source: "lab-corroboration", available: true };
}

async function diagnoseBlipLab(lab: EgressLabHandle): Promise<DiagnosticVerdict> {
  const first = await fetch(new URL("/diagnostics", lab.url));
  await first.arrayBuffer();
  const second = await fetch(new URL("/diagnostics", lab.url));
  await second.arrayBuffer();
  const text = first.status === 401 && second.ok
    ? "TRANSIENT AUTH BLIP: one 401 was observed and the next request recovered; treat as retryable/unavailable unless the 401 has the Den error envelope."
    : `BLIP VERDICT INCONCLUSIVE: first=${first.status} second=${second.status}.`;
  return { profile: lab.profile, text, evidence: `first=${first.status}\nsecond=${second.status}`, source: "lab-corroboration", available: true };
}

async function diagnoseRedirectLab(lab: EgressLabHandle): Promise<DiagnosticVerdict> {
  const response = await fetch(new URL("/redirect-chain/start", lab.url), { redirect: "manual" });
  const location = response.headers.get("location") ?? "";
  const text = response.status >= 300 && response.status < 400
    ? `REDIRECT CHAIN DETECTED: first hop returned ${response.status} to ${location}; diagnostics must follow or report redirect targets explicitly.`
    : `REDIRECT VERDICT INCONCLUSIVE: expected manual redirect, got HTTP ${response.status}.`;
  return { profile: lab.profile, text, evidence: `status=${response.status}\nlocation=${location}`, source: "lab-corroboration", available: true };
}

async function diagnoseSlowLab(lab: EgressLabHandle): Promise<DiagnosticVerdict> {
  const started = Date.now();
  const response = await fetch(new URL("/slow", lab.url));
  const reader = response.body?.getReader();
  const first = reader ? await reader.read() : null;
  await reader?.cancel().catch(() => undefined);
  const elapsedMs = Date.now() - started;
  const text = elapsedMs > 100 || first?.value?.byteLength
    ? `SLOW LINK DETECTED: first bytes arrived after ${elapsedMs}ms; installer/download diagnostics should report throughput and latency, not a generic fetch failure.`
    : "SLOW VERDICT INCONCLUSIVE: no delayed bytes were observed.";
  return { profile: lab.profile, text, evidence: `status=${response.status}\nelapsedMs=${elapsedMs}\nfirstChunk=${first?.value?.byteLength ?? 0}`, source: "lab-corroboration", available: true };
}

async function diagnoseEgressLabCorroboration(lab: EgressLabHandle): Promise<DiagnosticVerdict> {
  if (lab.profile === "deny") return diagnoseDenyLab(lab);
  if (lab.profile === "blip") return diagnoseBlipLab(lab);
  if (lab.profile === "redirect-chain") return diagnoseRedirectLab(lab);
  if (lab.profile === "slow") return diagnoseSlowLab(lab);
  return diagnoseTlsLab(lab);
}

export async function diagnoseEgressLabProduct(lab: EgressLabHandle): Promise<DiagnosticVerdict> {
  const result = await runBunProductDiagnostics(lab);
  const payload = productDiagnosticsPayloadFromStdout(result.stdout);
  const commandEvidence = {
    command: "bun --conditions development --eval <product diagnostics probe>",
    cwd: REPO_ROOT,
    status: result.status,
    error: result.error,
    stderr: result.stderr,
    stdoutParsed: payload,
  };
  if (result.status !== 0 || !payload || payload.status === "error") {
    const message = payload?.status === "error" ? payload.message : (result.error ?? result.stderr.trim()) || "product diagnostics subprocess failed";
    return {
      profile: lab.profile,
      text: `PRODUCT DIAGNOSTICS UNAVAILABLE: ${message}`,
      evidence: JSON.stringify(commandEvidence, null, 2),
      source: "product",
      available: false,
    };
  }
  return {
    profile: lab.profile,
    text: payload.verdictText,
    evidence: JSON.stringify({
      command: commandEvidence.command,
      cwd: commandEvidence.cwd,
      status: commandEvidence.status,
      checks: payload.checks,
      cloudProbe: payload.cloudProbe,
      transportProbe: payload.transportProbe,
    }, null, 2),
    source: "product",
    available: true,
  };
}

export async function diagnoseEgressLab(lab: EgressLabHandle): Promise<DiagnosticVerdict> {
  return diagnoseEgressLabProduct(lab);
}

function expectationMatches(text: string, expectation: DiagnosticVerdictExpectation): boolean {
  const value = text.toLowerCase();
  switch (expectation) {
    case "tls12-only":
    case "tls-version-handshake":
      return value.includes("tls 1.3") && (value.includes("tls 1.2") || value.includes("handshake"));
    case "broken-chain":
    case "missing-intermediate":
    case "untrusted-chain":
      return value.includes("missing intermediate") || value.includes("leaf-only") || value.includes("untrusted root") || value.includes("untrusted chain");
    case "intercept":
    case "tls-interception":
      return value.includes("tls interception") || value.includes("re-signed") || value.includes("proxy");
    case "deny":
    case "blocked-host":
    case "proxy":
      return value.includes("blocked host") || value.includes("proxy deny") || value.includes("selective-deny") || value.includes("http 451") || value.includes("allowlist deny");
    case "redirect-chain":
    case "redirect":
      return value.includes("redirect chain") || value.includes("http redirect");
    case "slow":
    case "slow-link":
      return value.includes("slow link");
    case "blip":
    case "transient-401":
      return value.includes("transient") && value.includes("401");
    case "healthy":
      return value.includes("no egress/tls fault") || value.includes("handshake verified") || value.includes("cloud_catalog_exact_match");
  }
}

export function matchVerdictExpectations(text: string, expect: DiagnosticVerdictExpectation | DiagnosticVerdictExpectation[]): { ok: boolean; missing: string[] } {
  const expectations = Array.isArray(expect) ? expect : [expect];
  const missing = expectations.filter((entry) => !expectationMatches(text, entry));
  return { ok: missing.length === 0, missing };
}

export async function expectVerdictNames(ctx: FlowContext, options: { lab: EgressLabHandle; expect: DiagnosticVerdictExpectation | DiagnosticVerdictExpectation[] }): Promise<DiagnosticVerdict> {
  const skipReason = productDiagnosticsPrecondition(ctx.env);
  if (skipReason) ctx.skip(skipReason);
  const verdict = await diagnoseEgressLabProduct(options.lab);
  const corroboration = await diagnoseEgressLabCorroboration(options.lab);
  const matched = matchVerdictExpectations(verdict.text, options.expect);
  ctx.output(`${options.lab.profile} OpenWork product diagnostics verdict`, `${verdict.text}\n\n${verdict.evidence}`);
  ctx.output(`${options.lab.profile} lab-local corroborating probes`, `${corroboration.text}\n\n${corroboration.evidence}`);
  ctx.recordEvidence({
    type: "assertion",
    status: verdict.available && matched.ok ? "passed" : "failed",
    assertion: `OpenWork product diagnostics verdict names ${JSON.stringify(options.expect)}`,
    actual: verdict.text,
  });
  ctx.assert(verdict.available && matched.ok, `OpenWork product diagnostics verdict did not name expected fault(s): ${matched.missing.join(", ")}. Verdict: ${verdict.text}`);
  return verdict;
}

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
  try {
    if (typeof tls.getCACertificates !== "function") return [];
    const result = tls.getCACertificates(scope);
    return Array.isArray(result) ? result : [];
  } catch {
    return [];
  }
}
function fileCerts() {
  const file = process.env.NODE_EXTRA_CA_CERTS || "";
  if (!file) return [];
  try {
    return fs.readFileSync(file, "utf8").match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
  } catch {
    return [];
  }
}
const payload = {
  fileCount: countMatching(fileCerts()),
  extraCount: countMatching(certs("extra")),
  systemCount: countMatching(certs("system")),
  defaultCount: countMatching(certs("default")),
  bundledCount: countMatching(certs("bundled")),
};
payload.reproVisible = payload.fileCount + payload.extraCount + payload.systemCount + payload.defaultCount + payload.bundledCount > 0;
console.log(JSON.stringify(payload));
process.exitCode = payload.reproVisible ? 0 : 1;
`;

function parseRuntimeProbe(stdout: string): RuntimeProbePayload | null {
  try {
    const parsed = JSON.parse(stdout.trim());
    return isRuntimeProbePayload(parsed) ? parsed : null;
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
  const runtimes = [
    { name: "node", command: process.execPath, args: ["--eval", RUNTIME_CA_PROBE] },
    { name: "bun", command: "bun", args: ["--eval", RUNTIME_CA_PROBE] },
  ];
  for (const runtime of runtimes) {
    const result = spawnSync(runtime.command, runtime.args, { env, encoding: "utf8", timeout: 10_000 });
    const payload = parseRuntimeProbe(result.stdout ?? "");
    const ok = result.status === 0 && payload?.reproVisible === true;
    ctx.output(`${runtime.name} CA visibility`, JSON.stringify({ status: result.status, error: result.error?.message ?? null, payload, stderr: result.stderr }, null, 2));
    ctx.recordEvidence({
      type: "assertion",
      status: ok ? "passed" : "failed",
      assertion: `${runtime.name} runtime sees the lab CA through NODE_EXTRA_CA_CERTS`,
      actual: payload ?? result.stderr,
    });
    ctx.assert(ok, `${runtime.name} did not see the lab CA through NODE_EXTRA_CA_CERTS.`);
  }

  const opencode = spawnSync("opencode", ["--version"], { env, encoding: "utf8", timeout: 10_000 });
  if (opencode.error) {
    ctx.output("opencode CA visibility", `opencode sidecar not reachable: ${opencode.error.message}`);
    return;
  }
  const ok = opencode.status === 0;
  ctx.output("opencode CA visibility", JSON.stringify({ status: opencode.status, stdout: opencode.stdout, stderr: opencode.stderr }, null, 2));
  ctx.recordEvidence({
    type: "assertion",
    status: ok ? "passed" : "failed",
    assertion: "opencode sidecar starts with the same NODE_EXTRA_CA_CERTS environment when reachable",
    actual: opencode.stdout || opencode.stderr,
  });
  ctx.assert(ok, "opencode sidecar was reachable but did not start with the CA environment.");
}
