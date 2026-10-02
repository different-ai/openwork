import { describe, expect, test } from "bun:test";
import type { NextConfig } from "next";
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const appDir = fileURLToPath(new URL("../", import.meta.url));
const appRequire = createRequire(join(appDir, "package.json"));

function installedDependency(id: string, requireFrom = appRequire) {
  return realpathSync(requireFrom.resolve(id));
}

async function routingConfig() {
  const configModule: { exports: NextConfig } = { exports: {} };
  runInNewContext(readFileSync(join(appDir, "next.config.js"), "utf8"), {
    module: configModule,
    __dirname: appDir,
    process: { env: {} },
    require(id: string) {
      if (id === "path") return { join };
      if (id === "./observability/next-config-observability.cjs") {
        return { withObservabilityNextConfig: (config: NextConfig) => config };
      }
      if (id === "./next-config-legacy-connector-redirects.cjs") {
        return { legacyConnectorRedirects: () => [] };
      }
      if (id === "./next-config-den-api-redirects.cjs") {
        return { denApiRedirects: () => { throw new Error("Den redirects must not run in this fixture"); } };
      }
      throw new Error(`Unexpected Next config dependency: ${id}`);
    },
  }, { filename: join(appDir, "next.config.js"), timeout: 1_000 });

  const rewrites = await configModule.exports.rewrites?.();
  if (!Array.isArray(rewrites)) throw new Error("Expected the current ordered rewrite array");
  expect(rewrites.map((rewrite) => rewrite.source)).toEqual([
    "/ow/static/:path*",
    "/ow/array/:path*",
    "/ow/:path*",
  ]);
  expect(configModule.exports.skipTrailingSlashRedirect).toBe(true);
  return { rewrites, skipTrailingSlashRedirect: configModule.exports.skipTrailingSlashRedirect };
}

function upstream(name: string) {
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push(request.url);
      const url = new URL(request.url);
      return Response.json({
        upstream: name,
        pathname: url.pathname,
        search: url.search,
        query: [...url.searchParams],
        method: request.method,
        headers: Object.fromEntries(request.headers),
        body: Buffer.from(await request.arrayBuffer()).toString("base64"),
      });
    },
  });
  return { server, requests, origin: `http://127.0.0.1:${server.port}` };
}

const authRoute = `
export async function POST(request) {
  const url = new URL(request.url);
  return Response.json({
    upstream: "fixture-auth",
    pathname: url.pathname,
    search: url.search,
    query: [...url.searchParams],
    method: request.method,
    headers: Object.fromEntries(request.headers),
    body: Buffer.from(await request.arrayBuffer()).toString("base64"),
  }, { status: 201, headers: {
    "x-eng108-auth-fixture": "unchanged",
    "set-cookie": "eng108-auth=unchanged; Path=/; HttpOnly",
  } });
}
export const GET = POST;
`;

function runner(nextEntry: string, ports: number[]) {
  return `
const net = require("node:net");
const tls = require("node:tls");
const { createServer } = require("node:http");
const allowedPorts = new Set(${JSON.stringify(ports)});
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options = typeof first === "object" ? first : { port: first, host: args[1] };
  if (options?.host !== "127.0.0.1" || !allowedPorts.has(Number(options.port))) {
    throw new Error("ENG-108 blocked a connection outside its loopback fixtures");
  }
  return connect.apply(this, args);
};
tls.connect = () => { throw new Error("ENG-108 forbids TLS and external requests"); };
const next = require(${JSON.stringify(nextEntry)});
let app;
let handle;
const server = createServer((request, response) => {
  if (!handle) { response.writeHead(503); response.end(); return; }
  handle(request, response).catch((error) => {
    console.error(error);
    response.writeHead(500);
    response.end();
  });
});
let stopping = false;
async function stop(code) {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 4_000);
  server.closeAllConnections();
  await Promise.all([
    new Promise((done) => server.close(done)),
    app?.close(),
  ]);
  clearTimeout(deadline);
  process.exit(code);
}
process.on("SIGTERM", () => void stop(0));
process.on("SIGINT", () => void stop(0));
process.on("disconnect", () => void stop(1));
setTimeout(() => void stop(1), 130_000).unref();
server.listen(0, "127.0.0.1", async () => {
  try {
    const port = server.address().port;
    allowedPorts.add(port);
    app = next({ dir: __dirname, dev: true, webpack: true, hostname: "127.0.0.1", port, httpServer: server });
    await app.prepare();
    handle = app.getRequestHandler();
    process.send({ port });
  } catch (error) {
    console.error(error);
    await stop(1);
  }
});
`;
}

async function startFixture(fixture: string) {
  const node = Bun.which("node");
  if (!node) throw new Error("An installed Node runtime is required; downloads are forbidden");
  const child = spawn(node, [join(fixture, "eng108-server.cjs")], {
    cwd: fixture,
    env: {
      NODE_ENV: "development",
      CI: "1",
      PATH: dirname(node),
      // Preserve the caller's isolation; never select a different HOME/XDG
      // profile. Build output and temporary files stay inside this fixture.
      HOME: process.env.HOME,
      XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
      TMPDIR: fixture,
      NEXT_TELEMETRY_DISABLED: "1",
      NEXT_DISABLE_SWC_WASM: "1",
      NEXT_IGNORE_INCORRECT_LOCKFILE: "1",
      BROWSERSLIST_IGNORE_OLD_DATA: "true",
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "";
  const collect = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-16_000); };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  const exited = new Promise<void>((done) => child.once("close", () => done()));
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const deadline = setTimeout(() => child.kill("SIGKILL"), 5_000);
    try { await exited; } finally { clearTimeout(deadline); }
  };
  try {
    const port = await new Promise<number>((done, fail) => {
      const timeout = setTimeout(() => fail(new Error("Next fixture startup timed out")), 60_000);
      child.once("error", (error) => { clearTimeout(timeout); fail(error); });
      child.once("exit", (code) => { clearTimeout(timeout); fail(new Error(`Next fixture exited: ${code}`)); });
      child.on("message", (message: unknown) => {
        if (message && typeof message === "object" && "port" in message && typeof message.port === "number") {
          clearTimeout(timeout);
          done(message.port);
        }
      });
    });
    return { origin: `http://127.0.0.1:${port}`, stop, output: () => output };
  } catch (error) {
    await stop();
    throw new Error(`${error}\n${output}`);
  }
}

async function exerciseRouting(origin: string, assets: ReturnType<typeof upstream>, ingestion: ReturnType<typeof upstream>) {
  const sensitiveHeaders = {
    CoOkIe: "eng108-session=synthetic-cookie",
    AuThOrIzAtIoN: "Bearer eng108-synthetic-authorization",
    ReFeReR: `${origin}/sign-in?state=eng108-synthetic-referrer`,
  };
  const headers = {
    ...sensitiveHeaders,
    "Content-Type": "application/octet-stream",
    "X-Eng108-Probe": "preserved",
  };
  const body = Buffer.from([0, 31, 139, 255, 13, 10, 123, 34, 120, 34, 58, 49, 125, 0]);
  const query = "?v=2&tag=one&tag=two&encoded=a%2Fb%2Bc&empty=";
  const cases = [
    { path: "/ow", destination: "/", upstream: "ingestion", method: "GET" },
    { path: "/ow/", destination: "/", upstream: "ingestion", method: "GET" },
    { path: "/ow/static/array.js", destination: "/static/array.js", upstream: "assets", method: "GET" },
    { path: "/ow/static/", destination: "/static", upstream: "assets", method: "GET" },
    { path: "/ow/array/eng108-project/config.js", destination: "/array/eng108-project/config.js", upstream: "assets", method: "GET" },
    { path: "/ow/array/", destination: "/array", upstream: "assets", method: "GET" },
    { path: "/ow/e", destination: "/e", upstream: "ingestion", method: "POST" },
    { path: "/ow/e/", destination: "/e", upstream: "ingestion", method: "POST" },
    { path: "/ow/batch/", destination: "/batch", upstream: "ingestion", method: "POST" },
    { path: "/ow/flags/", destination: "/flags", upstream: "ingestion", method: "POST" },
  ];
  for (const entry of cases) {
    const requestUrl = `${origin}${entry.path}${query}`;
    const response = await fetch(requestUrl, {
      method: entry.method,
      headers,
      body: entry.method === "POST" ? body : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
    expect(response.status, entry.path).toBe(200);
    expect(response.headers.get("location"), entry.path).toBeNull();
    expect(response.headers.get("set-cookie"), entry.path).toBeNull();
    const received = await response.json();
    expect(received).toMatchObject({
      upstream: entry.upstream,
      pathname: entry.destination,
      search: query,
      method: entry.method,
      query: [...new URL(requestUrl).searchParams],
      body: entry.method === "POST" ? body.toString("base64") : "",
    });
    for (const name of ["cookie", "authorization", "referer"]) {
      expect(received.headers, entry.path).not.toHaveProperty(name);
      expect(response.headers.has(name), entry.path).toBe(false);
    }
    expect(received.headers["content-type"]).toBe(headers["Content-Type"]);
    expect(received.headers["x-eng108-probe"]).toBe("preserved");
  }
  expect(assets.requests).toHaveLength(4);
  expect(ingestion.requests).toHaveLength(6);

  for (const method of ["GET", "POST"]) {
    const pathname = "/api/auth/eng108-fixture";
    const response = await fetch(`${origin}${pathname}${query}`, {
      method,
      headers,
      body: method === "POST" ? body : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-eng108-auth-fixture")).toBe("unchanged");
    expect(response.headers.get("set-cookie")).toBe("eng108-auth=unchanged; Path=/; HttpOnly");
    expect(await response.json()).toMatchObject({
      upstream: "fixture-auth",
      pathname,
      search: query,
      query: [...new URL(`${origin}${pathname}${query}`).searchParams],
      method,
      body: method === "POST" ? body.toString("base64") : "",
      headers: {
        cookie: sensitiveHeaders.CoOkIe,
        authorization: sensitiveHeaders.AuThOrIzAtIoN,
        referer: sensitiveHeaders.ReFeReR,
        "content-type": headers["Content-Type"],
        "x-eng108-probe": "preserved",
      },
    });
  }
  expect(assets.requests).toHaveLength(4);
  expect(ingestion.requests).toHaveLength(6);
}

describe("PostHog routing through the installed Next framework", () => {
  test("sanitizes external rewrites, preserves wire data and asset precedence, and leaves fixture auth untouched", async () => {
    const config = await routingConfig();
    const nextEntry = installedDependency("next");
    const nextRequire = createRequire(nextEntry);
    const nativePackages: Record<string, string[]> = {
      "darwin-arm64": ["@next/swc-darwin-arm64"],
      "darwin-x64": ["@next/swc-darwin-x64"],
      "linux-x64": ["@next/swc-linux-x64-gnu", "@next/swc-linux-x64-musl"],
      "linux-arm64": ["@next/swc-linux-arm64-gnu", "@next/swc-linux-arm64-musl"],
      "win32-x64": ["@next/swc-win32-x64-msvc"],
      "win32-arm64": ["@next/swc-win32-arm64-msvc"],
    };
    const candidates = nativePackages[`${process.platform}-${process.arch}`];
    if (!candidates) throw new Error("No installed native compiler preflight for this platform; downloads forbidden");
    const failures: unknown[] = [];
    const hasNativeCompiler = candidates.some((nativePackage) => {
      try {
        nextRequire(installedDependency(nativePackage, nextRequire));
        return true;
      } catch (error) {
        failures.push(error);
        return false;
      }
    });
    if (!hasNativeCompiler) throw new AggregateError(failures, "No compatible installed native compiler; downloads forbidden");
    for (const dependency of ["typescript", "react", "react-dom", "@types/react/package.json", "@types/node/package.json"]) {
      installedDependency(dependency);
    }

    const scratch = join(appDir, ".next");
    mkdirSync(scratch, { recursive: true });
    const fixture = mkdtempSync(join(scratch, "eng108-posthog-routing-"));
    const mocks: ReturnType<typeof upstream>[] = [];
    let running: Awaited<ReturnType<typeof startFixture>> | undefined;
    try {
      const assets = upstream("assets");
      mocks.push(assets);
      const ingestion = upstream("ingestion");
      mocks.push(ingestion);
      const origins = config.rewrites.map((rewrite) => new URL(rewrite.destination).origin);
      expect(origins[0]).toBe(origins[1]);
      expect(origins[0]).not.toBe(origins[2]);
      const rewrites = config.rewrites.map((rewrite) => {
        const destination = new URL(rewrite.destination);
        const origin = destination.origin === origins[0] ? assets.origin : ingestion.origin;
        return { ...rewrite, destination: `${origin}${rewrite.destination.slice(destination.origin.length)}` };
      });
      for (const rewrite of rewrites) {
        expect(new URL(rewrite.destination).hostname).toBe("127.0.0.1");
        expect(new URL(rewrite.destination).protocol).toBe("http:");
      }
      writeFileSync(join(fixture, "package.json"), JSON.stringify({ name: "eng108-posthog-routing", private: true }));
      writeFileSync(join(fixture, "next.config.js"), `module.exports = {
        skipTrailingSlashRedirect: ${JSON.stringify(config.skipTrailingSlashRedirect)},
        outputFileTracingRoot: ${JSON.stringify(fixture)},
        async rewrites() { return ${JSON.stringify(rewrites)}; },
      };`);
      writeFileSync(join(fixture, "postcss.config.js"), "module.exports = { plugins: {} };");
      writeFileSync(join(fixture, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true }, include: ["proxy.ts"] }));
      copyFileSync(join(appDir, "proxy.ts"), join(fixture, "proxy.ts"));
      const routeDir = join(fixture, "app", "api", "auth", "eng108-fixture");
      mkdirSync(routeDir, { recursive: true });
      writeFileSync(join(routeDir, "route.js"), authRoute);
      writeFileSync(join(fixture, "eng108-server.cjs"), runner(nextEntry, [assets.server.port, ingestion.server.port]));
      running = await startFixture(fixture);
      await exerciseRouting(running.origin, assets, ingestion);
    } catch (error) {
      throw new Error(`${error}\n${running?.output() ?? ""}`, { cause: error });
    } finally {
      try {
        await running?.stop();
      } finally {
        await Promise.all(mocks.map((mock) => mock.server.stop(true)));
        rmSync(fixture, { recursive: true, force: true });
      }
    }
  }, 180_000);
});
