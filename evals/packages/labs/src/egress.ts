import { execFile, spawnSync } from "node:child_process";
import { randomUUID, X509Certificate } from "node:crypto";
import { readFile, rm, writeFile, mkdtemp, mkdir } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";

export type EgressLabProfile =
  | "healthy"
  | "tls12-only"
  | "broken-chain"
  | "intercept"
  | "deny"
  | "redirect-chain"
  | "slow"
  | "blip";

export type DenyMode = "refuse" | "blackhole";
export type BlipFault = "401" | "reset";

export type SlowProfileOptions = {
  totalBytes?: number;
  chunkBytes?: number;
  delayMs?: number;
  latencyMs?: number;
};

export type BlipRuleInput = {
  route?: string;
  count?: number;
  fault?: BlipFault;
  status?: number;
  body?: string;
};

export type StartEgressLabOptions = {
  profile: EgressLabProfile;
  upstream?: string;
  port?: number;
  denyHosts?: string[];
  denyMode?: DenyMode;
  slow?: SlowProfileOptions;
  blip?: BlipRuleInput;
};

export type ResolvedEgressProfileConfig = {
  profile: EgressLabProfile;
  host: string;
  hostname: string;
  port: number | null;
  upstream: string | null;
  denyHosts: string[];
  denyMode: DenyMode;
  slow: Required<SlowProfileOptions>;
  blip: Required<BlipRuleInput>;
};

export type EgressLabHandle = {
  profile: EgressLabProfile;
  url: string;
  caPath?: string;
  rootPemPath?: string;
  rootPem?: string;
  intermediatePemPath?: string;
  intermediateDerPath?: string;
  aiaUrl?: string;
  deniedHosts: string[];
  stop(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
};

export type ClientHelloParseResult = {
  kind: "parsed";
  recordVersion: number;
  legacyVersion: number;
  supportedVersions: number[];
  supportedVersionLabels: string[];
  offersTls13: boolean;
} | {
  kind: "incomplete";
  neededBytes: number;
} | {
  kind: "invalid";
  reason: string;
};

export type OpenSslCommand = {
  label: string;
  args: string[];
};

export type OpenSslCommandInput = {
  dir: string;
  hostname: string;
  aiaUrl: string | null;
  corporateIssuer: boolean;
};

export type OpenSslFlavor = "openssl" | "libressl" | "unknown";

export type OutboundManifestHostEntry = {
  host: string;
  kind: string;
  components: string[];
  requirement: string;
  blockedEffect: string;
};

export type OutboundManifest = {
  hosts: OutboundManifestHostEntry[];
};

export type BlipDecision = {
  kind: "pass";
} | {
  kind: "status";
  status: number;
  body: string;
} | {
  kind: "reset";
};

export type BlipSchedule = {
  next(route: string): BlipDecision;
  snapshot(): { route: string; remaining: number; fault: BlipFault; status: number; body: string }[];
};

type CertificateMaterial = {
  dir: string;
  rootPemPath: string;
  rootPem: string;
  intermediatePemPath: string;
  intermediateDerPath: string;
  leafKeyPath: string;
  leafKeyPem: string;
  leafCertPath: string;
  leafCertPem: string;
  fullChainPath: string;
  fullChainPem: string;
};

type HttpServer = http.Server<typeof IncomingMessage, typeof ServerResponse>;
type HttpsServer = https.Server<typeof IncomingMessage, typeof ServerResponse>;
type LabServer = HttpServer | HttpsServer | net.Server;

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const OUTBOUND_ACCESS_MANIFEST = path.join(REPO_ROOT, "docs", "enterprise", "outbound-access.json");
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_HOSTNAME = "localhost";
const DEFAULT_SLOW_TOTAL_BYTES = 21 * 1024 * 1024;
const DEFAULT_SLOW_CHUNK_BYTES = 64 * 1024;
const DEFAULT_SLOW_DELAY_MS = 50;
const DEFAULT_TLS_STALL_TIMEOUT_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function cleanHost(value: string): string | null {
  const host = value.trim().toLowerCase().replace(/\.$/u, "");
  if (!host || host.includes("://") || host.includes("/") || host.includes("\\")) return null;
  return host;
}

function uniqueHosts(hosts: Iterable<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const host of hosts) {
    const cleaned = cleanHost(host);
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out.sort((left, right) => left.localeCompare(right));
}

function normalizeRoute(route: string | undefined): string {
  const value = route?.trim() || "/";
  return value.startsWith("/") ? value : `/${value}`;
}

function validPort(value: number | undefined): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65_535 ? value : null;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function httpStatus(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599 ? value : fallback;
}

function blipFault(value: BlipFault | undefined): BlipFault {
  return value === "reset" ? "reset" : "401";
}

export function resolveEgressProfileConfig(options: StartEgressLabOptions): ResolvedEgressProfileConfig {
  const configuredPort = validPort(options.port);
  const slow = options.slow ?? {};
  const blip = options.blip ?? {};
  return {
    profile: options.profile,
    host: DEFAULT_HOST,
    hostname: DEFAULT_HOSTNAME,
    port: configuredPort,
    upstream: typeof options.upstream === "string" && options.upstream.trim() ? options.upstream.trim() : null,
    denyHosts: uniqueHosts(options.denyHosts ?? []),
    denyMode: options.denyMode === "blackhole" ? "blackhole" : "refuse",
    slow: {
      totalBytes: positiveInteger(slow.totalBytes, DEFAULT_SLOW_TOTAL_BYTES),
      chunkBytes: positiveInteger(slow.chunkBytes, DEFAULT_SLOW_CHUNK_BYTES),
      delayMs: nonNegativeInteger(slow.delayMs, DEFAULT_SLOW_DELAY_MS),
      latencyMs: nonNegativeInteger(slow.latencyMs, 0),
    },
    blip: {
      route: normalizeRoute(blip.route),
      count: positiveInteger(blip.count, 1),
      fault: blipFault(blip.fault),
      status: httpStatus(blip.status, 401),
      body: typeof blip.body === "string" ? blip.body : "",
    },
  };
}

export function outboundManifestFromUnknown(value: unknown): OutboundManifest | null {
  if (!isRecord(value) || !Array.isArray(value.hosts)) return null;
  const hosts: OutboundManifestHostEntry[] = [];
  for (const entry of value.hosts) {
    if (!isRecord(entry)) continue;
    if (
      typeof entry.host !== "string"
      || typeof entry.kind !== "string"
      || !isStringArray(entry.components)
      || typeof entry.requirement !== "string"
      || typeof entry.blockedEffect !== "string"
    ) continue;
    hosts.push({
      host: entry.host,
      kind: entry.kind,
      components: entry.components,
      requirement: entry.requirement,
      blockedEffect: entry.blockedEffect,
    });
  }
  return { hosts };
}

export function denyHostsFromOutboundManifest(manifest: OutboundManifest): string[] {
  return uniqueHosts(manifest.hosts.flatMap((entry) => {
    const installerCritical = entry.components.includes("installer")
      && (entry.requirement === "required-in-practice" || entry.requirement === "required" || entry.requirement === "required-for-cloud");
    const githubInstaller = entry.host === "github.com";
    const redirectTarget = entry.kind === "redirect-target" && entry.components.includes("installer");
    return installerCritical || githubInstaller || redirectTarget ? [entry.host] : [];
  }));
}

export async function readDefaultDenyHosts(): Promise<string[]> {
  const parsed = JSON.parse(await readFile(OUTBOUND_ACCESS_MANIFEST, "utf8"));
  const manifest = outboundManifestFromUnknown(parsed);
  return manifest ? denyHostsFromOutboundManifest(manifest) : [];
}

function versionLabel(version: number): string {
  if (version === 0x0304) return "TLSv1.3";
  if (version === 0x0303) return "TLSv1.2";
  if (version === 0x0302) return "TLSv1.1";
  if (version === 0x0301) return "TLSv1.0";
  return `0x${version.toString(16).padStart(4, "0")}`;
}

function needBytes(buffer: Buffer, neededBytes: number): ClientHelloParseResult | null {
  return buffer.length < neededBytes ? { kind: "incomplete", neededBytes } : null;
}

/**
 * Parses only enough of the first TLS record to decide whether the client
 * offered TLS 1.3. The lab reads the record header (content type 0x16), the
 * ClientHello body, skips the variable session/cipher/compression vectors, and
 * then scans extension 0x002b (supported_versions). TLS 1.3 clients advertise
 * 0x0304 there even though the legacy ClientHello version remains 0x0303.
 */
export function parseClientHelloVersions(buffer: Buffer): ClientHelloParseResult {
  const firstNeed = needBytes(buffer, 11);
  if (firstNeed) return firstNeed;
  if (buffer[0] !== 0x16) return { kind: "invalid", reason: "first record is not a TLS handshake" };
  const recordVersion = buffer.readUInt16BE(1);
  const recordLength = buffer.readUInt16BE(3);
  const recordEnd = 5 + recordLength;
  const recordNeed = needBytes(buffer, recordEnd);
  if (recordNeed) return recordNeed;
  if (buffer[5] !== 0x01) return { kind: "invalid", reason: "first handshake message is not ClientHello" };
  const handshakeLength = (buffer[6] << 16) + (buffer[7] << 8) + buffer[8];
  if (handshakeLength + 4 > recordLength) return { kind: "invalid", reason: "ClientHello length exceeds TLS record" };
  const legacyVersion = buffer.readUInt16BE(9);
  let cursor = 11 + 32;
  const sessionNeed = needBytes(buffer, cursor + 1);
  if (sessionNeed) return sessionNeed;
  const sessionLength = buffer[cursor];
  cursor += 1 + sessionLength;
  const cipherNeed = needBytes(buffer, cursor + 2);
  if (cipherNeed) return cipherNeed;
  const cipherLength = buffer.readUInt16BE(cursor);
  cursor += 2 + cipherLength;
  const compressionNeed = needBytes(buffer, cursor + 1);
  if (compressionNeed) return compressionNeed;
  const compressionLength = buffer[cursor];
  cursor += 1 + compressionLength;
  if (cursor > recordEnd) return { kind: "invalid", reason: "ClientHello vectors exceed TLS record" };
  if (cursor === recordEnd) {
    return {
      kind: "parsed",
      recordVersion,
      legacyVersion,
      supportedVersions: [legacyVersion],
      supportedVersionLabels: [versionLabel(legacyVersion)],
      offersTls13: false,
    };
  }
  const extensionsNeed = needBytes(buffer, cursor + 2);
  if (extensionsNeed) return extensionsNeed;
  const extensionsLength = buffer.readUInt16BE(cursor);
  cursor += 2;
  const extensionsEnd = cursor + extensionsLength;
  if (extensionsEnd > recordEnd) return { kind: "invalid", reason: "ClientHello extensions exceed TLS record" };
  const supportedVersions: number[] = [];
  while (cursor + 4 <= extensionsEnd) {
    const type = buffer.readUInt16BE(cursor);
    const length = buffer.readUInt16BE(cursor + 2);
    cursor += 4;
    const valueEnd = cursor + length;
    if (valueEnd > extensionsEnd) return { kind: "invalid", reason: "ClientHello extension exceeds extension block" };
    if (type === 0x002b && length >= 3) {
      const vectorLength = buffer[cursor];
      let versionCursor = cursor + 1;
      const versionEnd = Math.min(valueEnd, versionCursor + vectorLength);
      while (versionCursor + 1 < versionEnd) {
        supportedVersions.push(buffer.readUInt16BE(versionCursor));
        versionCursor += 2;
      }
    }
    cursor = valueEnd;
  }
  const versions = supportedVersions.length > 0 ? supportedVersions : [legacyVersion];
  return {
    kind: "parsed",
    recordVersion,
    legacyVersion,
    supportedVersions: versions,
    supportedVersionLabels: versions.map(versionLabel),
    offersTls13: versions.includes(0x0304),
  };
}

function pkiPaths(dir: string) {
  return {
    rootKey: path.join(dir, "root.key.pem"),
    rootCsr: path.join(dir, "root.csr.pem"),
    rootPem: path.join(dir, "root.pem"),
    intermediateKey: path.join(dir, "intermediate.key.pem"),
    intermediateCsr: path.join(dir, "intermediate.csr.pem"),
    intermediatePem: path.join(dir, "intermediate.pem"),
    intermediateDer: path.join(dir, "intermediate.der"),
    leafKey: path.join(dir, "leaf.key.pem"),
    leafCsr: path.join(dir, "leaf.csr.pem"),
    leafPem: path.join(dir, "leaf.pem"),
    fullChain: path.join(dir, "fullchain.pem"),
    rootExt: path.join(dir, "root.ext"),
    intermediateExt: path.join(dir, "intermediate.ext"),
    leafExt: path.join(dir, "leaf.ext"),
  };
}

export function opensslCertificateCommands(input: OpenSslCommandInput): OpenSslCommand[] {
  const files = pkiPaths(input.dir);
  const rootSubject = input.corporateIssuer
    ? "/CN=OpenWork Egress Lab Corporate Root CA"
    : "/CN=OpenWork Egress Lab Root CA";
  const intermediateSubject = input.corporateIssuer
    ? "/CN=OpenWork Egress Lab Corporate Interception CA"
    : "/CN=OpenWork Egress Lab Intermediate CA";
  return [
    { label: "root-key", args: ["genrsa", "-out", files.rootKey, "2048"] },
    { label: "root-csr", args: ["req", "-new", "-key", files.rootKey, "-out", files.rootCsr, "-subj", rootSubject] },
    {
      // Self-sign via `x509 -req -extfile` instead of `req -x509 -addext`.
      // OpenSSL 1.1.1 applies `-addext` to the CSR's requested extensions and
      // does not copy them into the self-signed certificate, so the root was
      // emitted with no basicConstraints (CA:FALSE) and clients could not build
      // the chain (UNABLE_TO_GET_ISSUER_CERT_LOCALLY). OpenSSL 3.x applies them,
      // which is why this only broke on runners shipping 1.1.1 (macos-14).
      // `-extfile` is honored identically by 1.1.1, 3.x and LibreSSL.
      label: "root-cert",
      args: [
        "x509", "-req", "-in", files.rootCsr, "-signkey", files.rootKey,
        "-sha256", "-days", "7", "-out", files.rootPem, "-extfile", files.rootExt,
      ],
    },
    { label: "intermediate-key", args: ["genrsa", "-out", files.intermediateKey, "2048"] },
    { label: "intermediate-csr", args: ["req", "-new", "-key", files.intermediateKey, "-out", files.intermediateCsr, "-subj", intermediateSubject] },
    {
      label: "intermediate-cert",
      args: [
        "x509",
        "-req",
        "-in",
        files.intermediateCsr,
        "-CA",
        files.rootPem,
        "-CAkey",
        files.rootKey,
        "-CAcreateserial",
        "-out",
        files.intermediatePem,
        "-days",
        "7",
        "-sha256",
        "-extfile",
        files.intermediateExt,
      ],
    },
    { label: "intermediate-der", args: ["x509", "-in", files.intermediatePem, "-outform", "DER", "-out", files.intermediateDer] },
    { label: "leaf-key", args: ["genrsa", "-out", files.leafKey, "2048"] },
    { label: "leaf-csr", args: ["req", "-new", "-key", files.leafKey, "-out", files.leafCsr, "-subj", `/CN=${input.hostname}`] },
    {
      label: "leaf-cert",
      args: [
        "x509",
        "-req",
        "-in",
        files.leafCsr,
        "-CA",
        files.intermediatePem,
        "-CAkey",
        files.intermediateKey,
        "-CAcreateserial",
        "-out",
        files.leafPem,
        "-days",
        "7",
        "-sha256",
        "-extfile",
        files.leafExt,
      ],
    },
  ];
}

function opensslBinary(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPENWORK_EVAL_OPENSSL?.trim() || "openssl";
}

export function opensslFlavor(env: NodeJS.ProcessEnv = process.env): Promise<OpenSslFlavor> {
  return new Promise((resolve) => {
    execFile(opensslBinary(env), ["version"], { env, encoding: "utf8", timeout: 5_000 }, (error, stdout, stderr) => {
      if (error) {
        resolve("unknown");
        return;
      }
      const version = `${String(stdout)}\n${String(stderr)}`.toLowerCase();
      if (version.includes("libressl")) resolve("libressl");
      else if (version.includes("openssl")) resolve("openssl");
      else resolve("unknown");
    });
  });
}

function rootExtFile(): string {
  return [
    "basicConstraints=critical,CA:TRUE,pathlen:1",
    "keyUsage=critical,keyCertSign,cRLSign",
    "subjectKeyIdentifier=hash",
    "",
  ].join("\n");
}

function intermediateExtFile(): string {
  return [
    "basicConstraints=critical,CA:TRUE,pathlen:0",
    "keyUsage=critical,keyCertSign,cRLSign",
    "subjectKeyIdentifier=hash",
    "authorityKeyIdentifier=keyid,issuer",
  ].join("\n") + "\n";
}

function leafExtFile(hostname: string, aiaUrl: string | null): string {
  const lines = [
    "basicConstraints=critical,CA:FALSE",
    "keyUsage=critical,digitalSignature,keyEncipherment",
    "extendedKeyUsage=serverAuth",
    `subjectAltName=DNS:${hostname},DNS:localhost,IP:127.0.0.1`,
    "authorityKeyIdentifier=keyid,issuer",
  ];
  if (aiaUrl) lines.push(`authorityInfoAccess=caIssuers;URI:${aiaUrl}`);
  return `${lines.join("\n")}\n`;
}

function execOpenSsl(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const binary = opensslBinary();
    execFile(binary, args, { cwd, encoding: "utf8", timeout: 20_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error([`${binary} ${args.join(" ")}`, String(stdout).trim(), String(stderr).trim(), error.message].filter(Boolean).join("\n")));
        return;
      }
      resolve();
    });
  });
}

/**
 * Fail loudly when the local openssl emitted a non-CA certificate. Without this
 * the defect surfaces much later as an opaque TLS error in whichever test
 * happens to verify a chain.
 */
function assertGeneratedCa(label: "root" | "intermediate", pem: string): void {
  const certificate = new X509Certificate(pem);
  if (certificate.ca) return;
  const version = spawnSync("openssl", ["version"], { encoding: "utf8" });
  throw new Error([
    `Egress lab ${label} certificate was generated without basicConstraints CA:TRUE.`,
    `openssl: ${String(version.stdout || version.stderr).trim() || "unknown"}`,
    `subject: ${certificate.subject}`,
  ].join(" "));
}

async function generateCertificateMaterial(input: { hostname: string; aiaUrl: string | null; corporateIssuer: boolean }): Promise<CertificateMaterial> {
  const dir = await mkdtemp(path.join(tmpdir(), "openwork-egress-lab-"));
  const files = pkiPaths(dir);
  await writeFile(files.rootExt, rootExtFile(), "utf8");
  await writeFile(files.intermediateExt, intermediateExtFile(), "utf8");
  await writeFile(files.leafExt, leafExtFile(input.hostname, input.aiaUrl), "utf8");
  for (const command of opensslCertificateCommands({ dir, hostname: input.hostname, aiaUrl: input.aiaUrl, corporateIssuer: input.corporateIssuer })) {
    await execOpenSsl(command.args, dir);
  }
  const leaf = await readFile(files.leafPem, "utf8");
  const intermediate = await readFile(files.intermediatePem, "utf8");
  assertGeneratedCa("root", await readFile(files.rootPem, "utf8"));
  assertGeneratedCa("intermediate", intermediate);
  const fullChain = `${leaf.trim()}\n${intermediate.trim()}\n`;
  await writeFile(files.fullChain, fullChain, "utf8");
  return {
    dir,
    rootPemPath: files.rootPem,
    rootPem: await readFile(files.rootPem, "utf8"),
    intermediatePemPath: files.intermediatePem,
    intermediateDerPath: files.intermediateDer,
    leafKeyPath: files.leafKey,
    leafKeyPem: await readFile(files.leafKey, "utf8"),
    leafCertPath: files.leafPem,
    leafCertPem: leaf,
    fullChainPath: files.fullChain,
    fullChainPem: fullChain,
  };
}

function listen(server: LabServer, port: number | null, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(port ?? 0, host, () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Lab server did not bind a TCP port."));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(server: LabServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function reservePort(host: string): Promise<number> {
  const server = net.createServer();
  const port = await listen(server, null, host);
  await closeServer(server);
  return port;
}

function jsonResponse(response: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(body)),
    ...headers,
  });
  response.end(body);
}

function textResponse(response: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": String(Buffer.byteLength(body)),
    ...headers,
  });
  response.end(body);
}

function requestPath(request: IncomingMessage): string {
  try {
    return new URL(request.url ?? "/", "http://egress.lab").pathname;
  } catch {
    return "/";
  }
}

function requestHostHeader(headersHost: string | string[] | undefined): string | null {
  const raw = Array.isArray(headersHost) ? headersHost[0] : headersHost;
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    return cleanHost(new URL(`http://${raw}`).hostname);
  } catch {
    const withoutPort = raw.split(":", 1)[0] ?? raw;
    return cleanHost(withoutPort);
  }
}

function targetHostFromRequest(request: IncomingMessage): string | null {
  try {
    const url = new URL(request.url ?? "/", "http://egress.lab");
    const targetUrl = url.searchParams.get("url");
    if (targetUrl) return cleanHost(new URL(targetUrl).hostname);
    const targetHost = url.searchParams.get("host") ?? request.headers["x-egress-target-host"];
    if (typeof targetHost === "string") return cleanHost(targetHost);
    const hostPath = /^\/host\/([^/]+)/u.exec(url.pathname);
    if (hostPath?.[1]) return cleanHost(decodeURIComponent(hostPath[1]));
  } catch {
    return null;
  }
  return requestHostHeader(request.headers.host);
}

function createDenyServer(config: ResolvedEgressProfileConfig): HttpServer {
  const denyHosts = new Set(config.denyHosts);
  return http.createServer((request, response) => {
    const host = targetHostFromRequest(request) ?? "unknown";
    if (denyHosts.has(host)) {
      if (config.denyMode === "blackhole") return;
      jsonResponse(response, 451, {
        error: "EGRESS_HOST_BLOCKED",
        host,
        message: `${host} is blocked by the egress lab deny profile. Check docs/enterprise/outbound-access.json before calling this an app bug.`,
        allowlistManifest: "docs/enterprise/outbound-access.json",
      });
      return;
    }
    jsonResponse(response, 200, { ok: true, host, deniedHosts: config.denyHosts });
  });
}

function createRedirectServer(config: ResolvedEgressProfileConfig): HttpServer {
  return http.createServer((request, response) => {
    const currentPath = requestPath(request);
    const host = request.headers.host ?? "127.0.0.1";
    const base = `http://${host}`;
    if (currentPath === "/" || currentPath === "/redirect-chain/start" || currentPath === "/mcp/agent") {
      response.writeHead(302, { location: `${base}/redirect-chain/hop1` });
      response.end();
      return;
    }
    if (currentPath === "/redirect-chain/hop1") {
      response.writeHead(302, { location: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize" });
      response.end();
      return;
    }
    jsonResponse(response, 200, { ok: true, profile: config.profile, upstream: config.upstream });
  });
}

function createSlowServer(config: ResolvedEgressProfileConfig): HttpServer {
  return http.createServer((request, response) => {
    const totalBytes = config.slow.totalBytes;
    const chunkBytes = Math.min(config.slow.chunkBytes, totalBytes);
    const delayMs = config.slow.delayMs;
    let sent = 0;
    const start = () => {
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(totalBytes),
        "x-openwork-egress-lab": "slow",
      });
      const writeNext = () => {
        if (sent >= totalBytes) {
          response.end();
          return;
        }
        const size = Math.min(chunkBytes, totalBytes - sent);
        sent += size;
        response.write(Buffer.alloc(size, 0x61));
        setTimeout(writeNext, delayMs);
      };
      writeNext();
    };
    if (requestPath(request) !== "/slow" && requestPath(request) !== "/") {
      jsonResponse(response, 404, { error: "not_found" });
      return;
    }
    setTimeout(start, config.slow.latencyMs);
  });
}

export function createBlipSchedule(ruleInput: BlipRuleInput | BlipRuleInput[]): BlipSchedule {
  const inputRules = Array.isArray(ruleInput) ? ruleInput : [ruleInput];
  const rules = inputRules.map((rule) => ({
    route: normalizeRoute(rule.route),
    remaining: positiveInteger(rule.count, 1),
    fault: blipFault(rule.fault),
    status: httpStatus(rule.status, 401),
    body: typeof rule.body === "string" ? rule.body : "",
  }));
  return {
    next(route: string): BlipDecision {
      const normalized = normalizeRoute(route);
      const match = rules.find((rule) => rule.remaining > 0 && (rule.route === "/" || normalized === rule.route || normalized.startsWith(`${rule.route}/`)));
      if (!match) return { kind: "pass" };
      match.remaining -= 1;
      if (match.fault === "reset") return { kind: "reset" };
      return { kind: "status", status: match.status, body: match.body };
    },
    snapshot() {
      return rules.map((rule) => ({ route: rule.route, remaining: rule.remaining, fault: rule.fault, status: rule.status, body: rule.body }));
    },
  };
}

function createBlipServer(config: ResolvedEgressProfileConfig): HttpServer {
  const schedule = createBlipSchedule(config.blip);
  return http.createServer(async (request, response) => {
    const route = requestPath(request);
    const decision = schedule.next(route);
    if (decision.kind === "reset") {
      request.socket.destroy();
      return;
    }
    if (decision.kind === "status") {
      if (decision.body) textResponse(response, decision.status, decision.body);
      else response.writeHead(decision.status, { "content-length": "0" }).end();
      return;
    }
    if (route === "/mcp/agent") {
      await handleMcpAgentRequest(request, response);
      return;
    }
    if (route.endsWith("/v1/me")) {
      jsonResponse(response, 200, { user: { id: "user_egress_blip", email: "lab@example.com", name: "Egress Lab" } });
      return;
    }
    jsonResponse(response, 200, { ok: true, profile: "blip", route, schedule: schedule.snapshot() });
  });
}

async function requestBodyText(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function requestJsonRpcMethod(payload: unknown): string | null {
  return isRecord(payload) && typeof payload.method === "string" ? payload.method : null;
}

function requestJsonRpcId(payload: unknown): string | number | null {
  if (!isRecord(payload)) return null;
  if (typeof payload.id === "string" || typeof payload.id === "number") return payload.id;
  return null;
}

async function handleMcpAgentRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method === "DELETE") {
    response.writeHead(204, { "content-length": "0" }).end();
    return;
  }
  if (request.method !== "POST") {
    jsonResponse(response, 405, { error: "method_not_allowed" });
    return;
  }
  let payload: unknown = null;
  try {
    payload = JSON.parse(await requestBodyText(request));
  } catch {
    jsonResponse(response, 400, { error: "invalid_json" });
    return;
  }
  const method = requestJsonRpcMethod(payload);
  const id = requestJsonRpcId(payload);
  if (method === "initialize") {
    jsonResponse(response, 200, {
      jsonrpc: "2.0",
      id,
      result: {
        capabilities: {},
        protocolVersion: "2025-06-18",
        serverInfo: { name: "openwork-egress-lab", version: "1.0.0" },
      },
    }, {
      "mcp-session-id": "egress-lab-session",
      "mcp-protocol-version": "2025-06-18",
    });
    return;
  }
  if (method === "notifications/initialized") {
    response.writeHead(202, { "content-length": "0" }).end();
    return;
  }
  if (method === "tools/list") {
    jsonResponse(response, 200, {
      jsonrpc: "2.0",
      id,
      result: {
        tools: [
          { name: "search_capabilities", description: "Search capabilities", inputSchema: { type: "object" } },
          { name: "execute_capability", description: "Execute a capability", inputSchema: { type: "object" } },
        ],
      },
    });
    return;
  }
  jsonResponse(response, 400, { error: "unsupported_method" });
}

function createAiaServer(intermediateDerPath: string): HttpServer {
  return http.createServer(async (request, response) => {
    if (requestPath(request) !== "/__egress-lab/intermediate.der") {
      jsonResponse(response, 404, { error: "not_found" });
      return;
    }
    const body = await readFile(intermediateDerPath);
    response.writeHead(200, {
      "content-type": "application/pkix-cert",
      "content-length": String(body.byteLength),
    });
    response.end(body);
  });
}

function createHttpsServer(profile: EgressLabProfile, material: CertificateMaterial, includeIntermediate: boolean): HttpsServer {
  const cert = includeIntermediate ? material.fullChainPem : material.leafCertPem;
  return https.createServer({ key: material.leafKeyPem, cert }, (request, response) => {
    jsonResponse(response, 200, {
      ok: true,
      profile,
      path: requestPath(request),
      upstream: null,
    }, { "x-openwork-egress-lab": profile });
  });
}

function tlsHttpOk(socket: tls.TLSSocket, profile: EgressLabProfile): void {
  const body = `${JSON.stringify({ ok: true, profile })}\n`;
  socket.write([
    "HTTP/1.1 200 OK",
    "content-type: application/json; charset=utf-8",
    `content-length: ${Buffer.byteLength(body)}`,
    "connection: close",
    "",
    body,
  ].join("\r\n"));
  socket.end();
}

function createTls12OnlyServer(material: CertificateMaterial, stalledSockets: Set<net.Socket>): net.Server {
  const tls12Server = tls.createServer({
    key: material.leafKeyPem,
    cert: material.fullChainPem,
    minVersion: "TLSv1.2",
    maxVersion: "TLSv1.2",
  }, (socket) => {
    socket.on("error", () => undefined);
    socket.once("data", () => tlsHttpOk(socket, "tls12-only"));
    socket.setTimeout(5_000, () => tlsHttpOk(socket, "tls12-only"));
  });
  tls12Server.on("tlsClientError", () => undefined);

  return net.createServer((socket) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let forwarded = false;
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
    };
    const forwardToTls12 = () => {
      if (forwarded) return;
      forwarded = true;
      cleanup();
      socket.pause();
      socket.unshift(Buffer.concat(chunks, total));
      tls12Server.emit("connection", socket);
    };
    const stall = () => {
      cleanup();
      socket.on("error", () => undefined);
      stalledSockets.add(socket);
      socket.on("close", () => stalledSockets.delete(socket));
      socket.pause();
      setTimeout(() => {
        if (!socket.destroyed) socket.destroy();
      }, DEFAULT_TLS_STALL_TIMEOUT_MS).unref();
    };
    const onError = () => cleanup();
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      total += chunk.byteLength;
      const parsed = parseClientHelloVersions(Buffer.concat(chunks, total));
      if (parsed.kind === "incomplete") return;
      if (parsed.kind === "parsed" && parsed.offersTls13) {
        stall();
        return;
      }
      forwardToTls12();
    };
    socket.on("data", onData);
    socket.on("error", onError);
  });
}

async function startHttpProfile(config: ResolvedEgressProfileConfig): Promise<EgressLabHandle> {
  const denyHosts = config.profile === "deny" && config.denyHosts.length === 0
    ? await readDefaultDenyHosts()
    : config.denyHosts;
  const resolved = { ...config, denyHosts };
  const server = resolved.profile === "deny"
    ? createDenyServer(resolved)
    : resolved.profile === "redirect-chain"
      ? createRedirectServer(resolved)
      : resolved.profile === "slow"
        ? createSlowServer(resolved)
        : createBlipServer(resolved);
  const port = await listen(server, resolved.port, resolved.host);
  const stop = () => closeServer(server);
  return {
    profile: resolved.profile,
    url: `http://${resolved.host}:${port}`,
    deniedHosts: resolved.denyHosts,
    stop,
    [Symbol.asyncDispose]: stop,
  };
}

async function startTlsProfile(config: ResolvedEgressProfileConfig): Promise<EgressLabHandle> {
  const servers: LabServer[] = [];
  const stalledSockets = new Set<net.Socket>();
  let material: CertificateMaterial | null = null;
  let aiaUrl: string | null = null;
  try {
    let aiaPort: number | null = null;
    if (config.profile === "broken-chain") {
      aiaPort = await reservePort(config.host);
      aiaUrl = `http://${config.host}:${aiaPort}/__egress-lab/intermediate.der`;
    }
    material = await generateCertificateMaterial({
      hostname: config.hostname,
      aiaUrl,
      corporateIssuer: config.profile === "intercept",
    });
    if (aiaPort !== null) {
      const aiaServer = createAiaServer(material.intermediateDerPath);
      await listen(aiaServer, aiaPort, config.host);
      servers.push(aiaServer);
    }
    const server = config.profile === "tls12-only"
      ? createTls12OnlyServer(material, stalledSockets)
      : createHttpsServer(config.profile, material, config.profile !== "broken-chain");
    const port = await listen(server, config.port, config.host);
    servers.push(server);
    const stop = async () => {
      for (const socket of stalledSockets) socket.destroy();
      await Promise.all(servers.map((serverToClose) => closeServer(serverToClose).catch(() => undefined)));
      if (material) await rm(material.dir, { recursive: true, force: true });
    };
    return {
      profile: config.profile,
      url: `https://${config.hostname}:${port}`,
      caPath: material.rootPemPath,
      rootPemPath: material.rootPemPath,
      rootPem: material.rootPem,
      intermediatePemPath: material.intermediatePemPath,
      intermediateDerPath: material.intermediateDerPath,
      aiaUrl: aiaUrl ?? undefined,
      deniedHosts: [],
      stop,
      [Symbol.asyncDispose]: stop,
    };
  } catch (error) {
    for (const server of servers) await closeServer(server).catch(() => undefined);
    if (material) await rm(material.dir, { recursive: true, force: true });
    throw error;
  }
}

export async function startEgressLab(options: StartEgressLabOptions): Promise<EgressLabHandle> {
  const config = resolveEgressProfileConfig(options);
  if (config.profile === "deny" || config.profile === "redirect-chain" || config.profile === "slow" || config.profile === "blip") {
    return startHttpProfile(config);
  }
  return startTlsProfile(config);
}

export async function writeTempPemBundle(pems: string[]): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "openwork-egress-ca-bundle-"));
  await mkdir(dir, { recursive: true });
  const bundlePath = path.join(dir, `${randomUUID()}.pem`);
  await writeFile(bundlePath, `${pems.map((pem) => pem.trim()).filter(Boolean).join("\n")}\n`, "utf8");
  return bundlePath;
}

export function labFetchUrl(lab: EgressLabHandle, pathName = "/"): string {
  const url = new URL(lab.url);
  url.pathname = pathName;
  return url.toString();
}
