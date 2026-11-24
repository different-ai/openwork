import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { allocateFreePorts } from "@openwork/cdp";
import { SkipError } from "@openwork/env";

const command = promisify(execFile);
type Backend = "native" | "docker";

/** The same digest-pinned image as the repository's existing local Den service. */
export async function isolatedRedisImage() {
  const compose = await readFile(new URL("../../packaging/docker/docker-compose.web-local.yml", import.meta.url), "utf8");
  const image = /^\s+image:\s+(redis:\S+@sha256:[a-f0-9]{64})\s*$/m.exec(compose)?.[1];
  if (!image) throw new Error("The local Den service must declare a digest-pinned Redis image");
  return image;
}

/** Check the actual Redis protocol, not just an open port or a startup log. */
export async function isolatedRedisPing(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    let answer = "";
    const done = (ready: boolean) => { socket.destroy(); resolve(ready); };
    socket.setTimeout(1_000);
    socket.once("connect", () => socket.write("*1\r\n$4\r\nPING\r\n"));
    socket.on("data", chunk => {
      answer += chunk.toString();
      if (answer.includes("\r\n")) done(answer === "+PONG\r\n");
      else if (answer.length > 64) done(false);
    });
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
    socket.once("end", () => done(false));
  });
}

async function nativeAvailable() {
  try {
    await command("redis-server", ["--version"], { timeout: 5_000 });
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function stopOwnedProcess(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.once("exit", () => { clearTimeout(timeout); resolve(); });
    child.kill("SIGTERM");
  });
}

/** One non-persistent cache per world. No shared keys, database indexes, volumes or reset commands. */
export async function isolatedRedis(options: { backend?: Backend } = {}) {
  const resources = new AsyncDisposableStack();
  try {
    const backend = options.backend ?? (await nativeAvailable() ? "native" : "docker");
    if (backend === "native" && !await nativeAvailable()) throw new SkipError("install redis-server or start Docker for isolated Redis");
    if (backend === "docker") {
      try { await command("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 10_000 }); }
      catch { throw new SkipError("install redis-server or start Docker for isolated Redis"); }
    }
    const [port] = await allocateFreePorts(1);
    if (!port) throw new Error("No local cache port available");
    let failure: Error | null = null;
    if (backend === "native") {
      const child = spawn("redis-server", ["--bind", "127.0.0.1", "--port", String(port), "--save", "", "--appendonly", "no"], { stdio: "ignore" });
      child.once("error", error => { failure = error; });
      child.once("exit", code => { failure = new Error(`Disposable Redis exited: ${code}`); });
      resources.defer(() => stopOwnedProcess(child));
    } else {
      const name = `openwork-first-run-redis-${process.pid}-${randomUUID()}`;
      // Register first: even a timed-out Docker client may have created this uniquely named container.
      resources.defer(async () => {
        await command("docker", ["rm", "--force", name], { timeout: 15_000 }).catch(error => {
          if (error instanceof Error && "stderr" in error && typeof error.stderr === "string" && error.stderr.includes("No such container")) return;
          throw error;
        });
      });
      await command("docker", ["run", "--detach", "--rm", "--name", name,
        "--label", "openwork.eval.fixture=workbot-first-run", "--publish", `127.0.0.1:${port}:6379`,
        "--read-only", "--tmpfs", "/data:rw,noexec,nosuid,size=16m", await isolatedRedisImage(),
        "redis-server", "--save", "", "--appendonly", "no"], { timeout: 180_000 });
    }
    const deadline = Date.now() + 30_000;
    while (!await isolatedRedisPing(port)) {
      if (failure) throw failure;
      if (Date.now() >= deadline) throw new Error(`Disposable Redis did not answer PING on loopback port ${port}`);
      await delay(100);
    }
    console.info(`[workbot-first-run] isolated Redis ${backend} ready on 127.0.0.1:${port} (PING → PONG)`);
    return {
      backend, port, url: `redis://127.0.0.1:${port}`,
      async [Symbol.asyncDispose]() {
        await resources.disposeAsync();
        if (await isolatedRedisPing(port)) throw new Error(`Disposable Redis is still listening on owned port ${port}`);
        console.info(`[workbot-first-run] isolated Redis ${backend} stopped on 127.0.0.1:${port}`);
      },
    };
  } catch (error) { await resources.disposeAsync(); throw error; }
}
