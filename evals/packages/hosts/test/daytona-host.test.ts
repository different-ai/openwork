import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  checkedExec,
  createDaytonaHost,
  defaultDaytonaExec,
  enterpriseTlsEdgeDaytonaCommands,
  MAX_ENTERPRISE_TLS_DAYTONA_COMMAND_LENGTH,
} from "../src/daytona.ts";
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

test("checkedExec retries when the Daytona CLI fails at the transport layer", async () => {
  let callCount = 0;
  const exec: DaytonaExec = async () => {
    callCount += 1;
    if (callCount < 3) {
      return {
        stdout: "",
        stderr: `time="2026-08-18T19:35:11Z" level=fatal msg="invalid character '<' looking for beginning of value"\n`,
        code: 1,
      };
    }
    return { stdout: "done\n", stderr: "", code: 0 };
  };

  const result = await checkedExec(exec, ["exec"], "write Daytona Electron bootstrap", { retryDelayMs: 1 });
  assert.equal(result.stdout, "done\n");
  assert.equal(callCount, 3);
});

test("checkedExec does not retry remote command failures", async () => {
  let callCount = 0;
  const exec: DaytonaExec = async () => {
    callCount += 1;
    return { stdout: "", stderr: "rm: cannot remove '/tmp/gone'\n", code: 1 };
  };

  await assert.rejects(checkedExec(exec, ["exec"], "cleanup profile", { retryDelayMs: 1 }));
  assert.equal(callCount, 1);
});

test("checkedExec reports stderr and stdout from a failed Daytona command", async () => {
  const exec: DaytonaExec = async () => ({
    stdout: "remote process log\n",
    stderr: "Daytona version warning\n",
    code: 1,
  });

  await assert.rejects(
    checkedExec(exec, ["exec"], "Start enterprise TLS edge"),
    (error: Error) => {
      assert.equal(
        error.message,
        "Start enterprise TLS edge failed with exit 1:\nstderr:\nDaytona version warning\n\nstdout:\nremote process log",
      );
      return true;
    },
  );
});

test("defaultDaytonaExec handles stdin EPIPE when the child exits", async () => {
  const result = await defaultDaytonaExec(
    ["-e", "process.stderr.write('remote exited\\n'); process.exit(23)"],
    { input: "x".repeat(8 * 1024 * 1024) },
    process.execPath,
  );

  assert.equal(result.code, 23);
  assert.equal(result.stderr, "remote exited\n");
});

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
  assert.match(first.profileDir ?? "", /\/workspace\/\.openwork-daytona\/profiles\/owner-\d{17}$/);
  assert.match(second.profileDir ?? "", /\/workspace\/\.openwork-daytona\/profiles\/member-\d{17}$/);
  assert.equal(first.meta?.profileOwner, "host");
  assert.equal(second.meta?.profileOwner, "host");
  assert.deepEqual(polled, ["https://cdp-9825.example.test/json/list", "https://cdp-9830.example.test/json/list"]);

  const firstMkdirIndex = calls.findIndex((call) => argsText(call).includes("mkdir -p") && argsText(call).includes("/profiles/owner-"));
  assert(firstMkdirIndex >= 0);

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

test("spawnElectron maps the v2 eval lane before Daytona caller overrides", async () => {
  const previous = process.env.OPENWORK_EVAL_ENGINE;
  process.env.OPENWORK_EVAL_ENGINE = "v2";
  const { exec, calls } = createFakeExec((port) => `https://cdp-${port}.example.test`);
  const host = createDaytonaHost({
    sandboxId: "openwork-test-v2-lane",
    log: () => undefined,
    exec,
    repoRoot: "/repo",
    waitForCdp: successfulPolls(),
  });
  try {
    await host.spawnElectron("v2-default");
    await host.spawnElectron("v2-override", { env: { OPENWORK_ENGINE_V2_PREVIEW: "sidecar" } });
  } finally {
    if (previous === undefined) delete process.env.OPENWORK_EVAL_ENGINE;
    else process.env.OPENWORK_EVAL_ENGINE = previous;
  }

  const starts = calls.filter((call) => argsText(call).includes("/workspace/.devcontainer/start-daytona-electron.sh"));
  assert.match(argsText(starts[0] ?? { args: [] }), /OPENWORK_ENGINE_V2_PREVIEW=.*1/);
  assert.match(argsText(starts[1] ?? { args: [] }), /OPENWORK_ENGINE_V2_PREVIEW=.*sidecar/);
});

test("spawnElectron preserves a caller-owned Daytona profile while generated profiles are removed", async () => {
  const { exec, calls } = createFakeExec((port) => `https://cdp-${port}.example.test`);
  const host = createDaytonaHost({
    sandboxId: "openwork-test-profile-owner",
    log: () => undefined,
    exec,
    repoRoot: "/repo",
    waitForCdp: successfulPolls(),
  });
  const suppliedProfile = "/tmp/reliable-recovery-profile";

  const callerOwned = await host.spawnElectron("caller-owned", { profileDir: suppliedProfile });
  const generated = await host.spawnElectron("generated");

  assert.equal(callerOwned.profileDir, suppliedProfile);
  assert.equal(callerOwned.meta?.profileOwner, "caller");
  assert.equal(generated.meta?.profileOwner, "host");
  const startCalls = calls.filter((call) => argsText(call).includes("/workspace/.devcontainer/start-daytona-electron.sh"));
  assert(argsText(startCalls[0] ?? { args: [] }).includes(`${suppliedProfile}/electron-userdata`));

  await host.disposeSurface(callerOwned);
  await host.disposeSurface(generated);

  const removalCalls = calls.filter((call) => argsText(call).includes("rm -rf"));
  assert.equal(removalCalls.length, 1);
  assert(argsText(removalCalls[0] ?? { args: [] }).includes(generated.profileDir ?? "missing-generated-profile"));
  assert(!removalCalls.some((call) => argsText(call).includes(suppliedProfile)));
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
    profileDir: "/workspace/.openwork-daytona/profiles/desktop",
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

test("enterprise TLS edge commands keep the full lifecycle in one Daytona sandbox", () => {
  const commands = enterpriseTlsEdgeDaytonaCommands({
    sandboxId: "desktop-sandbox",
    upstream: "https://den.example.test",
  });

  assert.equal(commands.candidateUrl, "https://localhost:8443");
  assert.equal(commands.negativeUrl, "https://localhost:9443");
  assert.equal(commands.adminUrl, "http://127.0.0.1:8445");
  for (const command of [commands.start, commands.probe, commands.requests, commands.installRoot, commands.removeRoot, commands.stop]) {
    assert.deepEqual(command.slice(0, 3), ["exec", "desktop-sandbox", "--"]);
  }
  const runtimeRoot = "/tmp/openwork-enterprise-tls-runtime";
  const localSources = [
    fileURLToPath(new URL("../../../scripts/enterprise-tls-edge.mts", import.meta.url)),
    fileURLToPath(new URL("../../labs/src/egress.ts", import.meta.url)),
  ];
  assert.ok(commands.prepare.length > localSources.length * 2);
  const prepare = commands.prepare.map((command) => command.join(" "));
  assert.ok(prepare[0]?.includes(`/usr/bin/rm -rf ${runtimeRoot}`));
  assert.ok(prepare[0]?.includes("/usr/bin/mkdir -p"));
  assert.ok(prepare[0]?.includes("enterprise-tls-edge.mts.b64"));
  assert.ok(prepare[0]?.includes("egress.ts.b64"));
  assert.ok(commands.prepare.every((command) => command.slice(0, 3).join(" ") === "exec desktop-sandbox --"));
  assert.ok(commands.prepare.every((command) => !command.includes("bash -s")));
  assert.ok(commands.prepare.every((command) => !command.includes("sudo -n")));
  const commandLengths = [
    ...commands.prepare,
    commands.start,
    commands.probe,
    commands.requests,
    commands.installRoot,
    commands.removeRoot,
    commands.stop,
  ].map((command) => command.join(" ").length);
  assert.ok(Math.max(...commandLengths) <= MAX_ENTERPRISE_TLS_DAYTONA_COMMAND_LENGTH);
  const chunkPattern = /\/usr\/bin\/printf %s ([A-Za-z0-9+/=]+) >> (\S+\.b64)/;
  const chunksByRemote = new Map<string, string[]>();
  for (const command of prepare) {
    const match = chunkPattern.exec(command);
    if (!match) continue;
    assert.ok((match[1]?.length ?? 0) <= 8 * 1024);
    const chunks = chunksByRemote.get(match[2] ?? "") ?? [];
    chunks.push(match[1] ?? "");
    chunksByRemote.set(match[2] ?? "", chunks);
  }
  for (const [index, source] of localSources.entries()) {
    const content = readFileSync(source);
    const remote = index === 0
      ? `${runtimeRoot}/evals/scripts/enterprise-tls-edge.mts`
      : `${runtimeRoot}/evals/packages/labs/src/egress.ts`;
    assert.equal(chunksByRemote.get(`${remote}.b64`)?.join(""), content.toString("base64"));
    const finalize = prepare.find((command) => command.includes(`/usr/bin/base64 -d ${remote}.b64`));
    assert.ok(finalize?.includes(`/usr/bin/wc -c < ${remote}`));
    assert.ok(finalize?.includes(`/usr/bin/rm -f ${remote}.b64`));
    assert.ok(finalize?.includes(`test \"$actual_bytes\" -eq ${content.byteLength}`));
  }
  const start = commands.start[3] ?? "";
  assert.match(start, /\/tmp\/openwork-enterprise-tls-runtime\/evals\/scripts\/enterprise-tls-edge\.mts/);
  assert.ok(!start.includes("/workspace/evals/scripts/enterprise-tls-edge.mts"));
  assert.ok(!start.includes("&;"));
  assert.ok(start.includes("</dev/null &\nattempt=0\nuntil /usr/bin/curl"));
  assert.ok(start.includes("/usr/bin/tail -c 4000"));
  assert.ok(start.includes(">&2"));
  const tokenMatch = /ENTERPRISE_TLS_ADMIN_TOKEN=([a-f0-9]{32,}) nohup/.exec(start);
  assert.ok(tokenMatch);
  const adminToken = tokenMatch[1];
  assert.match(adminToken, /^[a-f0-9]{32,}$/);
  const serveArgv = start.slice(start.indexOf("enterprise-tls-edge.mts"), start.indexOf(" >"));
  assert.ok(!serveArgv.includes(adminToken));
  const authorizationHeader = `-H "Authorization: Bearer ${adminToken}"`;
  assert.ok(start.includes(authorizationHeader));
  assert.ok(start.includes("http://127.0.0.1:8445/health"));
  assert.ok((commands.probe[3] ?? "").includes(authorizationHeader));
  assert.ok((commands.probe[3] ?? "").includes("http://127.0.0.1:8445/health"));
  assert.ok((commands.requests[3] ?? "").includes(authorizationHeader));
  assert.ok((commands.requests[3] ?? "").includes("http://127.0.0.1:8445/requests"));
  const installRoot = commands.installRoot[3] ?? "";
  const removeRoot = commands.removeRoot[3] ?? "";
  assert.ok(installRoot.includes("install"));
  assert.ok(removeRoot.includes("remove"));
  for (const command of [installRoot, removeRoot]) {
    assert.ok(command.includes("node_path=$(command -v node)"));
    assert.ok(command.includes('test -n "$node_path"'));
    assert.ok(command.includes('/usr/bin/sudo -n "$node_path"'));
    assert.ok(!command.includes("/usr/bin/sudo -n '/usr/bin/env' 'node'"));
  }
  for (const command of [commands.start, commands.probe, commands.requests, commands.stop]) {
    assert.ok(!command[3]?.includes("sudo -n"));
  }
  const stop = commands.stop[3] ?? "";
  for (const command of [installRoot, removeRoot, stop]) {
    assert.ok(!command.includes("ENTERPRISE_TLS_ADMIN_TOKEN"));
    assert.ok(!command.includes("Authorization: Bearer"));
    assert.ok(!command.includes(adminToken));
  }
  assert.ok(stop.includes("stop"));
  assert.ok(stop.includes("&& /usr/bin/rm -rf"));
  assert.ok(stop.indexOf("stop") < stop.indexOf("/usr/bin/rm -rf"));
  assert.ok(stop.includes(runtimeRoot));
});

test("enterprise TLS edge commands reject steering and port collisions", () => {
  assert.throws(
    () => enterpriseTlsEdgeDaytonaCommands({ sandboxId: "sandbox", upstream: "https://den.example.test/path" }),
    /HTTP\(S\) origin/,
  );
  assert.throws(
    () => enterpriseTlsEdgeDaytonaCommands({ sandboxId: "sandbox", upstream: "https://den.example.test", adminPort: 8443 }),
    /must be distinct/,
  );
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
