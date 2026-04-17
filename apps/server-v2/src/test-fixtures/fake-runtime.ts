#!/usr/bin/env bun

import http from "node:http";

function readOption(name: string, fallback = "") {
  return process.env[name]?.trim() || fallback;
}

function parsePort(argv: string[]) {
  const hostArg = argv.find((value) => value.startsWith("--hostname=")) ?? "--hostname=127.0.0.1";
  const portArg = argv.find((value) => value.startsWith("--port=")) ?? "--port=0";
  return {
    host: hostArg.slice("--hostname=".length),
    port: Number.parseInt(portArg.slice("--port=".length), 10) || 0,
  };
}

async function startFakeOpencode(argv: string[]) {
  const mode = readOption("FAKE_RUNTIME_MODE", "success");
  const version = readOption("FAKE_RUNTIME_VERSION", "1.2.27");

  if (mode === "early-exit") {
    console.error("fake opencode exiting before readiness");
    process.exit(7);
  }

  if (mode === "timeout") {
    console.log("fake opencode booting slowly");
    setInterval(() => {}, 1_000);
    await new Promise(() => undefined);
  }

  const { host, port } = parsePort(argv);
  const server = http.createServer((req, res) => {
    const pathname = req.url ? new URL(req.url, "http://localhost").pathname : "";
    if (pathname === "/health" || pathname === "/global/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ healthy: true, version }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve fake opencode address.");
  }

  console.log(`opencode server listening on http://${host}:${address.port}`);

  const exitAfterMs = Number.parseInt(readOption("FAKE_RUNTIME_EXIT_AFTER_MS", "0"), 10) || 0;
  if (exitAfterMs > 0) {
    setTimeout(() => {
      server.close(() => {
        process.exit(3);
      });
    }, exitAfterMs);
  }

  await new Promise<void>((resolve) => {
    const shutdown = () => server.close(() => resolve());
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}

async function startFakeRouter() {
  const mode = readOption("FAKE_RUNTIME_MODE", "success");
  const healthPort = Number.parseInt(readOption("OPENCODE_ROUTER_HEALTH_PORT", "0"), 10);
  if (!healthPort) {
    throw new Error("OPENCODE_ROUTER_HEALTH_PORT is required for the fake router.");
  }

  if (mode === "early-exit") {
    console.error("fake router exiting before readiness");
    process.exit(9);
  }

  if (mode === "timeout") {
    console.log("fake router waiting forever");
    setInterval(() => {}, 1_000);
    await new Promise(() => undefined);
  }

  const server = http.createServer((req, res) => {
    const pathname = req.url ? new URL(req.url, "http://localhost").pathname : "";
    if (pathname === "/health" || pathname === "/") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(healthPort, "127.0.0.1", () => resolve());
  });

  const exitAfterMs = Number.parseInt(readOption("FAKE_RUNTIME_EXIT_AFTER_MS", "0"), 10) || 0;
  if (exitAfterMs > 0) {
    setTimeout(() => {
      server.close(() => {
        process.exit(4);
      });
    }, exitAfterMs);
  }

  await new Promise<void>((resolve) => {
    const shutdown = () => server.close(() => resolve());
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}

async function main() {
  const kind = readOption("FAKE_RUNTIME_KIND", "opencode");
  const [, , ...argv] = process.argv;
  if (argv[0] !== "serve") {
    console.log(readOption("FAKE_RUNTIME_VERSION", "1.2.27"));
    return;
  }

  if (kind === "router") {
    await startFakeRouter();
    return;
  }

  await startFakeOpencode(argv);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
