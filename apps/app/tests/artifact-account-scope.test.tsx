/** @jsxImportSource react */
import { afterAll, expect, mock, spyOn, test } from "bun:test";
import { writeXlsxWorkbook } from "@openwork/workbook";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createOpenworkServerClient } from "../src/app/lib/openwork-server";
import { PlatformProvider, createDefaultPlatform } from "../src/react-app/kernel/platform";
import { openTargetFromWorkspaceFile } from "../src/react-app/domains/session/artifacts/open-target";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
if (!document.doctype) document.prepend(document.implementation.createDocumentType("html", "", ""));
const priorAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", priorAct);
  if (ownedDom) await GlobalRegistrator.unregister();
});

test("different actual workbooks with the same filename cannot share a values cache across preview owners", async () => {
  const { ArtifactSpreadsheetEditor } = await import("../src/react-app/domains/session/artifacts/artifact-spreadsheet-editor");
  const first = await writeXlsxWorkbook([{ name: "Summary", rows: [["Account A"]] }]);
  const second = await writeXlsxWorkbook([{ name: "Summary", rows: [["Account B"]] }]);
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onSave = mock(() => {});
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const value = () => [...host.querySelectorAll("input")].map(input => input.value).join(" ");
  try {
    await act(async () => root.render(<QueryClientProvider client={query}><ArtifactSpreadsheetEditor key="a" name="same.xlsx"
      content={{ kind: "binary", data: new Uint8Array(first.bytes).buffer }} onSave={onSave} /></QueryClientProvider>));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
    expect(value()).toContain("Account A");
    await act(async () => root.render(<QueryClientProvider client={query}><ArtifactSpreadsheetEditor key="b" name="same.xlsx"
      content={{ kind: "binary", data: new Uint8Array(second.bytes).buffer }} onSave={onSave} /></QueryClientProvider>));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
    expect(value()).toContain("Account B");
    expect(value()).not.toContain("Account A");
    expect(onSave).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); query.clear(); host.remove(); }
});

test("a workspace preview cannot reuse another account's contents when workspace, path and revision match", async () => {
  const { ArtifactPanel } = await import("../src/react-app/domains/session/artifacts/artifact-panel");
  const first = createOpenworkServerClient({ baseUrl: "http://worker.example.test", token: "fixture-account-a" });
  const second = createOpenworkServerClient({ baseUrl: "http://worker.example.test", token: "fixture-account-b" });
  const pending = Promise.withResolvers<Awaited<ReturnType<typeof second.readWorkspaceFile>>>();
  const readFirst = spyOn(first, "readWorkspaceFile").mockResolvedValue({ path: "note.md", content: "# Account A content", updatedAt: 1 });
  const readSecond = spyOn(second, "readWorkspaceFile").mockImplementation(() => pending.promise);
  const target = openTargetFromWorkspaceFile("note.md", { updatedAt: 1 });
  if (!target) throw new Error("fixture target missing");
  const query = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const platform = createDefaultPlatform();
  const render = (client: typeof first) => <PlatformProvider value={platform}><QueryClientProvider client={query}>
    <ArtifactPanel sessionId="chat" client={client} workspaceId="same-workspace" workspaceRoot="/work"
      tab={{ id: target.id, type: "artifact", label: target.name, preview: target.preview, target }} onClose={() => {}} />
  </QueryClientProvider></PlatformProvider>;
  try {
    await act(async () => root.render(render(first)));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
    expect(readFirst).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("Account A content");
    await act(async () => root.render(render(second)));
    expect(readSecond).toHaveBeenCalledTimes(1);
    expect(host.textContent).not.toContain("Account A content");
    await act(async () => { pending.resolve({ path: "note.md", content: "# Account B content", updatedAt: 1 }); await new Promise(resolve => setTimeout(resolve, 30)); });
    expect(host.textContent).toContain("Account B content");
    expect(host.textContent).not.toContain("Account A content");
    expect(JSON.stringify(query.getQueryCache().getAll().map(entry => entry.queryKey))).not.toContain("fixture-account-");
  } finally {
    await act(async () => root.unmount()); query.clear(); host.remove(); readFirst.mockRestore(); readSecond.mockRestore();
  }
});
