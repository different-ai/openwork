import { browserScript } from "@openwork/cdp";
import { go } from "@openwork/behaviors";
import type { Seed } from "@openwork/env";
import { arrangeControl } from "./chat.ts";
import { workspaceWorld } from "./first-run.ts";

export type HtmlPreviewReport = {
  origin: string;
  ownScript: boolean;
  bridge: string;
  parentDocument: string;
  storage: string;
};

declare global {
  interface Window { __htmlPreviewReports?: HtmlPreviewReport[] }
}

export const untrustedHtmlPath = "previews/untrusted-report.html";
export const untrustedHtmlName = "untrusted-report.html";
export const escapeMarker = "data-html-preview-escaped";

// A workspace page (as a cloned repo or agent output could contain) whose
// script probes the window that hosts its preview. It only inspects and marks;
// it never calls the bridge. It reports what it could reach by postMessage,
// which works across origins.
const untrustedHtml = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Quarterly report</title>
<style>body{font:16px system-ui;margin:24px}#status{font-weight:600}</style></head>
<body>
<h1>Quarterly report</h1>
<p id="status">The page script has not run.</p>
<script>
  const report = { type: "openwork-html-preview-probe", ownScript: true };
  try { report.bridge = typeof parent.__OPENWORK_ELECTRON__; } catch (error) { report.bridge = "blocked: " + error.name; }
  try { parent.document.body.setAttribute("${escapeMarker}", "true"); report.parentDocument = "writable"; } catch (error) { report.parentDocument = "blocked: " + error.name; }
  try { localStorage.getItem("probe"); report.storage = "available"; } catch (error) { report.storage = "blocked: " + error.name; }
  document.getElementById("status").textContent = "The page script ran. App window: " + report.parentDocument + ".";
  parent.postMessage(report, "*");
</script>
</body>
</html>
`;

/** Desktop app with an open artifact panel and an untrusted HTML file in the workspace. */
export async function htmlPreviewIsolationWorld(seed: Seed) {
  const base = await workspaceWorld(seed);
  const [session] = await seed.sessions(base.app, ["HTML preview isolation"]);
  if (!session) throw new Error("Could not seed the HTML preview session.");
  await go(base.app, `/workspace/${base.workspace.workspaceId}/session/${session.sessionId}`);
  // TODO(primitive): write workspace files through the local server fixture.
  const wrote = await seed.evalIn(base.app, browserScript(async (workspaceId, path, content) => {
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token");
    if (!port || !token) return false;
    const response = await fetch("http://127.0.0.1:" + port + "/workspace/" + encodeURIComponent(workspaceId) + "/files/content", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ path, content, baseUpdatedAt: null }),
    });
    return response.ok;
  }, [base.workspace.workspaceId, untrustedHtmlPath, untrustedHtml]), { awaitPromise: true });
  if (wrote !== true) throw new Error("Could not seed the untrusted HTML file.");
  try {
    await arrangeControl(seed, base.app, "browser.open_url", { url: "about:blank" });
  } catch {
    // The browser can report ERR_ABORTED after it has already mounted the artifact side panel.
  }
  await arrangeControl(seed, base.app, "eval.artifact_tabs.seed_overflow", { count: 12 });
  // The preview is cross-origin after the fix, so the host window collects the
  // page's own postMessage report instead of reading into the frame.
  await seed.evalIn(base.app, () => {
    window.__htmlPreviewReports = [];
    window.addEventListener("message", (event) => {
      const data: unknown = event.data;
      if (typeof data !== "object" || data === null || !("type" in data) || data.type !== "openwork-html-preview-probe") return;
      const field = (key: string) => (key in data ? String(Reflect.get(data, key)) : "missing");
      window.__htmlPreviewReports?.push({
        origin: event.origin,
        ownScript: field("ownScript") === "true",
        bridge: field("bridge"),
        parentDocument: field("parentDocument"),
        storage: field("storage"),
      });
    });
  });
  return {
    ...base,
    session,
    // The desktop bridge only exists in Electron's main window; observe that it
    // is really there, so a blocked probe means isolation, not a missing target.
    hostBridge: () => seed.evalIn(base.app, () => typeof window.__OPENWORK_ELECTRON__?.invokeDesktop),
    previewReports: () => seed.evalIn(base.app, () => window.__htmlPreviewReports ?? []),
  };
}
