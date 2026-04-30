import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { randomUUID } from "node:crypto";

export type ManagedOpencodeServer = {
  url: string;
  username: string;
  password: string;
  pid: number | null;
  close: () => void;
};

function randomSecret(): string {
  return randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
}

async function findFreePort(hostname: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, hostname, () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("Failed to resolve free port"));
      });
    });
  });
}

export async function createManagedOpencodeServer(options: {
  bin?: string;
  cwd: string;
  hostname?: string;
  port?: number;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
}): Promise<ManagedOpencodeServer> {
  const hostname = options.hostname ?? "127.0.0.1";
  const port = options.port ?? await findFreePort(hostname);
  const username = randomSecret();
  const password = randomSecret();
  const args = ["serve", "--hostname", hostname, "--port", String(port), "--cors", "*"];
  const child: ChildProcess = spawn(options.bin?.trim() || "opencode", args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...options.env,
      OPENCODE_SERVER_USERNAME: username,
      OPENCODE_SERVER_PASSWORD: password,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const url = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timeout waiting for OpenCode server after ${options.timeoutMs ?? 15000}ms`)), options.timeoutMs ?? 15000);
    let output = "";
    const done = (value: string) => {
      clearTimeout(timeout);
      resolve(value);
    };
    const fail = (error: Error) => {
      clearTimeout(timeout);
      reject(error);
    };
    child.stdout?.on("data", (chunk) => {
      output += chunk.toString();
      for (const line of output.split("\n")) {
        if (!line.startsWith("opencode server listening")) continue;
        const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
        if (!match?.[1]) return fail(new Error(`Failed to parse OpenCode server URL from: ${line}`));
        done(match[1]);
      }
    });
    child.stderr?.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.once("error", fail);
    child.once("exit", (code) => fail(new Error(`OpenCode server exited with code ${code}${output.trim() ? `\n${output}` : ""}`)));
  });

  return {
    url,
    username,
    password,
    pid: child.pid ?? null,
    close() {
      if (!child.killed) child.kill();
    },
  };
}
