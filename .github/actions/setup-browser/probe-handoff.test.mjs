import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { get } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { probeHandoff } from "./probe-handoff.mjs";

function request(url) {
  return new Promise((resolve, reject) => {
    get(url, { agent: false }, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => resolve(body));
      response.on("error", reject);
    }).on("error", reject);
  });
}

async function assertServerClosed(url) {
  await assert.rejects(request(url), { code: "ECONNREFUSED" });
}

test("a real local HTTP receipt succeeds and the detached browser process is terminated", { timeout: 10_000 }, async t => {
  let url;
  let closed;
  await probeHandoff({
    timeoutMs: 5_000,
    spawnBrowser(command, args, options) {
      assert.equal(command, "xdg-open");
      assert.equal(args.length, 1);
      [url] = args;
      assert.equal(new URL(url).pathname, "/browser-hop-proof");
      assert.equal(options.detached, true);
      assert.equal(options.stdio, "inherit");
      assert.equal(options.env.OPENWORK_PROOF_BROWSER_PROFILE, `${process.env.RUNNER_TEMP}/pr-proof-browser-gate`);
      const child = spawn(process.execPath, ["--input-type=module", "-e", `
        import { get } from 'node:http';
        setInterval(() => {}, 1000);
        get(process.argv[1], response => response.resume());
      `, url], { ...options, stdio: "ignore" });
      closed = once(child, "close");
      t.after(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      });
      return child;
    },
  });
  assert.deepEqual(await closed, [null, "SIGTERM"]);
  await assertServerClosed(url);
});

test("a wrong-path HTTP receipt and successful launcher exit still time out and clean up", async () => {
  const child = new EventEmitter();
  child.pid = 12345;
  const kills = [];
  let url;
  let response;
  await assert.rejects(probeHandoff({
    timeoutMs: 500,
    spawnBrowser(command, [target]) {
      url = target;
      response = request(new URL("/wrong-path", url)).then(body => {
        child.emit("exit", 0);
        return body;
      });
      return child;
    },
    kill: (...args) => kills.push(args),
  }), /Timed out/);
  assert.equal(await response, "OAuth browser handoff ready");
  assert.deepEqual(kills, [[-12345, "SIGTERM"]]);
  await assertServerClosed(url);
});

test("exit zero without navigation is not success; an already-gone process group is harmless", async () => {
  const child = new EventEmitter();
  child.pid = 12345;
  let url;
  await assert.rejects(probeHandoff({
    timeoutMs: 20,
    spawnBrowser(command, [target]) {
      url = target;
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    },
    kill(pid, signal) {
      assert.equal(pid, -12345);
      assert.equal(signal, "SIGTERM");
      throw Object.assign(new Error("Process group already gone"), { code: "ESRCH" });
    },
  }), /Timed out/);
  await assertServerClosed(url);
});

test("asynchronous spawn errors fail and close the server without killing a missing pid", async () => {
  let url;
  await assert.rejects(probeHandoff({
    spawnBrowser(command, [target], options) {
      url = target;
      return spawn(fileURLToPath(new URL("./missing-browser", import.meta.url)), [], options);
    },
    kill: () => assert.fail("No process was spawned"),
  }), { code: "ENOENT" });
  await assertServerClosed(url);
});

test("synchronous spawn errors also close the server and clear the timeout", async () => {
  const error = new Error("Spawn failed synchronously");
  let url;
  await assert.rejects(probeHandoff({
    spawnBrowser(command, [target]) {
      url = target;
      throw error;
    },
    kill: () => assert.fail("No process was spawned"),
  }), thrown => thrown === error);
  await assertServerClosed(url);
});

test("unexpected process cleanup errors fail even after navigation and still close the server", async () => {
  const child = new EventEmitter();
  child.pid = 12345;
  const error = Object.assign(new Error("Cannot terminate browser"), { code: "EPERM" });
  let url;
  let response;
  await assert.rejects(probeHandoff({
    spawnBrowser(command, [target]) {
      url = target;
      response = request(url);
      return child;
    },
    kill: () => { throw error; },
  }), thrown => thrown === error);
  assert.equal(await response, "OAuth browser handoff ready");
  await assertServerClosed(url);
});

test("the standalone entrypoint reports failure and exits nonzero when xdg-open cannot spawn", async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./probe-handoff.mjs", import.meta.url))], {
    env: { ...process.env, PATH: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  assert.deepEqual(await once(child, "close"), [1, null]);
  assert.equal(stdout, "");
  assert.match(stderr, /::error::xdg-open did not navigate to the local OAuth browser probe/);
  assert.match(stderr, /ENOENT/);
});
