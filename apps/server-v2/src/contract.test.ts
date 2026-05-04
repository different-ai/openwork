import { expect, test } from "bun:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = path.resolve(packageDir, "../..");

async function runCommand(command: Array<string>, cwd: string) {
  const child = Bun.spawn(command, {
    cwd,
    env: process.env,
    stderr: "pipe",
    stdout: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { exitCode, stderr, stdout };
}

test("openapi generation writes the committed server-v2 contract", async () => {
  const result = await runCommand(["bun", "./scripts/generate-openapi.ts"], packageDir);

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("apps/server-v2/openapi/openapi.json");

  const openApiContents = await Bun.file(path.join(packageDir, "openapi/openapi.json")).text();
  expect(openApiContents).toContain('"/system/health"');
  expect(openApiContents).toContain('"getSystemHealth"');
  expect(openApiContents).toContain('"/system/status"');
  expect(openApiContents).toContain('"/system/cloud-signin"');
  expect(openApiContents).toContain('"/system/managed/mcps"');
  expect(openApiContents).toContain('"/system/router/identities/telegram"');
  expect(openApiContents).toContain('"/workspaces"');
  expect(openApiContents).toContain('"/workspaces/{workspaceId}/export"');
  expect(openApiContents).toContain('"/workspaces/{workspaceId}/sessions"');
  expect(openApiContents).toContain('"/workspaces/{workspaceId}/events"');
  expect(openApiContents).toContain('"/system/opencode/health"');
  expect(openApiContents).toContain('"/system/runtime/versions"');
});

test("sdk generation succeeds from the server-v2 openapi document", async () => {
  const result = await runCommand(["pnpm", "--filter", "@openwork/server-sdk", "generate"], repoDir);

  expect(result.exitCode).toBe(0);

  const sdkIndex = await Bun.file(path.join(repoDir, "packages/openwork-server-sdk/generated/index.ts")).text();
  expect(sdkIndex).toContain("getSystemHealth");
  expect(sdkIndex).toContain("getSystemStatus");
  expect(sdkIndex).toContain("getSystemCloudSignin");
  expect(sdkIndex).toContain("getSystemManagedMcps");
  expect(sdkIndex).toContain("getSystemRouterIdentitiesTelegram");
  expect(sdkIndex).toContain("getWorkspaces");
  expect(sdkIndex).toContain("getWorkspacesByWorkspaceIdExport");
  expect(sdkIndex).toContain("getWorkspacesByWorkspaceIdSessions");
  expect(sdkIndex).toContain("getWorkspacesByWorkspaceIdEvents");
  expect(sdkIndex).toContain("GetSystemHealthResponse");
  expect(sdkIndex).toContain("getSystemOpencodeHealth");
  expect(sdkIndex).toContain("getSystemRuntimeVersions");
});
