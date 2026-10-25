/** @jsxImportSource react */
import { afterAll, expect, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PanelEmpty, getPanelDestinations } from "../src/react-app/domains/session/panel/panel-empty";
import { createOpenworkServerClient } from "../src/app/lib/openwork-server";
import { PlatformProvider, createDefaultPlatform } from "../src/react-app/kernel/platform";
import { openTargetFromWorkspaceFile, isOpenableFileTarget } from "../src/react-app/domains/session/artifacts/open-target";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
const priorAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", priorAct);
  if (ownedDom) await GlobalRegistrator.unregister();
});

test("the empty pane describes conversation references, not a complete output inventory, and browsing is explicit", async () => {
  const browse = mock(() => {});
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<PanelEmpty initialDestination="files" onBrowseWorkspaceFiles={browse} />));
    expect(host.textContent).toContain("No referenced files available");
    expect(host.textContent).not.toContain("No files or artifacts yet");
    expect(host.textContent).not.toContain("automatically");
    expect(browse).not.toHaveBeenCalled();
    const button = [...host.querySelectorAll("button")].find(element => element.textContent?.includes("Browse workspace files"));
    expect(button?.disabled).toBe(false);
    await act(async () => button?.click());
    expect(browse).toHaveBeenCalledTimes(1);
    expect(getPanelDestinations({}, () => {})[0]).toMatchObject({ label: "Referenced files", description: "File references from this conversation." });
  } finally { await act(async () => root.unmount()); host.remove(); }
});

test("a disconnected workspace cannot browse or reuse another connection's catalog", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<PanelEmpty initialDestination="files" />));
    const button = [...host.querySelectorAll("button")].find(element => element.textContent?.includes("Browse workspace files"));
    expect(button?.disabled).toBe(true);
    expect(button?.title).toBe("Connect to this workspace to browse its files.");
    expect(host.querySelector("[data-workspace-file-tree]")).toBeNull();
    await act(async () => root.render(<PanelEmpty initialDestination="files" browseUnavailableReason="Open a conversation to browse workspace files." />));
    const unavailable = [...host.querySelectorAll("button")].find(element => element.textContent?.includes("Browse workspace files"));
    expect(unavailable?.disabled).toBe(true);
    expect(unavailable?.title).toBe("Open a conversation to browse workspace files.");
  } finally { await act(async () => root.unmount()); host.remove(); }
});

test("references include plain text and download-only files and keep producing-turn and missing-state updates", async () => {
  const { usePanelTabStore } = await import("../src/react-app/domains/session/panel/panel-tab-store");
  const sessionId = "workspace-file-fallback-test";
  const store = usePanelTabStore.getState();
  const text = openTargetFromWorkspaceFile("notes.txt", { updatedAt: 1 });
  const download = openTargetFromWorkspaceFile("archive.bin", { updatedAt: 1 });
  if (!text || !download) throw new Error("fixture targets missing");
  try {
    const references = [text, download];
    expect(references.filter(isOpenableFileTarget)).toHaveLength(2);
    store.syncTranscriptArtifacts(sessionId, references);
    for (const target of references) store.openTab(sessionId, { id: target.id, type: "artifact", label: target.name, preview: target.preview });
    store.syncTranscriptArtifacts(sessionId, references);
    expect(usePanelTabStore.getState().sessions[sessionId].tabs).toHaveLength(2);
    store.syncTranscriptArtifacts(sessionId, [{ ...text, sourceMessageId: "producing-turn" }, download]);
    expect(usePanelTabStore.getState().transcriptArtifactTargets[sessionId][0].sourceMessageId).toBe("producing-turn");
    store.syncTranscriptArtifacts(sessionId, [{ ...text, exists: false }, download]);
    expect(usePanelTabStore.getState().sessions[sessionId].tabs.map(tab => tab.id)).toEqual([download.id]);
    expect(usePanelTabStore.getState().transcriptArtifactTargets[sessionId][0].exists).toBe(false);
  } finally { store.clearSession(sessionId); }
});

test("explicit browsing refreshes a fresh cached empty catalog instead of claiming no files while checking", async () => {
  const { WorkspaceFileTree, workspaceFileTreeScope } = await import("../src/react-app/domains/session/artifacts/workspace-file-tree");
  const connection = createOpenworkServerClient({ baseUrl: "http://refresh.example.test", token: "fixture-refresh" });
  const pending = Promise.withResolvers<Awaited<ReturnType<typeof connection.listWorkspaceFiles>>>();
  const read = spyOn(connection, "listWorkspaceFiles").mockImplementation(() => pending.promise);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  client.setQueryData(["workspace-file-tree", ...workspaceFileTreeScope(connection, "workspace")], { items: [], total: 0, truncated: false });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<PlatformProvider value={createDefaultPlatform()}><QueryClientProvider client={client}>
      <WorkspaceFileTree client={connection} workspaceId="workspace" workspaceName="Workspace" selectedPath="" onOpenFile={() => {}} />
    </QueryClientProvider></PlatformProvider>));
    expect(read).toHaveBeenCalledTimes(1);
    expect(host.textContent).not.toContain("No workspace files available.");
    await act(async () => { pending.resolve({ items: [{ path: "new.md", kind: "file", size: 1, mtimeMs: 2, revision: "2" }], total: 1, truncated: false }); await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(host.querySelector("[data-workspace-file-count]")?.getAttribute("data-workspace-file-count")).toBe("1");
  } finally { await act(async () => root.unmount()); client.clear(); host.remove(); read.mockRestore(); }
});

test("the bounded tree reports truncation and clears both model and query rows on account/server changes", async () => {
  const { WorkspaceFileTree, workspaceFileTreeScope } = await import("../src/react-app/domains/session/artifacts/workspace-file-tree");
  const first = createOpenworkServerClient({ baseUrl: "http://worker-a.example.test", token: "fixture-account-a" });
  const second = createOpenworkServerClient({ baseUrl: "http://worker-a.example.test", token: "fixture-account-b" });
  const other = createOpenworkServerClient({ baseUrl: "http://worker-b.example.test", token: "fixture-account-a" });
  expect(workspaceFileTreeScope(first, "workspace")).not.toEqual(workspaceFileTreeScope(second, "workspace"));
  expect(workspaceFileTreeScope(first, "workspace")).not.toEqual(workspaceFileTreeScope(other, "workspace"));
  expect(workspaceFileTreeScope(first, "workspace")).not.toEqual(workspaceFileTreeScope(first, "other-workspace"));
  expect(JSON.stringify(workspaceFileTreeScope(first, "workspace"))).not.toContain("fixture-account-a");
  const readFirst = spyOn(first, "listWorkspaceFiles").mockResolvedValue({
    items: [
      { path: "summary.md", kind: "file", size: 20, mtimeMs: 1, revision: "1" },
      { path: "other.md", kind: "file", size: 20, mtimeMs: 1, revision: "1" },
    ], total: 3, truncated: true, incomplete: true, skippedDirectories: ["restricted"],
  });
  const readSecond = spyOn(second, "listWorkspaceFiles").mockImplementation(() => new Promise(() => {}));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const platform = createDefaultPlatform();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const render = (connection: typeof first) => <PlatformProvider value={platform}><QueryClientProvider client={client}>
    <WorkspaceFileTree client={connection} workspaceId="workspace" workspaceName="Workspace" selectedPath="" onOpenFile={() => {}} />
  </QueryClientProvider></PlatformProvider>;
  try {
    await act(async () => root.render(render(first)));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
    expect(readFirst).toHaveBeenCalledTimes(1);
    expect(host.querySelector("[data-workspace-file-count]")?.getAttribute("data-workspace-file-count")).toBe("2");
    expect(host.textContent).toContain("Showing 2 of 3 items");
    expect(host.textContent).toContain("Search covers the shown items");
    expect(host.textContent).toContain("Some folders could not be read");
    await act(async () => root.render(render(second)));
    expect(readSecond).toHaveBeenCalledTimes(1);
    expect(host.querySelector("[data-workspace-file-count]")?.getAttribute("data-workspace-file-count")).toBe("0");
    expect(host.textContent).not.toContain("Showing 2 of 3 items");
    expect(JSON.stringify(client.getQueryCache().getAll().map(query => query.queryKey))).not.toContain("fixture-account-");
  } finally {
    await act(async () => root.unmount()); client.clear(); host.remove(); readFirst.mockRestore(); readSecond.mockRestore();
  }
});
