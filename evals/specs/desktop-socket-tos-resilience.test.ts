import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

import { test } from "@openwork/testkit";
import { expect } from "vitest";

const execFileAsync = promisify(execFile);

function parseRuntimeObservation(output: string): number {
  const observation = output.trim().match(
    /(?:^|\r?\n)\{"status":200,"body":"ok","injectedCalls":([1-9]\d*),"unrelatedCode":"EACCES"\}$/,
  );
  if (!observation) throw new Error(`Unexpected Electron runtime observation: ${output}`);
  return Number(observation[1]);
}

test("the embedded Electron runtime contains only the known socket Type-of-Service failure", async ({ evidence }) => {
  const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
  const desktopDirectory = path.join(repositoryRoot, "apps", "desktop");
  const resilienceModuleUrl = pathToFileURL(
    path.join(desktopDirectory, "electron", "process-resilience.mjs"),
  ).href;
  const pnpmBinary = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const childScript = `
    const http = require("node:http");
    const net = require("node:net");

    (async () => {
      const { installSocketTypeOfServiceGuard } = await import(${JSON.stringify(resilienceModuleUrl)});
      const original = net.Socket.prototype.setTypeOfService;
      let injectedCalls = 0;
      const server = http.createServer((_request, response) => response.end("ok"));
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

      try {
        net.Socket.prototype.setTypeOfService = function injectedInvalidTypeOfService() {
          injectedCalls += 1;
          throw Object.assign(new Error("setTypeOfService EINVAL"), {
            code: "EINVAL",
            syscall: "setTypeOfService",
          });
        };
        installSocketTypeOfServiceGuard({ warn: () => undefined });

        const address = server.address();
        const response = await fetch("http://127.0.0.1:" + address.port);
        const body = await response.text();

        net.Socket.prototype.setTypeOfService = function injectedUnrelatedFailure() {
          throw Object.assign(new Error("setTypeOfService EACCES"), {
            code: "EACCES",
            syscall: "setTypeOfService",
          });
        };
        installSocketTypeOfServiceGuard({ warn: () => undefined });
        let unrelatedCode = null;
        try {
          new net.Socket().setTypeOfService(0);
        } catch (error) {
          unrelatedCode = error.code;
        }

        process.stdout.write(JSON.stringify({
          status: response.status,
          body,
          injectedCalls,
          unrelatedCode,
        }));
      } finally {
        net.Socket.prototype.setTypeOfService = original;
        await new Promise((resolve) => server.close(resolve));
      }
    })().catch((error) => {
      process.stderr.write(error && error.stack ? error.stack : String(error));
      process.exitCode = 1;
    });
  `;

  const { stdout } = await execFileAsync(
    pnpmBinary,
    ["--dir", desktopDirectory, "exec", "electron", "--eval", childScript],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      timeout: 30_000,
    },
  );
  expect(parseRuntimeObservation(
    'Downloading Electron binary...\n{"status":200,"body":"ok","injectedCalls":1,"unrelatedCode":"EACCES"}',
  )).toBe(1);
  const injectedCalls = parseRuntimeObservation(stdout);

  expect(injectedCalls).toBeGreaterThan(0);
  evidence.recordAssertionEvidence(
    "The embedded runtime continues after the exact EINVAL but preserves unrelated socket failures",
    `status=200; body=ok; injectedCalls=${injectedCalls}; unrelatedCode=EACCES`,
    injectedCalls > 0,
  );
});
