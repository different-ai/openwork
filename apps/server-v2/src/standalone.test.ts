import { afterEach, expect, test } from "bun:test";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const spawnedChildren: Array<Bun.Subprocess> = [];

afterEach(async () => {
  while (spawnedChildren.length > 0) {
    const child = spawnedChildren.pop();
    if (!child) {
      continue;
    }

    child.kill();
    await child.exited;
  }
});

function getFreePort() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to resolve a test port."));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(port);
      });
    });
    server.once("error", reject);
  });
}

async function waitForHealth(url: string) {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return response;
      }
    } catch {
      // wait for server boot
    }

    await Bun.sleep(100);
  }

  throw new Error(`Timed out waiting for ${url}`);
}

test("cli boots as a standalone process and serves health plus runtime routes", async () => {
  const port = await getFreePort();
  const child = Bun.spawn(["bun", "src/cli.ts", "--port", String(port)], {
    cwd: packageDir,
    env: {
      ...process.env,
      OPENWORK_SERVER_V2_IN_MEMORY: "1",
      OPENWORK_SERVER_V2_RUNTIME_BOOTSTRAP: "disabled",
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  spawnedChildren.push(child);

  const response = await waitForHealth(`http://127.0.0.1:${port}/system/health`);
  const body = await response.json();

  const runtimeSummaryResponse = await waitForHealth(`http://127.0.0.1:${port}/system/runtime/summary`);
  const runtimeSummary = await runtimeSummaryResponse.json();

  const runtimeVersionsResponse = await waitForHealth(`http://127.0.0.1:${port}/system/runtime/versions`);
  const runtimeVersions = await runtimeVersionsResponse.json();

  expect(body.ok).toBe(true);
  expect(body.data.service).toBe("openwork-server-v2");
  expect(runtimeSummary.ok).toBe(true);
  expect(runtimeSummary.data.target).toBeTruthy();
  expect(runtimeVersions.ok).toBe(true);
  expect(runtimeVersions.data.pinned.serverVersion).toBeTruthy();
}, 15_000);
