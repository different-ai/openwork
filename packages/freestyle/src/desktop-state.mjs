import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

export async function inspectDesktop({ reload = false, timeoutMs = 60_000, loadCdp = () => import("/workspace/evals/packages/cdp/src/index.ts") } = {}) {
  const { attachSurface, addInitScript, browserScript, evaluate, probeAppState, isInteractive } = await loadCdp();
  const surface = await attachSurface({ name: "preview-desktop-only", kind: "electron", hostKind: "local", cdpUrl: "http://127.0.0.1:9825" }, { timeoutMs: Math.min(timeoutMs, 30_000) });
  let init;
  try {
    const nonce = reload ? randomUUID() : null;
    if (reload) {
      init = await addInitScript(surface.client, browserScript((value) => { globalThis.__openworkPreviewReload = value; }, [nonce]));
      await surface.client.send("Page.reload", { ignoreCache: true }, { timeoutMs: 10_000 });
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = await probeAppState(surface.client, { timeoutMs: 3_000 }).catch(() => null);
      const empty = await evaluate(surface.client, browserScript((value) => {
        const prefs = JSON.parse(localStorage.getItem("openwork.preferences") ?? "{}");
        return {
          reloaded: value === null || globalThis.__openworkPreviewReload === value,
          signedOut: !localStorage.getItem("openwork.den.authToken") && !localStorage.getItem("openwork.den.activeOrgId"),
          noDefaultModel: !localStorage.getItem("openwork.defaultModel") && !prefs.defaultModel,
          firstRun: prefs.hasCompletedOnboarding !== true,
        };
      }, [nonce]), { timeoutMs: 3_000 }).catch(() => null);
      if (state && isInteractive(state) && ["welcome", "no-workspace"].includes(state.surface) && state.workspaceId === null
        && empty?.reloaded && empty.signedOut && empty.noDefaultModel && empty.firstRun) {
        return { ready: true, signedOut: true, firstRun: true, noWorkspace: true, noDefaultModel: true };
      }
      await delay(250);
    }
    throw new Error("Desktop did not reach fresh signed-out onboarding");
  } finally {
    try { await init?.dispose(); } finally { await surface.stop(); }
  }
}
