import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Seed } from "@openwork/env";
import { driveFileTransfers } from "./drive-file-transfers.ts";
import { bootServer, stopChild } from "./openwork-server-cli.ts";

export { inventoryExport, supplierWorkbook } from "./drive-file-transfers.ts";

const run = promisify(execFile);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function object(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected response object");
  return value;
}

/** The Drive transfer world plus the real desktop host. Host calls are the transport the drive_* engine tools use; the bash helper stands in for the agent's shell tool. */
export async function driveFiles(seed: Seed) {
  const stack = new AsyncDisposableStack();
  try {
    const cloud = stack.use(await driveFileTransfers(seed));
    const scratch = await realpath(await mkdtemp(join(tmpdir(), "drive-files-")));
    stack.defer(() => rm(scratch, { recursive: true, force: true }));
    // Opened through a symlink, like macOS /tmp: link records hold real paths and must still match.
    const workspace = join(scratch, "workspace");
    await mkdir(join(scratch, "workspace-real"));
    await symlink(join(scratch, "workspace-real"), workspace);

    // The desktop host, connected to this Den as the first member.
    const config = join(scratch, "server.json");
    await writeFile(config, JSON.stringify({ authorizedRoots: [workspace] }));
    await writeFile(join(scratch, "connect-state.json"), JSON.stringify({
      connectEnabled: true, updatedAt: Date.now(),
      cloudMcp: { type: "remote", enabled: true, oauth: false, url: `${cloud.denUrl}/mcp/agent`, headers: { Authorization: `Bearer ${cloud.memberToken}` } },
    }));
    const hostToken = "drive-files-client";
    const home = join(scratch, "home");
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OPENCODE") && !key.startsWith("OPENWORK_")));
    const booted = bootServer({
      ...inherited, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share"), XDG_CACHE_HOME: join(home, ".cache"),
      OPENWORK_SERVER_CONFIG: config, OPENWORK_DATA_DIR: join(scratch, "data"), OPENWORK_RUNTIME_DB: join(scratch, "runtime.sqlite"),
      OPENWORK_DEV_MODE: "1", OPENWORK_GOOGLE_API_BASE_URL: cloud.google.apiUrl,
    }, hostToken, workspace, () => {}, { configPath: config });
    stack.defer(() => stopChild(booted.child));
    const hostUrl = await booted.listening;

    return {
      google: cloud.google, accounts: cloud.accounts, files: cloud.files, workspace,
      fullId: cloud.fullId, readOnlyId: cloud.readOnlyId, objects: cloud.objects, mcp: cloud.mcp,
      /** One host Drive action, as the drive_* tools send it after any approval. */
      async host(action: string, args: Record<string, unknown>) {
        const response = await fetch(`${hostUrl}/experimental/extensions/call`, {
          method: "POST", headers: { authorization: `Bearer ${hostToken}`, "content-type": "application/json" },
          body: JSON.stringify({ extensionId: "openwork-cloud-uploads", action, args, context: { directory: workspace } }),
          signal: AbortSignal.timeout(120_000),
        });
        return { status: response.status, body: object(await response.json()) };
      },
      async actions() {
        const response = await fetch(`${hostUrl}/experimental/extensions/actions?extensionId=openwork-cloud-uploads`, { headers: { authorization: `Bearer ${hostToken}` }, signal: AbortSignal.timeout(10_000) });
        return object(await response.json());
      },
      /** Den's host download route as another member, without the desktop host. */
      async describeAs(identity: "first" | "second", fileId: string) {
        const result = await cloud.host(`/v1/direct-downloads/google-workspace/drive-files/${fileId}`, { query: { connectionId: cloud.fullId } }, identity);
        return { status: result.status, body: result.json ?? {} };
      },
      /** The agent's bash tool: runs in the workspace and never returns file bytes to the test. */
      async bash(command: string) {
        try {
          const result = await run("bash", ["-c", command], { cwd: workspace, timeout: 60_000, maxBuffer: 1024 * 1024 });
          return { code: 0, stdout: result.stdout, stderr: result.stderr };
        } catch (error) {
          const failed = object(error);
          return { code: typeof failed.code === "number" ? failed.code : 1, stdout: String(failed.stdout ?? ""), stderr: String(failed.stderr ?? "") };
        }
      },
      read: (path: string) => readFile(join(workspace, path)),
      /** Content downloads and exports Google served for one file. */
      async contentRequests(fileId: string) {
        const response = await fetch(`${cloud.google.apiUrl}/requests`, { signal: AbortSignal.timeout(10_000) });
        const entries = object(await response.json()).requests;
        if (!Array.isArray(entries)) throw new Error("Missing provider witness");
        return entries.map(object).filter((entry) => String(entry.path) === `/drive/v3/files/${fileId}/export` || (String(entry.path) === `/drive/v3/files/${fileId}` && String(entry.url).includes("alt=media"))).length;
      },
      [Symbol.asyncDispose]: () => stack.disposeAsync(),
    };
  } catch (error) { await stack.disposeAsync(); throw error; }
}
