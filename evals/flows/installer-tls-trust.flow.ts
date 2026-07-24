import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { rmSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineFlow, type FlowContext } from "../runner/flow.ts";
import { loadVoiceoverParagraphs } from "../runner/voiceover.ts";

const FLOW_ID = "installer-tls-trust";
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const INSTALLER_ROOT = join(REPO_ROOT, "apps", "installer");
const INSTALL_TOKEN = "abcDEF12";
const INSTALLER_READY_PATTERN = /UI ready at (http:\/\/127\.0\.0\.1:\d+\/)/;
const COMMAND_TIMEOUT_MS = 120_000;
const INSTALLER_READY_TIMEOUT_MS = 30_000;

type MockInstallConfig = {
  clientName: string;
  webUrl: string;
  apiUrl: string;
  requireSignin: boolean;
  logoUrl: null;
};

type InstallerInstance = {
  process: ChildProcess;
  url: string;
};

type CommandRun = {
  exitCode: number;
  stdout: string;
  stderr: string;
  errorMessage: string | null;
};

type FlowState = {
  certDir: string | null;
  certPath: string | null;
  keyPath: string | null;
  httpsServer: https.Server | null;
  httpServer: http.Server | null;
  httpsPort: number | null;
  httpPort: number | null;
  installerA: InstallerInstance | null;
  installerB: InstallerInstance | null;
};

const vo = await loadVoiceoverParagraphs(FLOW_ID);
if (!vo) throw new Error(`Missing approved voice-over script for ${FLOW_ID}.`);

const state: FlowState = {
  certDir: null,
  certPath: null,
  keyPath: null,
  httpsServer: null,
  httpServer: null,
  httpsPort: null,
  httpPort: null,
  installerA: null,
  installerB: null,
};

let cleanupPromise: Promise<void> | null = null;
let exitBackstopRegistered = false;

function witness(ctx: FlowContext, condition: unknown, assertion: string, actual?: unknown): void {
  if (!condition) {
    ctx.recordEvidence({ type: "assertion", status: "failed", assertion, actual });
    ctx.assert(false, assertion);
  }
  ctx.recordEvidence({ type: "assertion", status: "passed", assertion, actual });
}

function isAddressInfo(value: string | AddressInfo | null): value is AddressInfo {
  return typeof value === "object" && value !== null && typeof value.port === "number";
}

function requiredPort(port: number | null, label: string): number {
  if (port === null) throw new Error(`${label} did not start.`);
  return port;
}

function requiredInstaller(instance: InstallerInstance | null, label: string): InstallerInstance {
  if (!instance) throw new Error(`${label} did not start.`);
  return instance;
}

function tlsInstallLink(): string {
  return `https://127.0.0.1:${requiredPort(state.httpsPort, "HTTPS mock den")}/v1/install-config?token=${INSTALL_TOKEN}`;
}

function plainInstallLink(): string {
  return `http://127.0.0.1:${requiredPort(state.httpPort, "HTTP mock den")}/v1/install-config?token=${INSTALL_TOKEN}`;
}

function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (exited(child)) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(done, timeoutMs);
    function done(): void {
      clearTimeout(timeout);
      child.off("exit", done);
      resolve();
    }
    child.once("exit", done);
  });
}

async function stopChild(child: ChildProcess | null): Promise<void> {
  if (!child || exited(child)) return;
  child.kill();
  await waitForExit(child, 2_000);
  if (!exited(child)) {
    child.kill("SIGKILL");
    await waitForExit(child, 1_000);
  }
}

async function closeServer(server: http.Server | https.Server | null): Promise<void> {
  if (!server || !server.listening) return;
  await new Promise<void>((resolve) => {
    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

function closeServerSync(server: http.Server | https.Server | null): void {
  if (!server || !server.listening) return;
  try {
    server.close();
  } catch {
    // Best-effort backstop during process exit.
  }
}

function cleanupSync(): void {
  stopChildSync(state.installerA?.process ?? null);
  stopChildSync(state.installerB?.process ?? null);
  closeServerSync(state.httpsServer);
  closeServerSync(state.httpServer);
  if (state.certDir) rmSync(state.certDir, { recursive: true, force: true });
}

function stopChildSync(child: ChildProcess | null): void {
  if (!child || exited(child)) return;
  try {
    child.kill();
  } catch {
    // Best-effort backstop during process exit.
  }
}

function registerExitBackstop(): void {
  if (exitBackstopRegistered) return;
  exitBackstopRegistered = true;
  process.once("exit", cleanupSync);
}

async function cleanupOnce(): Promise<void> {
  const installerA = state.installerA;
  const installerB = state.installerB;
  const httpsServer = state.httpsServer;
  const httpServer = state.httpServer;
  const certDir = state.certDir;

  state.installerA = null;
  state.installerB = null;
  state.httpsServer = null;
  state.httpServer = null;
  state.certDir = null;
  state.certPath = null;
  state.keyPath = null;
  state.httpsPort = null;
  state.httpPort = null;

  await stopChild(installerA?.process ?? null);
  await stopChild(installerB?.process ?? null);
  await closeServer(httpsServer);
  await closeServer(httpServer);
  if (certDir) await rm(certDir, { recursive: true, force: true }).catch(() => undefined);
}

async function cleanup(): Promise<void> {
  cleanupPromise ??= cleanupOnce();
  await cleanupPromise;
}

async function withFailureCleanup(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    await cleanup();
    throw error;
  }
}

function commandOutput(command: string, args: string[], run: CommandRun): string {
  const parts = [`$ ${[command, ...args].join(" ")}`, `exit ${String(run.exitCode)}`];
  if (run.stdout.trim()) parts.push(run.stdout.trim());
  if (run.stderr.trim()) parts.push(run.stderr.trim());
  if (run.errorMessage) parts.push(run.errorMessage);
  return parts.join("\n");
}

function execFileCapture(command: string, args: string[], cwd: string, timeoutMs: number): Promise<CommandRun> {
  return new Promise((resolve) => {
    execFile(command, args, { cwd, encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        exitCode: error && typeof error.code === "number" ? error.code : error ? 1 : 0,
        stdout,
        stderr,
        errorMessage: error ? error.message : null,
      });
    });
  });
}

async function createSelfSignedCertificate(): Promise<{ certPath: string; keyPath: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "openwork-installer-fraimz-tls-"));
  const certPath = join(dir, "cert.pem");
  const keyPath = join(dir, "key.pem");
  const args = [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-sha256",
    "-days",
    "1",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ];
  const run = await execFileCapture("openssl", args, dir, COMMAND_TIMEOUT_MS);
  if (run.exitCode !== 0) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw new Error(commandOutput("openssl", args, run));
  }
  return { certPath, keyPath, dir };
}

function writeConfigResponse(response: http.ServerResponse, config: MockInstallConfig): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(config));
}

function listenOnLoopback(server: http.Server | https.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    function onError(error: Error): void {
      server.off("listening", onListening);
      reject(error);
    }
    function onListening(): void {
      server.off("error", onError);
      const address = server.address();
      if (!isAddressInfo(address)) {
        reject(new Error("Mock server did not expose a TCP address."));
        return;
      }
      resolve(address.port);
    }
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
}

async function startHttpsMock(certPath: string, keyPath: string): Promise<{ server: https.Server; port: number }> {
  const config: MockInstallConfig = {
    clientName: "Inspected Corp",
    webUrl: "https://inspected.example.com/",
    apiUrl: "https://inspected-api.example.com/",
    requireSignin: true,
    logoUrl: null,
  };
  const server = https.createServer({ cert: await readFile(certPath), key: await readFile(keyPath) }, (request, response) => {
    if (request.method === "GET") {
      writeConfigResponse(response, config);
      return;
    }
    response.writeHead(405).end();
  });
  return { server, port: await listenOnLoopback(server) };
}

async function startHttpMock(): Promise<{ server: http.Server; port: number }> {
  const config: MockInstallConfig = {
    clientName: "Plain Corp",
    webUrl: "https://plain.example.com/",
    apiUrl: "https://plain-api.example.com/",
    requireSignin: true,
    logoUrl: null,
  };
  const server = http.createServer((request, response) => {
    if (request.method === "GET") {
      writeConfigResponse(response, config);
      return;
    }
    response.writeHead(405).end();
  });
  return { server, port: await listenOnLoopback(server) };
}

function installerEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, ...overrides, OPENWORK_INSTALLER_UI: "manual" };
}

function waitForInstallerUrl(child: ChildProcess, label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => fail(new Error(`${label} did not print its manual UI URL within ${INSTALLER_READY_TIMEOUT_MS}ms.`)), INSTALLER_READY_TIMEOUT_MS);

    function cleanupListeners(): void {
      clearTimeout(timeout);
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.off("error", onError);
      child.off("exit", onExit);
    }

    function fail(error: Error): void {
      if (settled) return;
      settled = true;
      cleanupListeners();
      const detail = stderr.trim() ? `${error.message}\n${stderr.trim()}` : error.message;
      reject(new Error(detail));
    }

    function succeed(url: string): void {
      if (settled) return;
      settled = true;
      cleanupListeners();
      child.stdout?.resume();
      child.stderr?.resume();
      resolve(url);
    }

    function onStdout(chunk: unknown): void {
      stdout += String(chunk);
      const match = INSTALLER_READY_PATTERN.exec(stdout);
      const url = match?.[1];
      if (url) succeed(url);
    }

    function onStderr(chunk: unknown): void {
      stderr += String(chunk);
    }

    function onError(error: Error): void {
      fail(error);
    }

    function onExit(code: number | null, signal: NodeJS.Signals | null): void {
      fail(new Error(`${label} exited before it was ready (${code === null ? signal ?? "unknown signal" : String(code)}).`));
    }

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function startInstaller(label: string, overrides: NodeJS.ProcessEnv = {}): Promise<InstallerInstance> {
  const child = spawn("bun", ["run", "src/index.ts"], {
    cwd: INSTALLER_ROOT,
    env: installerEnv(overrides),
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    return { process: child, url: await waitForInstallerUrl(child, label) };
  } catch (error) {
    await stopChild(child);
    throw error;
  }
}

async function startInfrastructure(): Promise<void> {
  if (state.installerA) return;
  registerExitBackstop();
  const certificate = await createSelfSignedCertificate();
  state.certDir = certificate.dir;
  state.certPath = certificate.certPath;
  state.keyPath = certificate.keyPath;

  const httpsMock = await startHttpsMock(certificate.certPath, certificate.keyPath);
  state.httpsServer = httpsMock.server;
  state.httpsPort = httpsMock.port;

  const httpMock = await startHttpMock();
  state.httpServer = httpMock.server;
  state.httpPort = httpMock.port;

  state.installerA = await startInstaller("installer A");
}

async function startTrustedInstaller(): Promise<void> {
  if (state.installerB) return;
  const certPath = state.certPath;
  if (!certPath) throw new Error("Trusted installer needs the generated certificate path.");
  state.installerB = await startInstaller("installer B", { NODE_EXTRA_CA_CERTS: certPath });
}

async function navigateTo(ctx: FlowContext, url: string): Promise<void> {
  await ctx.eval(`location.href = ${JSON.stringify(url)}`);
  await ctx.waitForText("Paste your install link", { timeoutMs: 30_000 });
}

async function submitInstallLink(ctx: FlowContext, link: string): Promise<void> {
  await ctx.fill("#install-link", link);
  await ctx.clickText("Continue");
}

async function statusText(ctx: FlowContext): Promise<string> {
  const value = await ctx.eval(`document.querySelector("#status")?.textContent ?? ""`);
  return typeof value === "string" ? value : "";
}

async function runSystemCaTests(): Promise<CommandRun> {
  return await execFileCapture("bun", ["test", "-t", "system CA"], INSTALLER_ROOT, COMMAND_TIMEOUT_MS);
}

function outputContainsPassingTests(output: string): boolean {
  const match = /\b(\d+)\s+pass\b/.exec(output);
  if (!match) return false;
  const count = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(count) && count > 0;
}

export default defineFlow({
  id: FLOW_ID,
  title: "OpenWork installer distinguishes untrusted TLS from network failures while preserving successful install-link resolution",
  kind: "user-facing",
  preserveTheme: true,
  steps: [
    {
      name: "Frame 1",
      run: async (ctx) => {
        await withFailureCleanup(async () => {
          await ctx.prove("A new teammate lands on the installer paste screen with OpenWork branding", {
            voiceover: vo[0],
            action: async () => {
              await startInfrastructure();
              await navigateTo(ctx, requiredInstaller(state.installerA, "installer A").url);
            },
            assert: async () => {
              await ctx.expectText("Paste your install link");
              const logoExists = await ctx.eval(`Boolean(document.querySelector("div.logo svg"))`);
              witness(ctx, logoExists === true, "OpenWork logo SVG is present on the paste screen", logoExists);
            },
            screenshot: { name: "installer-paste-screen", requireText: ["Paste your install link"] },
          });
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await withFailureCleanup(async () => {
          await ctx.prove("An intercepted/untrusted workspace certificate is reported honestly instead of blaming the VPN", {
            voiceover: vo[1],
            action: async () => {
              await submitInstallLink(ctx, tlsInstallLink());
            },
            assert: async () => {
              await ctx.waitFor(`document.querySelector("#status")?.textContent?.includes("isn't trusted on this computer yet")`, {
                timeoutMs: 30_000,
                label: "TLS trust error status",
              });
              const text = await statusText(ctx);
              const host = `127.0.0.1:${requiredPort(state.httpsPort, "HTTPS mock den")}`;
              witness(ctx, text.includes(host), "TLS trust error names the certificate host", text);
              await ctx.expectNoText("Check your internet or VPN");
            },
            screenshot: {
              name: "installer-tls-untrusted",
              requireText: ["isn't trusted on this computer yet"],
              rejectText: ["Check your internet or VPN"],
            },
          });
        });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        await withFailureCleanup(async () => {
          await ctx.prove("With the corporate CA trusted the same link resolves into the team's install screen", {
            voiceover: vo[2],
            action: async () => {
              await startTrustedInstaller();
              await navigateTo(ctx, requiredInstaller(state.installerB, "installer B").url);
              await submitInstallLink(ctx, tlsInstallLink());
            },
            assert: async () => {
              await ctx.expectText("This sets up OpenWork for Inspected Corp", { timeoutMs: 30_000 });
              const run = await runSystemCaTests();
              const output = commandOutput("bun", ["test", "-t", "system CA"], run);
              ctx.output("system CA OS-store loader tests", output);
              witness(ctx, run.exitCode === 0, "bun test -t system CA exits 0", output);
              witness(ctx, output.includes(" 0 fail"), "system CA test output reports 0 failures", output);
              witness(ctx, outputContainsPassingTests(output), "system CA test filter selected at least one passing test", output);
            },
            screenshot: { name: "installer-trusted-ca", requireText: ["This sets up OpenWork for Inspected Corp"] },
          });
        });
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        try {
          await ctx.prove("A reachable workspace resolves exactly as before", {
            voiceover: vo[3],
            action: async () => {
              await navigateTo(ctx, requiredInstaller(state.installerA, "installer A").url);
              await submitInstallLink(ctx, plainInstallLink());
            },
            assert: async () => {
              await ctx.expectText("This sets up OpenWork for Plain Corp", { timeoutMs: 30_000 });
            },
            screenshot: { name: "installer-plain-success", requireText: ["This sets up OpenWork for Plain Corp"] },
          });
        } finally {
          await cleanup();
        }
      },
    },
  ],
});
