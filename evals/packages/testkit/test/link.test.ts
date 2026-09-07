import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";
import { daytonaLinkCommands, denLink, MAX_LINK_DAYTONA_COMMAND_LENGTH } from "../src/link.ts";
import type { Server } from "node:http";
import type { DaytonaExec } from "@openwork/hosts";

const LARGE_BODY = Buffer.alloc(192 * 1024, 97);
const ADMIN_TOKEN = "a".repeat(64);

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "object" && address !== null) resolve(address.port);
      else reject(new Error("Upstream test server did not expose a port."));
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

function timedFetch(url: string, timeoutMs = 5_000): Promise<Response> {
  return fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
}

function absoluteGet(proxyUrl: string, target: string): Promise<string> {
  const proxy = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: proxy.hostname, port: proxy.port, path: target }, (response) => {
      response.setEncoding("utf8");
      let body = "";
      response.on("data", (chunk: string) => body += chunk);
      response.on("end", () => resolve(body));
    });
    request.on("error", reject);
    request.end();
  });
}

test("Daytona link commands upload the runner-side script before launching its temp path", () => {
  const source = Buffer.alloc(32 * 1024, 97);
  const commands = daytonaLinkCommands(source, "https://den.example.test", 3985, 3986, ADMIN_TOKEN);
  assert(commands.cleanup.includes("pid=$(</tmp/openwork-den-link-server.pid)"));
  assert(commands.cleanup.includes('kill "$pid"'));
  assert(commands.cleanup.includes("rm -f /tmp/openwork-den-link-server.pid /tmp/openwork-den-link-server.mjs /tmp/openwork-den-link-server.mjs.b64"));
  assert(!commands.cleanup.includes("pkill"));
  assert.equal(commands.upload[0], ": > /tmp/openwork-den-link-server.mjs.b64");
  const chunkPattern = /^printf %s ([A-Za-z0-9+/=]+) >> \/tmp\/openwork-den-link-server\.mjs\.b64$/;
  const chunks = commands.upload.slice(1, -1).map((command) => {
    const match = chunkPattern.exec(command);
    assert(match);
    assert(match[1].length <= 8 * 1024);
    return match[1];
  });
  assert.equal(chunks.join(""), source.toString("base64"));
  const finalize = commands.upload.at(-1);
  assert(finalize?.includes("base64 -d /tmp/openwork-den-link-server.mjs.b64 > /tmp/openwork-den-link-server.mjs"));
  assert(finalize?.includes("actual_bytes=$(wc -c < /tmp/openwork-den-link-server.mjs)"));
  assert(finalize?.includes("rm -f /tmp/openwork-den-link-server.mjs.b64"));
  assert(finalize?.includes(`test \"$actual_bytes\" -eq ${source.byteLength}`));
  const commandLengths = [commands.cleanup, ...commands.upload, commands.detach]
    .map((command) => ["exec", "desktop-sandbox", "--", `bash -lc '${command}'`].join(" ").length);
  assert(Math.max(...commandLengths) <= MAX_LINK_DAYTONA_COMMAND_LENGTH);
  assert(commands.detach.includes('"node", "/tmp/openwork-den-link-server.mjs"'));
  assert(commands.detach.includes("pid_file.write(str(process.pid)"));
  assert(commands.detach.includes('os.replace(temporary_pid, "/tmp/openwork-den-link-server.pid")'));
  assert(commands.detach.includes(`env={**os.environ, "LINK_ADMIN_TOKEN": "${ADMIN_TOKEN}"}`));
  const launch = commands.detach.split("\n").find((line) => line.startsWith("process = subprocess.Popen"));
  assert(launch);
  assert(!launch.slice(0, launch.indexOf("], stdin=")).includes(ADMIN_TOKEN));
  assert(!commands.detach.includes("/workspace/evals"));
  assert.throws(
    () => daytonaLinkCommands(source, "https://den.example.test", 3985, 3986, "not-hex"),
    /at least 32 lowercase hex characters/,
  );
});

test("denLink separates a sandbox loopback client from public admin control and defaults to public previews", async () => {
  const calls: string[][] = [];
  const exec: DaytonaExec = async (args) => {
    calls.push(args);
    const previewPort = args[0] === "preview-url" ? args.at(-1) : undefined;
    return {
      stdout: previewPort === "3985"
        ? "https://data-preview.example.test\n"
        : previewPort === "3986" ? "https://admin-preview.example.test\n" : "",
      stderr: "",
      code: 0,
    };
  };
  const originalFetch = globalThis.fetch;
  const fetched: Array<{ url: string; authorization: string | null }> = [];
  globalThis.fetch = async (input, init) => {
    fetched.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
    return new Response(JSON.stringify({ ok: true, phase: "default", offline: false }), {
      headers: { "content-type": "application/json" },
    });
  };
  try {
    {
      await using link = await denLink(
        { apiUrl: "https://den.example.test/api/den", webUrl: "https://den.example.test" },
        { sandboxId: "desktop-sandbox", client: "sandbox-loopback", daytonaExec: exec },
      );
      assert.deepEqual(link.ref, {
        apiUrl: "http://127.0.0.1:3985/api/den",
        webUrl: "http://127.0.0.1:3985",
      });
      assert(calls.some((args) => args[0] === "exec" && args.at(-1)?.includes("http://127.0.0.1:3986/health")));
      assert.deepEqual(
        calls.filter((args) => args[0] === "preview-url").map((args) => args.at(-1)),
        ["3986"],
      );
      assert.equal(fetched.length, 1);
      assert.equal(fetched[0]?.url, "https://admin-preview.example.test/health");
      assert.match(fetched[0]?.authorization ?? "", /^Bearer [a-f0-9]{64}$/);
      const healthCommand = calls.find((args) => args[0] === "exec" && args.at(-1)?.includes("curl -sf"))?.at(-1);
      assert.match(healthCommand ?? "", /curl -sf -H "Authorization: Bearer [a-f0-9]{64}" http:\/\/127\.0\.0\.1:3986\/health/);
    }

    calls.length = 0;
    fetched.length = 0;
    await using publicLink = await denLink(
      { apiUrl: "https://den.example.test/api/den", webUrl: "https://den.example.test" },
      { sandboxId: "desktop-sandbox", daytonaExec: exec },
    );
    assert.deepEqual(publicLink.ref, {
      apiUrl: "https://data-preview.example.test/api/den",
      webUrl: "https://data-preview.example.test",
    });
    assert.deepEqual(
      calls.filter((args) => args[0] === "preview-url").map((args) => args.at(-1)),
      ["3985", "3986"],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("denLink admin rejects missing and wrong bearer tokens without mutating state", async () => {
  const upstream = createServer((_request, response) => response.end("ok"));
  const port = await listen(upstream);
  const originalFetch = globalThis.fetch;
  let adminHealthUrl = "";
  let authorization = "";
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const header = new Headers(init?.headers).get("authorization");
    if (url.endsWith("/health") && header !== null) {
      adminHealthUrl = url;
      authorization = header;
    }
    return originalFetch(input, init);
  };
  try {
    await using link = await denLink({
      apiUrl: `http://127.0.0.1:${port}/api/den`,
      webUrl: `http://127.0.0.1:${port}`,
    });
    await link.admin.phase("protected");
    assert.match(authorization, /^Bearer [a-f0-9]{64}$/);
    const phaseUrl = adminHealthUrl.replace(/\/health$/, "/phase");
    for (const headers of [
      new Headers({ "content-type": "application/json" }),
      new Headers({ authorization: "Bearer " + "b".repeat(64), "content-type": "application/json" }),
    ]) {
      const denied = await originalFetch(phaseUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "attacker" }),
      });
      assert.equal(denied.status, 401);
      assert.deepEqual(await denied.json(), { error: "Unauthorized" });
    }
    assert.equal((await link.admin.health()).phase, "protected");
  } finally {
    globalThis.fetch = originalFetch;
    await close(upstream);
  }
});

test("denLink shapes a local Den connection and records phases", { timeout: 25_000 }, async () => {
  const upstream = createServer((request, response) => {
    if (request.url === "/large") {
      response.writeHead(200, { "content-length": LARGE_BODY.length, "content-type": "application/octet-stream" });
      response.end(LARGE_BODY);
      return;
    }
    if (request.url === "/stream") {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.write(Buffer.alloc(16 * 1024, 98));
      let writes = 0;
      const timer = setInterval(() => {
        if (writes === 9) {
          clearInterval(timer);
          response.end();
          return;
        }
        writes += 1;
        response.write(Buffer.alloc(16 * 1024, 98));
      }, 200);
      response.once("close", () => clearInterval(timer));
      return;
    }
    response.writeHead(200, { "content-type": "application/json", "x-upstream": "yes" });
    response.end(JSON.stringify({ ok: true, path: request.url }));
  });
  const port = await listen(upstream);
  try {
    await using link = await denLink({
      apiUrl: `http://127.0.0.1:${port}/api/den`,
      webUrl: `http://127.0.0.1:${port}`,
    });

    const passed = await timedFetch(`${link.ref.webUrl}/passthrough`);
    assert.equal(passed.status, 200);
    assert.equal(passed.headers.get("x-upstream"), "yes");
    assert.deepEqual(await passed.json(), { ok: true, path: "/passthrough" });
    let log = await link.admin.requests();
    assert.deepEqual(
      { faulted: log.requests[0]?.faulted, phase: log.requests[0]?.phase },
      { faulted: false, phase: "default" },
    );

    await link.admin.rules([{ kind: "status", pathPrefix: "/status", statusCode: 503, times: 2, body: { error: "unavailable" } }]);
    assert.equal((await timedFetch(`${link.ref.webUrl}/status`)).status, 503);
    assert.equal((await timedFetch(`${link.ref.webUrl}/status`)).status, 503);
    assert.equal((await timedFetch(`${link.ref.webUrl}/status`)).status, 200);
    log = await link.admin.requests();
    assert.deepEqual(log.requests.slice(-3).map(({ faulted, fault }) => ({ faulted, fault })), [
      { faulted: true, fault: "status" },
      { faulted: true, fault: "status" },
      { faulted: false, fault: undefined },
    ]);

    await link.admin.rules([{ kind: "latency", pathPrefix: "/latency", delayMs: 300, jitterMs: 50 }]);
    const latencyStarted = Date.now();
    assert.equal((await timedFetch(`${link.ref.webUrl}/latency`)).status, 200);
    const latencyElapsed = Date.now() - latencyStarted;
    assert(latencyElapsed >= 250, `Expected at least 250ms latency, got ${latencyElapsed}ms.`);
    assert(latencyElapsed <= 1_200, `Expected at most 1200ms latency, got ${latencyElapsed}ms.`);

    await link.admin.rules([{ kind: "reset", pathPrefix: "/reset", everyNth: 2 }]);
    assert.equal((await timedFetch(`${link.ref.webUrl}/reset`)).status, 200);
    await assert.rejects(timedFetch(`${link.ref.webUrl}/reset`));
    assert.equal((await timedFetch(`${link.ref.webUrl}/reset`)).status, 200);
    await assert.rejects(timedFetch(`${link.ref.webUrl}/reset`));

    await link.admin.phase("offline");
    await link.admin.offline(600);
    await assert.rejects(timedFetch(`${link.ref.webUrl}/offline`, 2_000));
    log = await link.admin.requests();
    assert((log.refusedConnections.offline ?? 0) >= 1);
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal((await timedFetch(`${link.ref.webUrl}/restored`)).status, 200);
    assert.equal((await link.admin.health()).offline, false);

    await link.admin.clear();
    const streaming = await timedFetch(`${link.ref.webUrl}/stream`);
    assert(streaming.body);
    const reader = streaming.body.getReader();
    const firstChunk = await reader.read();
    assert.equal(firstChunk.done, false);
    await link.admin.offline(600);
    await assert.rejects(reader.read());
    await new Promise((resolve) => setTimeout(resolve, 700));

    await link.admin.bandwidth(64 * 1024);
    const cappedStarted = Date.now();
    const capped = await timedFetch(`${link.ref.webUrl}/large`, 8_000);
    const cappedBody = Buffer.from(await capped.arrayBuffer());
    const cappedElapsed = Date.now() - cappedStarted;
    assert(cappedElapsed >= 2_500, `Expected capped transfer to take at least 2500ms, got ${cappedElapsed}ms.`);
    assert.deepEqual(cappedBody, LARGE_BODY);
    assert.equal((await link.admin.requests()).requests.at(-1)?.fault, "bandwidth");

    await link.admin.bandwidth(null);
    const fastStarted = Date.now();
    const fast = await timedFetch(`${link.ref.webUrl}/large`);
    assert.deepEqual(Buffer.from(await fast.arrayBuffer()), LARGE_BODY);
    assert(Date.now() - fastStarted < 1_000);

    await link.admin.phase("b");
    assert.equal((await timedFetch(`${link.ref.webUrl}/phase-b`)).status, 200);
    log = await link.admin.requests();
    assert.equal(log.requests.at(-1)?.phase, "b");

    await link.admin.phase("vpn", "vpn-flaky-emulated");
    const vpnStarted = Date.now();
    assert.equal((await timedFetch(`${link.ref.webUrl}/vpn-success-1`)).status, 200);
    const vpnDelay = Date.now() - vpnStarted;
    assert(vpnDelay >= 300, `Expected VPN emulation latency of at least 300ms, got ${vpnDelay}ms.`);
    assert(vpnDelay < 1_500, `Expected bounded VPN emulation latency, got ${vpnDelay}ms.`);
    assert.equal((await timedFetch(`${link.ref.webUrl}/vpn-success-2`)).status, 200);
    await assert.rejects(timedFetch(`${link.ref.webUrl}/vpn-reset`));
    const stats = await link.admin.stats();
    assert.equal(stats.phase, "vpn");
    assert.equal(stats.profile, "vpn-flaky-emulated");
    assert(stats.faults >= 1);
    log = await link.admin.requests();
    assert.deepEqual(log.requests.slice(-3).map(({ fault, profile }) => ({ fault, profile })), [
      { fault: "latency", profile: "vpn-flaky-emulated" },
      { fault: "latency", profile: "vpn-flaky-emulated" },
      { fault: "reset", profile: "vpn-flaky-emulated" },
    ]);
    await link.admin.phase("baseline", "baseline");
    assert.equal((await timedFetch(`${link.ref.webUrl}/baseline-restored`)).status, 200);
    const baselineEntry = (await link.admin.requests()).requests.at(-1);
    assert.deepEqual(
      baselineEntry && { path: baselineEntry.path, faulted: baselineEntry.faulted, phase: baselineEntry.phase, profile: baselineEntry.profile },
      { path: "/baseline-restored", faulted: false, phase: "baseline", profile: "baseline" },
    );

    await link.admin.rules([{ kind: "status", statusCode: 500, times: 10 }]);
    await link.admin.clear();
    assert.equal((await timedFetch(`${link.ref.webUrl}/cleared`)).status, 200);
    assert.equal((await link.admin.health()).offline, false);
  } finally {
    await close(upstream);
  }
});

test("denLink pins absolute-form request targets to its upstream", async () => {
  let attackerRequests = 0;
  let upstreamRequestUrl: string | undefined;
  const upstream = createServer((request, response) => {
    upstreamRequestUrl = request.url;
    response.end("upstream");
  });
  const attacker = createServer((_request, response) => {
    attackerRequests += 1;
    response.end("attacker");
  });
  const [upstreamPort, attackerPort] = await Promise.all([listen(upstream), listen(attacker)]);
  try {
    await using link = await denLink({
      apiUrl: `http://127.0.0.1:${upstreamPort}/api/den`,
      webUrl: `http://127.0.0.1:${upstreamPort}`,
    });
    assert.equal(
      await absoluteGet(link.ref.webUrl, `http://127.0.0.1:${attackerPort}/steered?x=1`),
      "upstream",
    );
    assert.equal(upstreamRequestUrl, "/steered?x=1");
    assert.equal(attackerRequests, 0);
  } finally {
    await Promise.all([close(upstream), close(attacker)]);
  }
});
