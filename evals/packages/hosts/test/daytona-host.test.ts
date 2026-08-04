import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { createDaytonaHost } from "../src/daytona.ts";
import type { DaytonaExec } from "../src/daytona.ts";
import type { SurfaceHandle } from "../src/types.ts";
import type { Server } from "node:http";

interface ExecCall {
  args: string[];
  opts?: { input?: string; timeoutMs?: number };
}

function portFromServer(server: Server): number {
  const address = server.address();
  if (typeof address === "object" && address !== null) return address.port;
  throw new Error("Test server did not expose a TCP port.");
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(portFromServer(server)));
  });
}

async function startRuntimeConfigStub(orgMode: "single_org" | "multi_org"): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    if (request.url === "/api/runtime-config") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ orgMode }));
      return;
    }
    response.writeHead(404);
    response.end("not found");
  });
  const port = await listen(server);
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => closeServer(server),
  };
}

function argsText(call: ExecCall): string {
  return call.args.join(" ");
}

function findCall(calls: ExecCall[], text: string): ExecCall {
  const call = calls.find((entry) => argsText(entry).includes(text));
  assert(call, `Expected exec call containing ${text}`);
  return call;
}

function createFakeExec(previewUrlForPort: (port: string) => string): { exec: DaytonaExec; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const exec: DaytonaExec = async (args, opts) => {
    calls.push({ args: [...args], opts });
    if (args[0] === "preview-url") {
      const portFlag = args.indexOf("-p");
      const port = portFlag >= 0 ? args[portFlag + 1] ?? "" : "";
      return { stdout: `time=ignored\nPreview URL: ${previewUrlForPort(port)}\n`, stderr: "", code: 0 };
    }
    return { stdout: "", stderr: "", code: 0 };
  };
  return { exec, calls };
}

function successfulPolls(seen: string[] = []): (url: string) => Promise<void> {
  return async (url) => {
    seen.push(url);
  };
}

function base64AfterEcho(call: ExecCall): string {
  const echoIndex = call.args.indexOf("echo");
  assert(echoIndex >= 0, "Expected echo in base64 write call.");
  return call.args[echoIndex + 1] ?? "";
}

test("Daytona previewUrl parses the first https URL and caches by port", async () => {
  const { exec, calls } = createFakeExec(() => "https://9825-preview.example.test/json/list");
  const host = createDaytonaHost({ sandboxId: "openwork-test-1", log: () => undefined, exec, repoRoot: "/repo" });

  assert.equal(await host.previewUrl(9825), "https://9825-preview.example.test/json/list");
  assert.equal(await host.previewUrl(9825), "https://9825-preview.example.test/json/list");

  assert.equal(calls.filter((call) => call.args[0] === "preview-url").length, 1);
  assert.deepEqual(calls[0]?.args, ["preview-url", "openwork-test-1", "-p", "9825"]);
});

test("spawnElectron starts isolated Daytona Electron profiles and writes bootstrap over base64", async () => {
  const polled: string[] = [];
  const { exec, calls } = createFakeExec((port) => `https://cdp-${port}.example.test`);
  const host = createDaytonaHost({
    sandboxId: "openwork-test-electron",
    log: () => undefined,
    exec,
    repoRoot: "/repo",
    waitForCdp: successfulPolls(polled),
  });
  const bootstrap = { baseUrl: "https://den-web.example.test", apiBaseUrl: "https://den-api.example.test", requireSignin: true };

  const first = await host.spawnElectron("owner", { bootstrap });
  const second = await host.spawnElectron("member");

  assert.equal(first.meta?.cdpPort, "9825");
  assert.equal(second.meta?.cdpPort, "9830");
  assert.match(first.profileDir ?? "", /\/workspace\/\.openwork-daytona\/profiles\/owner-\d{17}\/electron-userdata$/);
  assert.match(second.profileDir ?? "", /\/workspace\/\.openwork-daytona\/profiles\/member-\d{17}\/electron-userdata$/);
  assert.deepEqual(polled, ["https://cdp-9825.example.test/json/list", "https://cdp-9830.example.test/json/list"]);

  const bootstrapCall = findCall(calls, "base64 -d");
  assert.equal(Buffer.from(base64AfterEcho(bootstrapCall), "base64").toString("utf8"), `${JSON.stringify(bootstrap, null, 2)}\n`);
  assert(argsText(bootstrapCall).includes("/workspace/.openwork-daytona/profiles/owner-"));
  assert(argsText(bootstrapCall).includes("/bootstrap.json"));

  const startCalls = calls.filter((call) => argsText(call).includes("/workspace/.devcontainer/start-daytona-electron.sh"));
  assert.equal(startCalls.length, 2);
  const firstStart = argsText(startCalls[0]);
  const secondStart = argsText(startCalls[1]);
  assert(firstStart.includes("openwork-test-electron"));
  assert(firstStart.includes("OPENWORK_ELECTRON_REMOTE_DEBUG_PORT="));
  assert(firstStart.includes("9825"));
  assert(firstStart.includes("OPENWORK_ELECTRON_USERDATA="));
  assert(firstStart.includes("/workspace/.openwork-daytona/profiles/owner-"));
  assert(firstStart.includes("/electron-userdata"));
  assert(firstStart.includes("OPENWORK_DESKTOP_BOOTSTRAP_PATH="));
  assert(firstStart.includes("/workspace/.openwork-daytona/profiles/owner-"));
  assert(firstStart.includes("/bootstrap.json"));
  assert(firstStart.includes("DAYTONA_ELECTRON_LOG="));
  assert(/\/tmp\/electron-owner-\d+/.test(firstStart));
  assert(firstStart.includes("--detach"));
  assert(secondStart.includes("OPENWORK_ELECTRON_REMOTE_DEBUG_PORT="));
  assert(secondStart.includes("9830"));
  assert(secondStart.includes("OPENWORK_ELECTRON_USERDATA="));
  assert(secondStart.includes("/workspace/.openwork-daytona/profiles/member-"));
  assert(secondStart.includes("/electron-userdata"));
});

test("spawnElectron skips reserved Daytona CDP ports", async () => {
  const { exec } = createFakeExec((port) => `https://cdp-${port}.example.test`);
  const host = createDaytonaHost({
    sandboxId: "openwork-test-electron-reserved",
    log: () => undefined,
    exec,
    repoRoot: "/repo",
    reservedElectronPorts: [9825],
    waitForCdp: successfulPolls(),
  });

  const handle = await host.spawnElectron("fresh");

  assert.equal(handle.meta?.cdpPort, "9830");
});

test("spawnChrome launches Chromium with Daytona CDP flags and allocates a second port", async () => {
  const polled: string[] = [];
  const { exec, calls } = createFakeExec((port) => `https://chrome-${port}.example.test`);
  const host = createDaytonaHost({
    sandboxId: "openwork-test-chrome",
    log: () => undefined,
    exec,
    repoRoot: "/repo",
    waitForCdp: successfulPolls(polled),
  });

  const first = await host.spawnChrome("browser");
  const second = await host.spawnChrome("oauth", { startUrl: "https://app.example.test" });

  assert.equal(first.meta?.cdpPort, "9222");
  assert.equal(second.meta?.cdpPort, "9230");
  assert.deepEqual(polled, ["https://chrome-9222.example.test/json/version", "https://chrome-9230.example.test/json/version"]);

  const launchCalls = calls.filter((call) => argsText(call).includes("nohup \"$CHROME_BIN\""));
  assert.equal(launchCalls.length, 2);
  const firstLaunch = argsText(launchCalls[0]);
  const secondLaunch = argsText(launchCalls[1]);
  assert(firstLaunch.includes("command -v chromium || command -v google-chrome || command -v google-chrome-stable"));
  assert(firstLaunch.includes("--headless=new"));
  assert(firstLaunch.includes("--window-size=1280,900"));
  assert(firstLaunch.includes("--no-sandbox"));
  assert(firstLaunch.includes("--disable-dev-shm-usage"));
  assert(firstLaunch.includes("--use-gl=swiftshader"));
  assert(firstLaunch.includes("--remote-debugging-address=0.0.0.0"));
  assert(firstLaunch.includes("--remote-debugging-port=9222"));
  assert(firstLaunch.includes("--user-data-dir="));
  assert(firstLaunch.includes("/tmp/daytona-chrome-browser"));
  assert(secondLaunch.includes("--remote-debugging-port=9230"));
  assert(/https:\/\/app\.example\.test(["'\s]|$)/.test(secondLaunch));
});

test("disposeSurface uses self-match-safe pkill patterns in separate execs", async () => {
  const { exec, calls } = createFakeExec(() => "https://unused.example.test");
  const host = createDaytonaHost({ sandboxId: "openwork-test-dispose", log: () => undefined, exec, repoRoot: "/repo" });
  const electronHandle: SurfaceHandle = {
    name: "desktop",
    kind: "electron",
    hostKind: "daytona",
    cdpUrl: "https://unused.example.test",
    sandboxId: "openwork-test-dispose",
    profileDir: "/workspace/.openwork-daytona/profiles/desktop/electron-userdata",
    meta: { cdpPort: "9825", log: "/tmp/electron-desktop.log" },
  };
  const chromeHandle: SurfaceHandle = {
    name: "browser",
    kind: "chrome",
    hostKind: "daytona",
    cdpUrl: "https://unused.example.test",
    sandboxId: "openwork-test-dispose",
    profileDir: "/tmp/daytona-chrome-browser",
    meta: { cdpPort: "9222", log: "/tmp/daytona-chrome-browser.log" },
  };

  await host.disposeSurface(electronHandle);
  await host.disposeSurface(chromeHandle);

  const electronPkillIndex = calls.findIndex((call) => argsText(call).includes("pkill -f") && argsText(call).includes("remote-debugging-port"));
  const electronVerifyIndex = calls.findIndex((call) => argsText(call).includes("/json/list"));
  assert(electronPkillIndex >= 0);
  assert.equal(electronVerifyIndex, electronPkillIndex + 1);
  const electronPkill = argsText(calls[electronPkillIndex]);
  assert(electronPkill.includes("[e]lectron.*remote-debugging-port=[9]825"));
  assert(!electronPkill.includes("remote-debugging-port=9825"));

  const chromePkill = argsText(findCall(calls, "[/]tmp/daytona-chrome-browser"));
  assert(chromePkill.includes("(chromium|chrome).*--user-data-dir=[/]tmp/daytona-chrome-browser"));
  assert(!chromePkill.includes("--user-data-dir=/tmp/daytona-chrome-browser"));
});

test("Daytona host requires a sandbox option or OPENWORK_EVAL_DAYTONA_SANDBOX", async () => {
  const previous = process.env.OPENWORK_EVAL_DAYTONA_SANDBOX;
  delete process.env.OPENWORK_EVAL_DAYTONA_SANDBOX;
  const { exec } = createFakeExec(() => "https://unused.example.test");
  const host = createDaytonaHost({ log: () => undefined, exec, repoRoot: "/repo" });

  try {
    await assert.rejects(host.previewUrl(9825), /create one with bash \.devcontainer\/test-on-daytona\.sh <ref> or pass sandboxId/);
  } finally {
    if (previous === undefined) delete process.env.OPENWORK_EVAL_DAYTONA_SANDBOX;
    else process.env.OPENWORK_EVAL_DAYTONA_SANDBOX = previous;
  }
});

test("startDen attaches to preset Den env without running daytona exec", async () => {
  const server = await startRuntimeConfigStub("single_org");
  const previousApi = process.env.OPENWORK_EVAL_DEN_API_URL;
  const previousWeb = process.env.OPENWORK_EVAL_DEN_WEB_URL;
  const { exec, calls } = createFakeExec(() => "https://unused.example.test");
  const host = createDaytonaHost({ sandboxId: "openwork-test-den", log: () => undefined, exec, repoRoot: "/repo" });

  try {
    process.env.OPENWORK_EVAL_DEN_API_URL = "https://den-api.example.test";
    process.env.OPENWORK_EVAL_DEN_WEB_URL = server.url;
    const handle = await host.startDen();

    assert.equal(handle.webUrl, server.url);
    assert.equal(handle.apiUrl, "https://den-api.example.test");
    assert.equal(handle.orgMode, "single_org");
    assert.equal(handle.hostKind, "daytona");
    assert.equal(calls.length, 0);
  } finally {
    if (previousApi === undefined) delete process.env.OPENWORK_EVAL_DEN_API_URL;
    else process.env.OPENWORK_EVAL_DEN_API_URL = previousApi;
    if (previousWeb === undefined) delete process.env.OPENWORK_EVAL_DEN_WEB_URL;
    else process.env.OPENWORK_EVAL_DEN_WEB_URL = previousWeb;
    await server.close();
  }
});
