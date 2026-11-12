import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmod, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const secret = "synthetic-den-bearer-must-not-print";
const deviceCode = "synthetic-private-device-code-must-not-print";
const bridgeToken = "synthetic-local-bridge-token-must-not-print";

async function fixture(options: {
  terminal?: string; unavailable?: boolean; unsafe?: boolean; nonlocal?: boolean;
  missingDiscovery?: boolean; unreachable?: boolean; nodeAdapter?: boolean; userCode?: string; verificationUri?: string;
  verificationUriComplete?: string; email?: string; orgName?: string;
  dropStart?: boolean; interruptAt?: "preflight" | "status"; historicalUnsupported?: boolean;
  discoveryDelay?: number; actionsDelay?: number; missingAction?: "start" | "status";
  hangActions?: boolean; unauthorized?: boolean; symlinkDiscovery?: boolean;
  networkFailureAt?: "start" | "status"; networkHost?: string; explicitOff?: boolean; localUnsupported?: boolean;
  refusedAt?: "start" | "status"; httpStatus?: number; alreadySignedIn?: boolean; genericStartFailure?: boolean;
  interruptAfter?: number; signal?: "SIGINT" | "SIGTERM";
} = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "desktop-device-login-")));
  await chmod(directory, options.unsafe ? 0o777 : 0o700);
  const calls: string[] = [];
  const inputs: unknown[] = [];
  let started = false;
  let actionsCalls = 0;
  let launchedAt = 0;
  let interruptChild: (() => void) | undefined;
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${bridgeToken}`);
    if (request.method === "GET" && request.url === "/actions") {
      actionsCalls++;
      if (options.interruptAt === "preflight") { interruptChild?.(); await delay(50); }
      if (options.hangActions) return;
      response.writeHead(options.unauthorized ? 401 : 200, { "content-type": "application/json" });
      const ready = Date.now() - launchedAt >= (options.actionsDelay ?? 0);
      response.end(JSON.stringify({ ok: ready && !options.unavailable, actions: ready ? ["start", "status"].filter((action) => action !== options.missingAction).map((action) => ({ id: `auth.device-login.${action}` })) : [], error: secret }));
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    const input: unknown = JSON.parse(body);
    assert.ok(input && typeof input === "object" && "id" in input && typeof input.id === "string");
    calls.push(input.id);
    inputs.push(input);
    let result: unknown;
    if (input.id === "auth.device-login.start") {
      started = true;
      if (options.dropStart) { response.destroy(); return; }
      result = { userCode: options.userCode ?? "ABCDEFGH", verificationUri: options.verificationUri ?? "https://den.example.test/device", verificationUriComplete: options.verificationUriComplete, expiresAt: Date.now() + 60_000, token: secret, deviceCode };
    } else if (input.id === "auth.device-login.cancel") result = {};
    else result = { state: started ? options.terminal ?? "signed_in" : options.historicalUnsupported ? "unsupported" : "pending", email: options.email ?? "person@example.test", org: { id: "org-b", name: options.orgName ?? "Organization B" }, token: secret, deviceCode };
    if (input.id === "auth.device-login.status" && options.interruptAt === (started ? "status" : "preflight")) {
      interruptChild?.();
      await delay(50);
    }
    if ((input.id === "auth.device-login.start" && options.networkFailureAt === "start")
      || (input.id === "auth.device-login.status" && options.networkFailureAt === "status")) {
      result = { state: "failed", reason: "den_unreachable", host: options.networkHost ?? "den.example.test", error: secret };
    }
    if ((input.id === "auth.device-login.start" && options.refusedAt === "start")
      || (input.id === "auth.device-login.status" && options.refusedAt === "status")) {
      result = { state: "failed", reason: "den_refused", host: options.networkHost ?? "den.example.test", httpStatus: options.httpStatus ?? 401, error: secret };
    }
    if (input.id === "auth.device-login.start" && options.alreadySignedIn) result = { state: "failed", reason: "already_signed_in", error: secret };
    if (input.id === "auth.device-login.start" && options.explicitOff) result = { state: "unsupported" };
    response.writeHead(200, { "content-type": "application/json" });
    const refusedLocally = input.id === "auth.device-login.start" && (options.localUnsupported || options.genericStartFailure);
    response.end(JSON.stringify(refusedLocally ? { ok: false, code: options.localUnsupported ? "unsupported" : "failed", error: secret } : { ok: true, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const discovery = join(directory, "openwork-ui-control.json");
  const writeDiscovery = async () => {
    const target = options.symlinkDiscovery ? join(directory, "actual-discovery.json") : discovery;
    await writeFile(target, JSON.stringify({ baseUrl: options.nonlocal ? "https://example.test" : `http://127.0.0.1:${address.port}`, token: bridgeToken }), { mode: 0o600 });
    if (options.symlinkDiscovery) await symlink(target, discovery);
  };
  if (!options.missingDiscovery && !options.discoveryDelay) await writeDiscovery();
  if (options.unreachable) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return {
    calls, inputs,
    get actionsCalls() { return actionsCalls; },
    async run(argv: string[] = []) {
      launchedAt = Date.now();
      const delayedDiscovery = options.discoveryDelay ? delay(options.discoveryDelay).then(writeDiscovery) : undefined;
      const moduleUrl = new URL("../src/desktop-device-login.ts", import.meta.url).href;
      const childArgs = options.nodeAdapter
        ? ["--import", "tsx", "--input-type=module", "-e", `import { runDesktopDeviceLogin } from ${JSON.stringify(moduleUrl)}; process.exitCode = await runDesktopDeviceLogin(${JSON.stringify(argv)});`]
        : [join(import.meta.dirname, "../bin/openwork-server.mjs"), "login", ...argv];
      const child = spawn(process.execPath, childArgs, {
        env: { ...process.env, NODE_OPTIONS: "--conditions=development", OPENWORK_UI_CONTROL_DISCOVERY: discovery }, stdio: ["ignore", "pipe", "pipe"], detached: true,
      });
      // A terminal sends Ctrl-C to the foreground process group, including the
      // npm launcher and its runtime child, not just the launcher PID.
      interruptChild = () => { if (child.pid) process.kill(-child.pid, options.signal ?? "SIGINT"); };
      const earlyInterrupt = options.interruptAfter ? setTimeout(() => interruptChild?.(), options.interruptAfter) : undefined;
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (value) => { stdout += value; });
      child.stderr.on("data", (value) => { stderr += value; });
      const code = await new Promise<number | null>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (status, signal) => resolve(status ?? (signal === "SIGINT" ? 130 : null)));
      });
      clearTimeout(earlyInterrupt);
      await delayedDiscovery;
      for (const credential of [secret, deviceCode, bridgeToken, directory]) assert.ok(!`${stdout}${stderr}`.includes(credential), "no private credential or profile path in captured command output");
      assert.ok(!`${stdout}${stderr}`.includes("Runner:"), "no unobserved runner claim in command output");
      return { code, stdout, stderr };
    },
    async [Symbol.asyncDispose]() {
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("shell prints browser instructions, formatted public code and only final identity", async () => {
  await using world = await fixture();
  const result = await world.run();
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, [
    "To sign in, open this link in a browser on any device:",
    "https://den.example.test/device",
    "Then check the code ABCD-EFGH and choose the organization.",
    "Waiting for approval…",
    "Signed in as person@example.test in Organization B.",
    "",
  ].join("\n"));
  assert.deepEqual(world.calls, ["auth.device-login.start", "auth.device-login.status"]);
});

test("Node adapter uses the same authenticated bridge, instructions and final identity", async () => {
  await using world = await fixture({ nodeAdapter: true });
  const result = await world.run();
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /\nhttps:\/\/den\.example\.test\/device\n/);
  assert.match(result.stdout, /Then check the code ABCD-EFGH and choose the organization\./);
  assert.match(result.stdout, /Signed in as person@example.test in Organization B\.\n$/);
  assert.deepEqual(world.calls, ["auth.device-login.start", "auth.device-login.status"]);
});

test("shell formats the code like approval UI and strips terminal control characters from identity", async () => {
  await using world = await fixture({
    userCode: "ab\tcd-ef\rgh", email: "person\r\n@example.test", orgName: "Organization\u0000 B\u009b",
    verificationUriComplete: "https://den.example.test/device?user_code=ABCDEFGH",
  });
  const result = await world.run();
  assert.equal(result.code, 0);
  assert.match(result.stdout, /\nhttps:\/\/den\.example\.test\/device\?user_code=ABCDEFGH\n/);
  assert.match(result.stdout, /Then check the code ABCD-EFGH and choose the organization\./);
  assert.match(result.stdout, /Signed in as person@example.test in Organization B\.\n$/);
  assert.doesNotMatch(result.stdout, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
});

for (const verificationUri of ["file:///device", "javascript:alert(1)", "https://person:secret@example.test/device", "https://den.example.test/\ndevice"]) {
  test(`shell refuses an unsafe approval URL without printing it: ${new URL(verificationUri).protocol}`, async () => {
    await using world = await fixture({ verificationUri });
    const result = await world.run();
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^Device sign-in failed\./);
    assert.equal(world.calls.at(-1), "auth.device-login.cancel");
  });
}

test("shell refuses a malformed public code before showing browser instructions", async () => {
  await using world = await fixture({ userCode: "not-a-device-code" });
  const result = await world.run();
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.equal(world.calls.at(-1), "auth.device-login.cancel");
});

for (const options of [{ missingDiscovery: true }, { unreachable: true }]) {
  test(`shell gives actionable startup advice for ${options.missingDiscovery ? "missing discovery" : "an unreachable app"}`, async () => {
    await using world = await fixture(options);
    const result = await world.run();
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Cannot reach the local OpenWork app\. Start OpenWork/);
    if (process.platform === "darwin") assert.match(result.stderr, /open -a OpenWork/);
    assert.match(result.stderr, /run this command again/);
    assert.doesNotMatch(result.stderr, /unsafe|owner-only/);
    assert.deepEqual(world.calls, []);
  });
}

test("shell forwards an explicit replacement and destination without reading Den credentials", async () => {
  await using world = await fixture();
  assert.equal((await world.run(["--force", "--base-url", "https://den.example.test", "--api-base-url", "https://api.example.test"])).code, 0);
  const start = world.inputs[0];
  assert.ok(start && typeof start === "object" && "args" in start && start.args && typeof start.args === "object" && "requestId" in start.args);
  const requestId = start.args.requestId;
  assert.equal(typeof requestId, "string");
  assert.deepEqual(start, {
    id: "auth.device-login.start",
    args: { requestId, force: true, baseUrl: "https://den.example.test", apiBaseUrl: "https://api.example.test" },
  });
  assert.deepEqual(world.inputs[1], { id: "auth.device-login.status", args: { requestId } });
});

test("a prior unsupported attempt does not prevent a new start", async () => {
  await using world = await fixture({ historicalUnsupported: true });
  assert.equal((await world.run()).code, 0);
  assert.equal(world.calls.filter((id) => id === "auth.device-login.start").length, 1);
});

test("a lost start receipt cancels instead of replaying or leaving a live flow", async () => {
  await using world = await fixture({ dropStart: true });
  assert.equal((await world.run()).code, 1);
  assert.deepEqual(world.calls, ["auth.device-login.start", "auth.device-login.cancel"]);
  const start = world.inputs[0];
  assert.ok(start && typeof start === "object" && "args" in start);
  assert.deepEqual(world.inputs[1], { id: "auth.device-login.cancel", args: start.args });
});

for (const interruptAt of ["preflight", "status"] satisfies ("preflight" | "status")[]) {
  test(`interrupt during ${interruptAt} cannot start later or report success`, async () => {
    await using world = await fixture({ interruptAt });
    const result = await world.run();
    assert.equal(result.code, 130);
    assert.ok(!result.stdout.includes("Signed in as"));
    if (interruptAt === "preflight") assert.deepEqual(world.calls, []);
    else assert.equal(world.calls.at(-1), "auth.device-login.cancel");
  });
}

test("unavailable actions expire with update advice, not Den unsupported", async () => {
  await using world = await fixture({ unavailable: true });
  const began = Date.now();
  const result = await world.run();
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Start or update OpenWork/);
  assert.doesNotMatch(result.stderr, /not available on this server/);
  assert.ok(Date.now() - began >= 19_000);
  assert.ok(Date.now() - began < 25_000);
  assert.deepEqual(world.calls, []);
});

for (const { terminal, code } of [
  { terminal: "denied", code: 2 }, { terminal: "expired", code: 3 },
  { terminal: "unsupported", code: 4 }, { terminal: "failed", code: 1 },
]) {
  test(`shell terminates and discards a ${terminal} flow`, async () => {
    await using world = await fixture({ terminal });
    const result = await world.run();
    assert.equal(result.code, code);
    assert.equal(world.calls.at(-1), "auth.device-login.cancel");
    assert.ok(!result.stdout.includes("Signed in as"));
  });
}

for (const options of [{ discoveryDelay: 1_500 }, { actionsDelay: 1_500 }]) {
  test(`startup waits silently for ${options.discoveryDelay ? "discovery" : "both actions"}, then starts once`, async () => {
    await using world = await fixture(options);
    const result = await world.run();
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.doesNotMatch(result.stdout, /Waiting for OpenWork/);
    assert.equal(world.calls.filter((id) => id === "auth.device-login.start").length, 1);
    if (options.actionsDelay) assert.ok(world.actionsCalls > 1);
  });
}

for (const missingAction of ["start", "status"] satisfies ("start" | "status")[]) {
  test(`registration without ${missingAction} cannot dispatch sign-in`, async () => {
    await using world = await fixture({ missingAction });
    const result = await world.run();
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Start or update OpenWork/);
    assert.deepEqual(world.calls, []);
  });
}

test("a hanging authenticated actions read stays within the overall readiness deadline", async () => {
  await using world = await fixture({ hangActions: true });
  const began = Date.now();
  const result = await world.run();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Start OpenWork|Start or update OpenWork/);
  assert.ok(Date.now() - began >= 19_000);
  assert.ok(Date.now() - began < 25_000);
  assert.deepEqual(world.calls, []);
});

test("local bridge authorization failure is immediate, never readiness or unsupported", async () => {
  await using world = await fixture({ unauthorized: true });
  const began = Date.now();
  const result = await world.run();
  assert.equal(result.code, 1);
  assert.ok(Date.now() - began < 5_000);
  assert.match(result.stderr, /refused local bridge authorization/);
  assert.equal(world.actionsCalls, 1);
  assert.deepEqual(world.calls, []);
});

test("only explicit Den unsupported returns exit 4 without browser instructions", async () => {
  await using world = await fixture({ explicitOff: true });
  const result = await world.run();
  assert.equal(result.code, 4);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /not available on this server/);
  assert.equal(world.calls.filter((id) => id === "auth.device-login.start").length, 1);
});

test("only the actual signed-in conflict suggests force", async () => {
  await using world = await fixture({ alreadySignedIn: true });
  const result = await world.run();
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "OpenWork is already signed in. Use --force to replace that sign-in.\n");
  assert.deepEqual(world.calls, ["auth.device-login.start"]);
});

test("a generic start failure never guesses that the app is signed in", async () => {
  await using world = await fixture({ genericStartFailure: true });
  const result = await world.run();
  assert.equal(result.code, 1);
  assert.equal(result.stderr, "Device sign-in could not start. Check the OpenWork app and try again.\n");
  assert.doesNotMatch(result.stderr, /force|already signed/i);
});

for (const refusedAt of ["start", "status"] satisfies Array<"start" | "status">) {
  for (const httpStatus of [401, 403, 404, 422]) {
    test(`Den HTTP ${httpStatus} refusal during ${refusedAt} is not a force hint or flag OFF`, async () => {
      await using world = await fixture({ refusedAt, httpStatus });
      const result = await world.run();
      assert.equal(result.code, 1);
      assert.equal(result.stderr, `den.example.test refused the request (HTTP ${httpStatus}). Check the server address or try again later.\n`);
      assert.doesNotMatch(result.stderr, /force|not available|already signed|Bearer|https?:/i);
      if (refusedAt === "start") assert.equal(result.stdout, "");
    });
  }
}

test("local unsupported receipt is not Den OFF and does not replay start", async () => {
  await using world = await fixture({ localUnsupported: true });
  const result = await world.run();
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Start or update OpenWork/);
  assert.deepEqual(world.calls, ["auth.device-login.start"]);
});

for (const networkFailureAt of ["start", "status"] satisfies ("start" | "status")[]) {
  test(`structured ${networkFailureAt} network failure prints only the validated Den host`, async () => {
    await using world = await fixture({ networkFailureAt });
    const result = await world.run();
    assert.equal(result.code, 1);
    assert.equal(result.stderr, "Couldn't reach den.example.test. Check the network and try again.\n");
    assert.equal(world.calls.at(-1), "auth.device-login.cancel");
    if (networkFailureAt === "start") assert.equal(result.stdout, "");
  });
}

for (const networkHost of ["[::1]:8788", "127.0.0.1:443", "den.example.test:80"]) {
  test(`network failure accepts the host-only destination ${networkHost}`, async () => {
    await using world = await fixture({ networkFailureAt: "start", networkHost });
    const result = await world.run();
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, `Couldn't reach ${networkHost}. Check the network and try again.\n`);
  });
}

for (const signal of ["SIGINT", "SIGTERM"] satisfies ("SIGINT" | "SIGTERM")[]) {
  test(`${signal} during missing discovery exits 130 before any start`, async () => {
    await using world = await fixture({ missingDiscovery: true, nodeAdapter: true, interruptAfter: 500, signal });
    const result = await world.run();
    assert.equal(result.code, 130);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "Device sign-in cancelled.\n");
    assert.equal(world.actionsCalls, 0);
    assert.deepEqual(world.calls, []);
  });
}

for (const networkHost of ["https://den.example.test/path?token=private", "person:secret@den.example.test", "den.example.test\nsecret", "den.example.test/path"]) {
  test("network failure cannot reflect an unsafe host", async () => {
    await using world = await fixture({ networkFailureAt: "start", networkHost });
    const result = await world.run();
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "Device sign-in failed. Try again or use the sign-in link instead.\n");
  });
}

test("server CLI advertises login and rejects unknown commands without starting a server", async () => {
  async function command(args: string[]) {
    const child = spawn(process.execPath, [join(import.meta.dirname, "../bin/openwork-server.mjs"), ...args], {
      env: { ...process.env, NODE_OPTIONS: "--conditions=development" }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (value) => { stdout += value; });
    child.stderr.on("data", (value) => { stderr += value; });
    const code = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    return { code, stdout, stderr };
  }
  const help = await command(["login", "--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /openwork-server login/);
  const unknown = await command(["not-a-command"]);
  assert.equal(unknown.code, 1);
  assert.equal(unknown.stdout, "");
  assert.match(unknown.stderr, /Unknown command/);
});

test("Windows fails closed with the sign-in link, before discovery or network access", async () => {
  const moduleUrl = new URL("../src/desktop-device-login.ts", import.meta.url).href;
  const source = `import { runDesktopDeviceLogin } from ${JSON.stringify(moduleUrl)};
    Object.defineProperty(process, "platform", { value: "win32" });
    globalThis.fetch = () => { throw new Error("Windows must not contact a bridge or Den"); };
    process.exitCode = await runDesktopDeviceLogin([]);`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (value) => { stdout += value; });
  child.stderr.on("data", (value) => { stderr += value; });
  const code = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  assert.equal(code, 4);
  assert.equal(stdout, "");
  assert.match(stderr, /not available on Windows\. Use the sign-in link instead\./);
});

for (const options of [{ unsafe: true }, { nonlocal: true }, { symlinkDiscovery: true }]) {
  test(`shell refuses ${options.unsafe ? "unsafe profile custody" : "a non-loopback destination"} before dispatch`, async () => {
    await using world = await fixture(options);
    const began = Date.now();
    const result = await world.run();
    assert.ok(Date.now() - began < 5_000, "unsafe discovery fails immediately");
    assert.equal(result.code, 1);
    assert.match(result.stderr, /cannot safely use this desktop profile/);
    assert.match(result.stderr, /owner-only/);
    assert.doesNotMatch(result.stderr, /Cannot reach|Start OpenWork|open -a/);
    assert.deepEqual(world.calls, []);
  });
}
