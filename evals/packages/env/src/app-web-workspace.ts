import { realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

/** Only the newly launched isolated fixture supplies these credentials. Never expose them to the browser. */
async function ownedRequest(
  owner: { openworkUrl: string; hostToken: string },
  path: "/workspaces/local" | "/runtime-config/providers",
  body: Record<string, unknown>,
): Promise<unknown> {
  const url = new URL(owner.openworkUrl);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) || !url.port
    || url.username || url.password || !owner.hostToken) {
    throw new Error("Fixture provisioning requires an owned loopback runtime and host credential.");
  }
  const response = await fetch(new URL(path, url), {
    method: path === "/workspaces/local" ? "POST" : "PATCH",
    redirect: "error",
    headers: { "x-openwork-host-token": owner.hostToken, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Owned app-web workspace provisioning failed: HTTP ${response.status}`);
  return response.json();
}

export async function configureOwnedProviders(owner: { openworkUrl: string; hostToken: string }, provider: Record<string, unknown>): Promise<void> {
  const body = await ownedRequest(owner, "/runtime-config/providers", { provider });
  if (typeof body !== "object" || body === null || !("ok" in body) || body.ok !== true) {
    throw new Error("Owned app-web provider configuration was not acknowledged.");
  }
}

export async function provisionOwnedWorkspace(owner: { openworkUrl: string; hostToken: string }, folderPath: string): Promise<{ workspaceId: string }> {
  if (!folderPath.trim()) throw new Error("Workspace provisioning requires a folder path.");
  const absolute = resolve(folderPath);
  const canonicalPath = await realpath(absolute).catch(async (error: unknown) => {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    return join(await realpath(dirname(absolute)), basename(absolute));
  });
  const body = await ownedRequest(owner, "/workspaces/local", { folderPath: canonicalPath });
  if (typeof body !== "object" || body === null || !("activeId" in body) || typeof body.activeId !== "string" || !body.activeId) {
    throw new Error("Owned app-web workspace provisioning returned no workspace identity.");
  }
  return { workspaceId: body.activeId };
}
