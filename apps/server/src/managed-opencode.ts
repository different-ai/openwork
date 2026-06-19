import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { randomUUID } from "node:crypto";

export type ManagedOpencodeServer = {
  url: string;
  username: string;
  password: string;
  pid: number | null;
  execution: OpencodeExecutionSnapshot;
  close: () => Promise<void>;
};

export type OpencodeExecutionEnvEntry = {
  name: string;
  value: string;
  redacted: boolean;
};

export type OpencodeExecutionSnapshot = {
  command: string;
  args: string[];
  cwd: string;
  env: OpencodeExecutionEnvEntry[];
};

const SECRET_ENV_PATTERN = /(TOKEN|PASSWORD|USERNAME|AUTH|SECRET|KEY|CREDENTIAL)/i;

function randomSecret(): string {
  return randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
}

async function findFreePortOnce(hostname: string): Promise<number> {
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

async function findFreePort(hostname: string, excludedPorts: number[] = []): Promise<number> {
  const excluded = new Set(
    excludedPorts.filter((port) => Number.isInteger(port) && port > 0 && port <= 65535),
  );
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = await findFreePortOnce(hostname);
    if (!excluded.has(port)) return port;
  }
  throw new Error("Failed to resolve free port outside the excluded set");
}

export async function createManagedOpencodeServer(options: {
  bin?: string;
  cwd: string;
  hostname?: string;
  port?: number;
  excludedPorts?: number[];
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
}): Promise<ManagedOpencodeServer> {
  const hostname = options.hostname ?? "127.0.0.1";
  const port = options.port ?? await findFreePort(hostname, options.excludedPorts);
  const username = randomSecret();
  const password = randomSecret();
  const args = ["serve", "--hostname", hostname, "--port", String(port), "--cors", "*"];
  const command = options.bin?.trim() || "opencode";
  const env = {
    ...process.env,
    ...options.env,
    OPENCODE_SERVER_USERNAME: username,
    OPENCODE_SERVER_PASSWORD: password,
  };
  const injectedEnv = Object.entries({
    ...(options.env ?? {}),
    OPENCODE_SERVER_USERNAME: username,
    OPENCODE_SERVER_PASSWORD: password,
  })
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([name, value]) => ({
      name,
      value: SECRET_ENV_PATTERN.test(name) ? "<redacted>" : value,
      redacted: SECRET_ENV_PATTERN.test(name),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const child: ChildProcess = spawn(options.bin?.trim() || "opencode", args, {
    cwd: options.cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let closePromise: Promise<void> | null = null;
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
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
    execution: {
      command,
      args,
      cwd: options.cwd,
      env: injectedEnv,
    },
    close() {
      closePromise ??= (async () => {
        if (child.exitCode !== null) return;
        if (!child.killed) child.kill("SIGTERM");
        const timeout = new Promise<void>((resolve) => {
          setTimeout(() => resolve(), 1000);
        });
        await Promise.race([exited, timeout]);
        if (child.exitCode === null) {
          try {
            child.kill("SIGKILL");
          } catch {
            // Process already exited.
          }
          await Promise.race([exited, new Promise<void>((resolve) => setTimeout(() => resolve(), 500))]);
        }
      })();
      return closePromise;
    },
  };
}
