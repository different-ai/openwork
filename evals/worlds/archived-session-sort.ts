import { addInitScript, browserScript, navigate } from "@openwork/cdp";
import { waitUntilInteractive } from "@openwork/behaviors";
import { resolveEvalEngine, SkipError, type Seed } from "@openwork/env";
import { readHeadlessRuntimeManifest, resolveHeadlessWorldRuntimePaths } from "@openwork/world";
import { fileURLToPath } from "node:url";
import { mkdir, realpath } from "node:fs/promises";

export async function archivedSessionSort(seed: Seed) {
  if (resolveEvalEngine() !== "v1") throw new SkipError("archive sorting requires v1; v2 does not support archiving");
  const temporaryPath = seed.tmpPath("archived-session-sort");
  await mkdir(temporaryPath, { recursive: true });
  const workspacePath = await realpath(temporaryPath);
  const app = await seed.appWeb({ name: "archived-session-sort", workspacePath });
  const workspaceA = await seed.workspace(app, workspacePath);
  const newest = { ...await seed.session(app, { title: "Newest archive, oldest creation" }), ...workspaceA };
  const tieA = { ...await seed.session(app, { title: "Archive tie A" }), ...workspaceA };
  const tieA2 = { ...await seed.session(app, { title: "Archive tie A2" }), ...workspaceA };
  // appWeb deliberately gives the browser only client credentials. Arrange the
  // second workspace with this test-owned runtime's host API, not a browser grant.
  const paths = resolveHeadlessWorldRuntimePaths(fileURLToPath(new URL("../../", import.meta.url)), app.handle.name);
  const runtime = await readHeadlessRuntimeManifest(paths.runtimeManifestPath);
  if (!runtime || runtime.openworkUrl !== app.openworkUrl || runtime.workspace !== workspacePath) {
    throw new Error("Archive fixture could not identify its owned headless runtime");
  }
  const response = await fetch(`${runtime.openworkUrl}/workspaces/local`, {
    method: "POST",
    headers: { "X-OpenWork-Host-Token": runtime.hostToken, "Content-Type": "application/json" },
    body: JSON.stringify({ folderPath: `${workspacePath}/second`, name: "Second archive workspace", preset: "starter" }),
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status !== 201) throw new Error(`Archive fixture workspace creation failed: ${response.status}`);
  const created: unknown = await response.json();
  if (typeof created !== "object" || created === null || !("activeId" in created) || typeof created.activeId !== "string") {
    throw new Error("Archive fixture workspace creation returned no ID");
  }
  await seed.evalIn(app, browserScript((workspaceId) => {
    localStorage.setItem("openwork.react.activeWorkspace", workspaceId);
  }, [created.activeId]));
  await navigate(app.client, `${app.webUrl}/workspace/${created.activeId}/session`);
  await waitUntilInteractive(app);
  const workspaceB = await seed.workspace(app, `${workspacePath}/second`);
  const oldest = { ...await seed.session(app, { title: "Oldest archive, newest update" }), ...workspaceB };
  const tieB = { ...await seed.session(app, { title: "Archive tie B" }), ...workspaceB };
  const active = { ...await seed.session(app, { title: "Still active" }), ...workspaceB };

  // Arrange and inspect native engine metadata through the real HTTP boundary.
  // The web surface keeps its loopback credentials in its isolated browser profile.
  const metadata = (target: typeof newest, archived?: number) => seed.evalIn(app, browserScript(async (workspaceId, sessionId, archived) => {
    const base = "http://127.0.0.1:" + localStorage.getItem("openwork.server.port");
    const response = await fetch(`${base}/workspace/${encodeURIComponent(workspaceId)}/opencode/session/${encodeURIComponent(sessionId)}`, {
      method: archived === null ? "GET" : "PATCH",
      headers: { Authorization: "Bearer " + localStorage.getItem("openwork.server.token"), "Content-Type": "application/json" },
      ...(archived === null ? {} : { body: JSON.stringify({ time: { archived } }) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Archive fixture metadata request failed: ${response.status}`);
    const value: unknown = await response.json();
    if (typeof value !== "object" || value === null || !("id" in value) || value.id !== sessionId
      || !("directory" in value) || typeof value.directory !== "string"
      || !("time" in value) || typeof value.time !== "object" || value.time === null
      || !("created" in value.time) || typeof value.time.created !== "number"
      || !("updated" in value.time) || typeof value.time.updated !== "number") {
      throw new Error("Archive fixture received invalid native session metadata");
    }
    return {
      directory: value.directory,
      created: value.time.created,
      updated: value.time.updated,
      archived: "archived" in value.time && typeof value.time.archived === "number" ? value.time.archived : 0,
    };
  }, [target.workspaceId, target.sessionId, archived ?? null]), { awaitPromise: true, timeoutMs: 20_000 });

  const timestamp = Date.now() - 86_400_000;
  await metadata(newest, timestamp + 300);
  await metadata(tieA, timestamp + 200);
  await metadata(tieA2, timestamp + 200);
  await metadata(tieB, timestamp + 200);
  await metadata(oldest, timestamp + 100);
  // Native list order already matches ascending IDs. Reverse only this real
  // HTTP response so the same-workspace tie cannot pass by stable-sort accident.
  const reversedList = await addInitScript(app.client, browserScript((workspaceId) => {
    const original = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const request = new Request(input, init);
      const response = await original(request);
      if (request.method !== "GET" || new URL(request.url).pathname !== `/workspace/${workspaceId}/opencode/session` || !response.ok) return response;
      const sessions: unknown = await response.json();
      if (!Array.isArray(sessions)) throw new Error("Archive fixture expected a native session list");
      return Response.json(sessions.reverse(), { status: response.status });
    };
  }, [workspaceA.workspaceId]));
  return {
    app, workspacePath, workspaceA, workspaceB, newest, oldest, tieA, tieA2, tieB, active, metadata,
    route: () => seed.evalIn(app, () => location.pathname),
    // Persist the same preference as workspace dragging, then let a real reload consume it.
    workspaceOrder: (ids: string[]) => seed.evalIn(app, browserScript((ids) => {
      localStorage.setItem("openwork.react.workspaceOrder", JSON.stringify(ids));
    }, [ids])),
    [Symbol.asyncDispose]: () => reversedList[Symbol.asyncDispose](),
  };
}
