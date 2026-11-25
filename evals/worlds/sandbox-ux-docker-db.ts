import { execFile, spawn } from "node:child_process";
import { createServer } from "node:net";
import { promisify } from "node:util";

const exec = promisify(execFile);
const containers = { mysql: "openwork-web-local-mysql", redis: "openwork-web-local-redis" };

/** Use the named local test containers, not a same-port service on the host. */
export async function uxDockerDatabase() {
  const { stdout: password } = await exec("docker", ["exec", containers.mysql, "sh", "-c", 'printf %s "$MYSQL_ROOT_PASSWORD"']).catch(() => { throw new Error("Could not read the Docker test MySQL credential"); });
  if (!password) throw new Error("Docker test MySQL credential missing");
  const stack = new AsyncDisposableStack();
  try {
    async function tunnel(kind: keyof typeof containers, target: number) {
      const children = new Set<ReturnType<typeof spawn>>();
      const listener = createServer(socket => {
        const targetHost = kind === "mysql" ? containers.mysql : "127.0.0.1";
        const child = spawn("docker", ["exec", "-i", containers.redis, "nc", targetHost, String(target)], { stdio: ["pipe", "pipe", "ignore"] });
        children.add(child);
        child.on("error", () => socket.destroy());
        child.stdin.on("error", () => socket.destroy());
        socket.on("error", () => child.stdin.end());
        socket.on("close", () => child.stdin.end());
        child.on("close", () => { children.delete(child); socket.destroy(); });
        socket.pipe(child.stdin);
        child.stdout.pipe(socket);
      });
      await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
      stack.defer(async () => {
        for (const child of children) child.stdin?.end();
        await new Promise<void>(resolve => listener.close(() => resolve()));
      });
      const bound = listener.address();
      if (!bound || typeof bound === "string") throw new Error("Database tunnel did not bind");
      return bound.port;
    }
    const mysql = await tunnel("mysql", 3306);
    const redis = await tunnel("redis", 6379);
    return { mysql: `mysql://root:${encodeURIComponent(password)}@127.0.0.1:${mysql}`, redis: `redis://127.0.0.1:${redis}`, close: () => stack.disposeAsync() };
  } catch (error) {
    await stack.disposeAsync();
    throw error;
  }
}
