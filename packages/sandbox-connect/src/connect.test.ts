import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { connectSandboxCdp, connectSandboxPort, loopbackRelay, SandboxConnectError, sshConfig, type SandboxRoute } from "./index.ts";

/** Stands in for a provider SSH gateway: honours -F/-L like ssh, refuses users starting with "bad". */
const FAKE_SSH = `import { appendFileSync, readFileSync } from "node:fs";
import net from "node:net";
const args = process.argv.slice(2);
if (process.env.FAKE_SSH_ARGV) appendFileSync(process.env.FAKE_SSH_ARGV, JSON.stringify(args) + "\\n");
const user = readFileSync(args[args.indexOf("-F") + 1], "utf8").match(/^\\s*User (\\S+)/m)[1];
if (user.startsWith("bad")) { process.stderr.write(user + "@gateway: Permission denied (none).\\n"); process.exit(255); }
const [, local, host, port] = args[args.indexOf("-L") + 1].split(":");
net.createServer((socket) => {
  const upstream = net.connect(Number(port), host);
  socket.pipe(upstream).pipe(socket);
  upstream.on("error", () => socket.destroy()); socket.on("error", () => upstream.destroy());
}).listen(Number(local), "127.0.0.1");
process.on("SIGTERM", () => process.exit(0));
`;

async function fakeSsh() {
  const dir = await mkdtemp(join(tmpdir(), "fake-ssh-"));
  const script = join(dir, "ssh.mjs");
  await writeFile(script, FAKE_SSH);
  return { command: [process.execPath, script], argv: join(dir, "argv.log") };
}

const CDP_VERSION = JSON.stringify({ Browser: "Chrome/140", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/x" });

async function serve(handler: (req: IncomingMessage) => { status: number; body: string }) {
  const server: Server = createServer((req, res) => { const { status, body } = handler(req); res.writeHead(status, { "content-type": "application/json" }).end(body); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return { port: address.port, async [Symbol.asyncDispose]() { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}

test("a dead route (502 forever) loses to a working one, and every route is released", async () => {
  const ssh = await fakeSsh();
  await using broken = await serve(() => ({ status: 502, body: '{"message":"bad gateway"}' }));
  await using chrome = await serve(() => ({ status: 200, body: CDP_VERSION }));
  const released: string[] = [];
  const route = (label: string, port: number): SandboxRoute => ({ kind: "ssh", label, host: "ssh.example.test", user: `tok-${label}`, target: { port }, release: async () => { released.push(label); } });
  await using connection = await connectSandboxCdp([route("preview", broken.port), route("tunnel", chrome.port)], { ssh: { command: ssh.command }, timeoutMs: 10_000, pauseMs: 50 });
  assert.equal(connection.route.label, "tunnel");
  assert.match(connection.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal((await (await fetch(`${connection.url}/json/version`)).json()).Browser, "Chrome/140");
  assert.deepEqual(released, ["preview"]);
  await connection.close();
  assert.deepEqual(released.sort(), ["preview", "tunnel"]);
});

test("the token-bearing user stays out of argv and error messages", async () => {
  const ssh = await fakeSsh();
  process.env.FAKE_SSH_ARGV = ssh.argv;
  try {
    await using chrome = await serve(() => ({ status: 200, body: CDP_VERSION }));
    const routes: SandboxRoute[] = [{ kind: "ssh", label: "refused", host: "ssh.example.test", user: "bad-secret-token", target: { port: chrome.port } }];
    await assert.rejects(connectSandboxCdp(routes, { ssh: { command: ssh.command }, timeoutMs: 5_000 }), (error: unknown) => {
      assert.ok(error instanceof SandboxConnectError);
      assert.deepEqual(error.outcomes.map((outcome) => [outcome.result, outcome.reason]), [["failed", "auth"]]);
      assert.doesNotMatch(error.message, /secret-token/);
      return true;
    });
    assert.doesNotMatch(await readFile(ssh.argv, "utf8"), /secret-token/);
  } finally { delete process.env.FAKE_SSH_ARGV; }
});

test("access headers are added on this side of the tunnel, never in the URL", async () => {
  const ssh = await fakeSsh();
  await using gateway = await serve((req) => req.headers.cookie === "__Host-openwork-preview=abc" ? { status: 200, body: CDP_VERSION } : { status: 401, body: "{}" });
  const routes: SandboxRoute[] = [{ kind: "ssh", label: "tunnel", host: "ssh.example.test", user: "tok", target: { port: gateway.port }, access: { cookie: "__Host-openwork-preview=abc" } }];
  await using connection = await connectSandboxCdp(routes, { ssh: { command: ssh.command }, timeoutMs: 5_000 });
  assert.doesNotMatch(connection.url, /abc/);
  assert.equal((await fetch(`${connection.url}/json/version`)).status, 200);
});

test("401 stops a route at once instead of waiting out the timeout", async () => {
  const ssh = await fakeSsh();
  await using gateway = await serve(() => ({ status: 401, body: "{}" }));
  const started = Date.now();
  await assert.rejects(connectSandboxCdp([{ kind: "ssh", label: "tunnel", host: "ssh.example.test", user: "tok", target: { port: gateway.port } }], { ssh: { command: ssh.command }, timeoutMs: 20_000 }),
    (error: unknown) => error instanceof SandboxConnectError && error.outcomes[0]?.reason === "rejected");
  assert.ok(Date.now() - started < 10_000);
});

test("routes time out with a safe summary when nothing answers", async () => {
  await using broken = await serve(() => ({ status: 502, body: "{}" }));
  const ssh = await fakeSsh();
  await assert.rejects(connectSandboxPort([{ kind: "ssh", label: "tunnel", host: "ssh.example.test", user: "tok", target: { port: broken.port } }],
    { ssh: { command: ssh.command }, timeoutMs: 1_000, pauseMs: 50, check: async () => "retry" }), /tunnel: timeout/);
});

test("remote HTTPS is required except for this machine's loopback", async () => {
  await assert.rejects(loopbackRelay(new URL("http://sandbox.example.test")), /HTTPS/);
  await (await loopbackRelay(new URL("http://127.0.0.1:9"))) [Symbol.asyncDispose]();
});

test("ssh config refuses values that could inject options", () => {
  const base = { kind: "ssh" as const, label: "x", host: "ssh.app.daytona.io", target: { port: 1 } };
  assert.throws(() => sshConfig({ ...base, user: "tok\n  ProxyCommand evil" }, "/tmp/k"), /Invalid SSH user/);
  assert.throws(() => sshConfig({ ...base, user: "tok", host: "a b" }, "/tmp/k"), /Invalid SSH host/);
  assert.match(sshConfig({ ...base, user: "vm+root:tok" }, "/tmp/k"), /User vm\+root:tok/);
});
