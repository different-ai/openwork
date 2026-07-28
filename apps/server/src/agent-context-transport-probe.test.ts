import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls, { type ConnectionOptions } from "node:tls";
import { promisify } from "node:util";

import { probeCloudEndpointTransport, type TransportProbeConnector } from "./agent-context-transport-probe.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const stops: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (stops.length) await stops.pop()?.();
  while (roots.length) {
    const root = roots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "openwork-transport-probe-"));
  roots.push(root);
  return root;
}

function closeServer(server: tls.Server | ReturnType<typeof createNetServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function listen(server: tls.Server | ReturnType<typeof createNetServer>): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", onError);
      const address = server.address();
      if (typeof address === "object" && address !== null) resolve(address.port);
      else reject(new Error("Expected a TCP port"));
    });
  });
}

async function closedLoopbackPort(): Promise<number> {
  const server = createNetServer();
  const port = await listen(server);
  await closeServer(server);
  return port;
}

async function selfSignedCertificate(): Promise<{ key: string; cert: string }> {
  const root = await createRoot();
  const keyPath = join(root, "key.pem");
  const certPath = join(root, "cert.pem");
  await execFileAsync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-subj",
    "/CN=localhost",
    "-days",
    "1",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ]);
  return {
    key: await readFile(keyPath, "utf8"),
    cert: await readFile(certPath, "utf8"),
  };
}

async function startSelfSignedTlsServer(): Promise<number> {
  const material = await selfSignedCertificate();
  const server = tls.createServer(material, (socket) => socket.end());
  const port = await listen(server);
  stops.push(() => closeServer(server));
  return port;
}

function captureConnectorOptions(): { connector: TransportProbeConnector; options: ConnectionOptions[] } {
  const options: ConnectionOptions[] = [];
  return {
    connector: (connectionOptions) => {
      options.push(connectionOptions);
      throw new Error("captured options");
    },
    options,
  };
}

function onlyCapturedOption(options: ConnectionOptions[]): ConnectionOptions {
  const option = options[0];
  if (!option || options.length !== 1) throw new Error(`Expected one connector call, got ${options.length}`);
  return option;
}

describe("probeCloudEndpointTransport", () => {
  test("passes SNI servername for DNS endpoints", async () => {
    const capture = captureConnectorOptions();

    await probeCloudEndpointTransport({
      endpointUrl: "https://example.com/mcp/agent",
      performProbe: true,
      timeoutMs: 1_000,
      connector: capture.connector,
      env: {},
    });

    const options = onlyCapturedOption(capture.options);
    expect(options.host).toBe("example.com");
    expect(options.servername).toBe("example.com");
  });

  test("omits SNI servername for IPv4 endpoints", async () => {
    const capture = captureConnectorOptions();

    await probeCloudEndpointTransport({
      endpointUrl: "https://127.0.0.1:444/mcp/agent",
      performProbe: true,
      timeoutMs: 1_000,
      connector: capture.connector,
      env: {},
    });

    const options = onlyCapturedOption(capture.options);
    expect(options.host).toBe("127.0.0.1");
    expect(options.port).toBe(444);
    expect("servername" in options).toBe(false);
  });

  test("omits SNI servername and strips brackets for IPv6 endpoints", async () => {
    const capture = captureConnectorOptions();

    await probeCloudEndpointTransport({
      endpointUrl: "https://[::1]/mcp/agent",
      performProbe: true,
      timeoutMs: 1_000,
      connector: capture.connector,
      env: {},
    });

    const options = onlyCapturedOption(capture.options);
    expect(options.host).toBe("::1");
    expect(options.port).toBe(443);
    expect("servername" in options).toBe(false);
  });

  test("captures certificate-chain evidence for a self-signed endpoint without credentials", async () => {
    const port = await startSelfSignedTlsServer();
    const result = await probeCloudEndpointTransport({
      endpointUrl: `https://127.0.0.1:${port}/mcp/agent`,
      performProbe: true,
      timeoutMs: 1_500,
      env: {},
    });

    expect(result.verifiedHandshake).toBe("failed");
    if (result.verifyErrorCode === null) throw new Error("Expected a TLS verification code");
    expect([
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "SELF_SIGNED_CERT_IN_CHAIN",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    ]).toContain(result.verifyErrorCode);
    expect(result.dnsResolved).toBe(true);
    expect(result.tcpConnected).toBe(true);
    expect(result.servedChainLength).toBe(1);
    expect(result.servedChain[0]).toMatchObject({
      subjectCN: "localhost",
      issuerCN: "localhost",
      selfIssued: true,
    });
    expect(result.endpointOrigin).toBe(`https://127.0.0.1:${port}`);
  });

  test("classifies a refused loopback TCP connection", async () => {
    const port = await closedLoopbackPort();
    const result = await probeCloudEndpointTransport({
      endpointUrl: `https://127.0.0.1:${port}/mcp/agent`,
      performProbe: true,
      timeoutMs: 1_000,
      env: {},
    });

    expect(result.verifiedHandshake).toBe("failed");
    expect(result.verifyErrorCode).not.toBe("ERR_INVALID_ARG_VALUE");
    expect(result.verifyErrorCode).toBe("ECONNREFUSED");
    expect(result.dnsResolved).toBe(true);
    expect(result.tcpConnected).toBe(false);
    expect(result.servedChainLength).toBeNull();
  });

  test("classifies DNS lookup failures", async () => {
    const result = await probeCloudEndpointTransport({
      endpointUrl: "https://no-such-host.invalid/mcp/agent",
      performProbe: true,
      timeoutMs: 1_500,
      env: {},
    });

    expect(result.verifiedHandshake).toBe("failed");
    expect(result.verifyErrorCode).toBe("ENOTFOUND");
    expect(result.dnsResolved).toBe(false);
    expect(result.tcpConnected).toBe(false);
  });

  test("always includes local trust evidence", async () => {
    const result = await probeCloudEndpointTransport({
      endpointUrl: null,
      performProbe: false,
      env: { NODE_EXTRA_CA_CERTS: "/virtual/corporate.pem" },
      caFileReader: () => "-----BEGIN CERTIFICATE-----\none\n-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----\ntwo\n-----END CERTIFICATE-----",
    });

    expect(result.verifiedHandshake).toBe("not-performed");
    expect(typeof result.nodeExtraCaCertsSet).toBe("boolean");
    expect(result.nodeExtraCaCertsSet).toBe(true);
    expect(result.nodeExtraCaCertsFileReadable).toBe(true);
    expect(result.nodeExtraCaCertsCertCount).toBe(2);
    expect(
      result.systemCaCertificateCount === null || typeof result.systemCaCertificateCount === "number",
    ).toBe(true);
    expect(
      result.bundledCaCertificateCount === null || typeof result.bundledCaCertificateCount === "number",
    ).toBe(true);
  });
});
