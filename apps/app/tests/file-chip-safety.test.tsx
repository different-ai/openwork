/** @jsxImportSource react */
import { afterAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { FileChip } from "../src/components/chat/file-chip";
import { OpenTargetProvider } from "../src/lib/target-provider";
import { PlatformProvider, createDefaultPlatform } from "../src/react-app/kernel/platform";
import { nativeFileAction, openTargetForHref } from "../src/react-app/domains/session/artifacts/resolve-open-target";
import { openTargetFromWorkspaceFile } from "../src/react-app/domains/session/artifacts/open-target";
import { ArtifactPanel } from "../src/react-app/domains/session/artifacts/artifact-panel";
import { createOpenworkServerClient } from "../src/app/lib/openwork-server";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
const priorAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", priorAct);
  if (ownedDom) await GlobalRegistrator.unregister();
});

const local = { isLocalWorkspace: true, canUseDesktop: true, os: "macos" } as const;
test("native actions require local provenance, a desktop, host-compatible paths and no known missing file", () => {
  expect(nativeFileAction("/work", "report.pdf", local)).toEqual({ path: "/work/report.pdf", action: "open" });
  expect(nativeFileAction("/work", "/outside/report.pdf", local)?.action).toBe("reveal");
  expect(nativeFileAction("/work", "report.pdf", { ...local, exists: false })).toBeNull();
  expect(nativeFileAction("/work", "report.pdf", { ...local, isLocalWorkspace: false })).toBeNull();
  expect(nativeFileAction("/work", "report.pdf", { ...local, canUseDesktop: false })).toBeNull();
  expect(nativeFileAction("C:\\work", "report.pdf", local)).toBeNull();
  expect(nativeFileAction("C:\\work", "/work/report.pdf", local)).toBeNull();
  expect(nativeFileAction(undefined, "/work/report.pdf", local)).toBeNull();
  expect(nativeFileAction("/work", "C:\\work\\report.pdf", local)).toBeNull();
  expect(nativeFileAction("C:\\work", "report.pdf", { ...local, os: "windows" })?.action).toBe("open");
  for (const path of ["https://example.test/report.pdf", "file://other/report.pdf", "\\\\server\\report.pdf", "../report.pdf"]) {
    expect(nativeFileAction("/work", path, local)).toBeNull();
  }
});

test("chip resolution retains the exact verified target and missing state rather than inventing availability", () => {
  const verified = openTargetFromWorkspaceFile("report.pdf", { size: 100, updatedAt: 12 });
  if (!verified) throw new Error("fixture target missing");
  const missing = { ...verified, exists: false };
  expect(openTargetForHref("/work/report.pdf", [missing], "/work")).toBe(missing);
  expect(openTargetForHref("report.pdf", [missing], "/work")?.exists).toBe(false);
});

test("an artifact from another runtime cannot borrow the active connection or local shell", async () => {
  const client = createOpenworkServerClient({ baseUrl: "http://active.example.test", token: "current-fixture-token" });
  const target = openTargetFromWorkspaceFile("report.pdf");
  if (!target) throw new Error("fixture target missing");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<ArtifactPanel sessionId="chat" client={client} workspaceId="active" workspaceRoot="/work" isLocalWorkspace
      tab={{ id: target.id, type: "artifact", label: target.name, preview: target.preview, target,
        runtime: { serverBaseUrl: "http://worker.example.test", workspaceId: "worker", workspaceRoot: "/work", isLocalWorkspace: false } }} onClose={() => {}} />));
    expect(host.textContent).toContain("Open this file in its workspace to preview it.");
    expect(host.querySelectorAll("button")).toHaveLength(0);
    await act(async () => root.render(<ArtifactPanel sessionId="chat" client={null} workspaceId={null} workspaceRoot="/work" isLocalWorkspace
      tab={{ id: target.id, type: "artifact", label: target.name, preview: target.preview, target,
        runtime: { serverBaseUrl: "http://worker.example.test", workspaceId: "worker", workspaceRoot: "/work", isLocalWorkspace: false } }} onClose={() => {}} />));
    expect(host.textContent).toBe("");
  } finally { await act(async () => root.unmount()); host.remove(); }
});

for (const scenario of [
  { name: "local existing", local: true, desktop: true, exists: true, path: "report.pdf", native: "Open in default app" },
  { name: "local missing", local: true, desktop: true, exists: false, path: "report.pdf", native: null },
  { name: "remote worker", local: false, desktop: true, exists: true, path: "report.pdf", native: null },
  { name: "web", local: true, desktop: false, exists: true, path: "report.pdf", native: null },
  { name: "Windows path on Mac", local: true, desktop: true, exists: true, path: "C:\\work\\report.pdf", native: null },
  { name: "outside workspace", local: true, desktop: true, exists: true, path: "/outside/report.pdf", native: "Show in folder" },
]) {
  test(`${scenario.name}: preview preserves provenance and only safe native actions appear`, async () => {
    const platform = createDefaultPlatform();
    platform.os = "macos";
    platform.capabilities = { ...platform.capabilities, revealInFileManager: scenario.desktop };
    let menuLabels: string[] = [];
    platform.showContextMenu = async request => {
      menuLabels = request.items.flatMap(item => item.type === "item" ? [item.label] : []);
      return null;
    };
    const onOpenTarget = mock(() => {});
    const target = openTargetFromWorkspaceFile(scenario.path);
    if (!target) throw new Error("fixture target missing");
    target.exists = scenario.exists;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(<PlatformProvider value={platform}><OpenTargetProvider workspaceRoot="/work" isLocalWorkspace={scenario.local} openTargets={[target]} onOpenTarget={onOpenTarget}><FileChip path={scenario.path} /></OpenTargetProvider></PlatformProvider>));
      const native = host.querySelector<HTMLButtonElement>("button[aria-label]");
      expect(native?.getAttribute("aria-label") ?? null).toBe(scenario.native ? `${scenario.native}: report.pdf` : null);
      await act(async () => host.querySelector("button")?.click());
      expect(onOpenTarget).toHaveBeenCalledWith(target, undefined);
      if (native) {
        await act(async () => native.click());
        expect(onOpenTarget).toHaveBeenLastCalledWith(target, { external: true, reveal: scenario.native === "Show in folder" });
      }
      // Even when no native action exists, the context menu still retains copying.
      const chip = host.querySelector("[data-slot='context-menu-trigger']");
      await act(async () => chip?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })));
      expect(menuLabels).toContain("Copy path");
      expect(menuLabels.includes("Open in default app") || menuLabels.includes("Show in folder")).toBe(scenario.native !== null);
    } finally {
      await act(async () => root.unmount()); host.remove();
    }
  });
}
