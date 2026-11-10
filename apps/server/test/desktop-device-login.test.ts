import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const secret = "synthetic-den-bearer-must-not-print";
const deviceCode = "synthetic-private-device-code-must-not-print";
const bridgeToken = "synthetic-local-bridge-token-must-not-print";

async function fixture(options: {
  terminal?: string; unavailable?: boolean; unsafe?: boolean; nonlocal?: boolean;
  dropStart?: boolean; interruptAt?: "preflight" | "status"; historicalUnsupported?: boolean;
} = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "desktop-device-login-")));
  await chmod(directory, options.unsafe ? 0o777 : 0o700);
  const calls: string[] = [];
  const inputs: unknown[] = [];
  let started = false;
  let interruptChild: (() => void) | undefined;
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${bridgeToken}`);
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
      result = { userCode: "TEST-CODE", verificationUri: "https://den.example.test/device", expiresAt: Date.now() + 60_000, token: secret, deviceCode };
    } else if (input.id === "auth.device-login.cancel") result = {};
    else result = { state: started ? options.terminal ?? "signed_in" : options.historicalUnsupported ? "unsupported" : "pending", email: "person@example.test", org: { id: "org-b", name: "Organization B" }, runner: "unknown", token: secret, deviceCode };
    if (input.id === "auth.device-login.status" && options.interruptAt === (started ? "status" : "preflight")) {
      interruptChild?.();
      await delay(50);
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(options.unavailable ? { ok: false, code: "unavailable", error: secret } : { ok: true, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const discovery = join(directory, "openwork-ui-control.json");
  await writeFile(discovery, JSON.stringify({ baseUrl: options.nonlocal ? "https://example.test" : `http://127.0.0.1:${address.port}`, token: bridgeToken }), { mode: 0o600 });
  return {
    calls, inputs,
    async run(argv: string[] = []) {
      const child = spawn(process.execPath, [join(import.meta.dirname, "../bin/openwork-server.mjs"), "login", ...argv], {
        env: { ...process.env, NODE_OPTIONS: "--conditions=development", OPENWORK_UI_CONTROL_DISCOVERY: discovery }, stdio: ["ignore", "pipe", "pipe"], detached: true,
      });
      // A terminal sends Ctrl-C to the foreground process group, including the
      // npm launcher and its runtime child, not just the launcher PID.
      interruptChild = () => { if (child.pid) process.kill(-child.pid, "SIGINT"); };
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (value) => { stdout += value; });
      child.stderr.on("data", (value) => { stderr += value; });
      const code = await new Promise<number | null>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (status, signal) => resolve(status ?? (signal === "SIGINT" ? 130 : null)));
      });
      for (const credential of [secret, deviceCode, bridgeToken]) assert.ok(!`${stdout}${stderr}`.includes(credential), "no private credential in captured command output");
      return { code, stdout, stderr };
    },
    async [Symbol.asyncDispose]() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("shell prints only public code, final identity and existing runner state", async () => {
  await using world = await fixture();
  const result = await world.run();
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Code: TEST-CODE/);
  assert.match(result.stdout, /Signed in as person@example.test in Organization B\. Runner: unknown/);
  assert.deepEqual(world.calls, ["auth.device-login.status", "auth.device-login.start", "auth.device-login.status"]);
});

test("shell forwards an explicit replacement and destination without reading Den credentials", async () => {
  await using world = await fixture();
  assert.equal((await world.run(["--force", "--base-url", "https://den.example.test", "--api-base-url", "https://api.example.test"])).code, 0);
  const start = world.inputs[1];
  assert.ok(start && typeof start === "object" && "args" in start && start.args && typeof start.args === "object" && "requestId" in start.args);
  const requestId = start.args.requestId;
  assert.equal(typeof requestId, "string");
  assert.deepEqual(start, {
    id: "auth.device-login.start",
    args: { requestId, force: true, baseUrl: "https://den.example.test", apiBaseUrl: "https://api.example.test" },
  });
  assert.deepEqual(world.inputs[2], { id: "auth.device-login.status", args: { requestId } });
});

test("a prior unsupported attempt does not prevent a new start", async () => {
  await using world = await fixture({ historicalUnsupported: true });
  assert.equal((await world.run()).code, 0);
  assert.equal(world.calls.filter((id) => id === "auth.device-login.start").length, 1);
});

test("a lost start receipt cancels instead of replaying or leaving a live flow", async () => {
  await using world = await fixture({ dropStart: true });
  assert.equal((await world.run()).code, 1);
  assert.deepEqual(world.calls, ["auth.device-login.status", "auth.device-login.start", "auth.device-login.cancel"]);
  const start = world.inputs[1];
  assert.ok(start && typeof start === "object" && "args" in start);
  assert.deepEqual(world.inputs[2], { id: "auth.device-login.cancel", args: start.args });
});

for (const interruptAt of ["preflight", "status"] satisfies ("preflight" | "status")[]) {
  test(`interrupt during ${interruptAt} cannot start later or report success`, async () => {
    await using world = await fixture({ interruptAt });
    const result = await world.run();
    assert.equal(result.code, 130);
    assert.ok(!result.stdout.includes("Signed in as"));
    if (interruptAt === "preflight") assert.deepEqual(world.calls, ["auth.device-login.status"]);
    else assert.equal(world.calls.at(-1), "auth.device-login.cancel");
  });
}

test("unavailable app never starts login or prints raw errors", async () => {
  await using world = await fixture({ unavailable: true });
  const result = await world.run();
  assert.equal(result.code, 4);
  assert.match(result.stderr, /not available on this server/);
  assert.deepEqual(world.calls, ["auth.device-login.status"]);
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

for (const options of [{ unsafe: true }, { nonlocal: true }]) {
  test(`shell refuses ${options.unsafe ? "unsafe profile custody" : "a non-loopback destination"} before dispatch`, async () => {
    await using world = await fixture(options);
    assert.equal((await world.run()).code, 1);
    assert.deepEqual(world.calls, []);
  });
}
