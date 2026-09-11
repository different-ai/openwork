import { browserScript } from "@openwork/cdp";
import type { Seed } from "@openwork/env";

declare global {
  interface Window {
    __inventoryListFault: { mode: "normal" | "hold" | "fail"; release: (() => void) | null };
  }
}

export async function emptyWorkspaceInventory(seed: Seed) {
  const workspacePath = seed.tmpPath("empty-workspace-inventory");
  const app = await seed.appWeb({ name: "empty-workspace-inventory", workspacePath });
  const workspace = await seed.workspace(app, workspacePath);
  // Fault only the owning v1 inventory HTTP read, never product state or DOM.
  await seed.evalIn(app, browserScript((workspaceId) => {
    const original = window.fetch.bind(window);
    const fault: Window["__inventoryListFault"] = { mode: "normal", release: null };
    window.__inventoryListFault = fault;
    window.fetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.method === "GET" && new URL(request.url).pathname === `/workspace/${workspaceId}/opencode/session`) {
        if (fault.mode === "hold") await new Promise<void>(resolve => {
          const previous = fault.release;
          fault.release = () => { previous?.(); resolve(); };
        });
        if (fault.mode === "fail") return Response.json({ code: "forbidden", message: "Synthetic inventory unavailable" }, { status: 403 });
      }
      return original(request);
    };
  }, [workspace.workspaceId]));
  return {
    app, workspace,
    held: () => seed.evalIn(app, () => Boolean(window.__inventoryListFault.release)),
    setFault: (mode: "normal" | "hold" | "fail") => seed.evalIn(app, browserScript(mode => {
      window.__inventoryListFault.mode = mode;
      if (mode !== "hold") window.__inventoryListFault.release?.();
    }, [mode])),
  };
}
