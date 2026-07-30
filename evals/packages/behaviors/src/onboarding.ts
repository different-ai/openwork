import type { Surface } from "@openwork/cdp";
import { clickButton, evalIn, fill, waitFor, waitForText } from "./desktop.ts";

export interface LocalWorkspaceFacts {
  id: string;
  name: string;
  path: string;
  route: string;
  entrypoint: "manual-folder" | "workspace-modal";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseWorkspaceFacts(value: unknown): LocalWorkspaceFacts {
  if (!isRecord(value)) throw new Error("Workspace creation did not return facts.");
  const entrypoint = value.entrypoint;
  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.path !== "string" ||
    typeof value.route !== "string" ||
    (entrypoint !== "manual-folder" && entrypoint !== "workspace-modal")
  ) {
    throw new Error(`Workspace creation returned malformed facts: ${JSON.stringify(value)}`);
  }
  return { id: value.id, name: value.name, path: value.path, route: value.route, entrypoint };
}

async function submitFolder(app: Surface, path: string): Promise<void> {
  await fill(app, 'input[placeholder="/workspace/my-project"]', path);
  await clickButton(app, "Use this folder", { timeoutMs: 20_000 });
}

export async function createLocalWorkspaceViaUi(
  app: Surface,
  input: { path: string; name?: string },
): Promise<LocalWorkspaceFacts> {
  await waitFor(app, "location.hash.includes('/welcome')", { timeoutMs: 30_000, label: "welcome route" });
  let manualFolderVisible = await evalIn(app, 'Boolean(document.querySelector(\'input[placeholder="/workspace/my-project"]\'))') === true;
  if (!manualFolderVisible) {
    const useWithoutCloudVisible = await evalIn(app, `Boolean([...document.querySelectorAll("button")]
      .find((button) => (button.textContent ?? "").trim() === "Use Without Cloud" && !button.disabled))`);
    if (useWithoutCloudVisible === true) {
      await clickButton(app, "Use Without Cloud");
      await waitFor(app, 'Boolean(document.querySelector(\'input[placeholder="/workspace/my-project"]\'))', {
        timeoutMs: 15_000,
        label: "local workspace folder input",
      });
      manualFolderVisible = true;
    }
  }
  let entrypoint: LocalWorkspaceFacts["entrypoint"];

  if (manualFolderVisible) {
    // Current dev Electron exposes this field after Use Without Cloud. The
    // modal branch below retains the older local-workspace journey.
    entrypoint = "manual-folder";
    await submitFolder(app, input.path);
  } else {
    entrypoint = "workspace-modal";
    await waitFor(app, `(() => {
      const button = [...document.querySelectorAll("button")]
        .find((candidate) => (candidate.textContent ?? "").trim() === "Get started" && !candidate.disabled);
      if (!button) return false;
      button.click();
      return true;
    })()`, { timeoutMs: 15_000, label: "Get started" });
    await waitForText(app, "Local workspace", { timeoutMs: 15_000 });
    await waitFor(app, `(() => {
      const button = [...document.querySelectorAll("button")]
        .find((candidate) => (candidate.textContent ?? "").trim() === "Local workspace" && !candidate.disabled);
      if (!button) return false;
      button.click();
      return true;
    })()`, { timeoutMs: 15_000, label: "Local workspace" });
    await waitForText(app, "No folder selected yet.", { timeoutMs: 15_000 });
    const injected = await evalIn(app, `(() => {
      const placeholder = [...document.querySelectorAll("span, div, p")]
        .find((node) => (node.textContent ?? "").includes("No folder selected yet."));
      if (!placeholder) return { ok: false, reason: "folder placeholder not found" };
      const key = Object.keys(placeholder).find((candidate) => candidate.startsWith("__reactFiber$"));
      let fiber = key ? placeholder[key] : null;
      while (fiber) {
        const componentName = fiber.elementType?.name || fiber.type?.name || "";
        if (componentName === "CreateWorkspaceModal") break;
        fiber = fiber.return;
      }
      if (!fiber) return { ok: false, reason: "CreateWorkspaceModal fiber not found" };
      let hook = fiber.memoizedState;
      while (hook) {
        if (hook.queue?.dispatch) {
          hook.queue.dispatch({ type: "set", key: "selectedFolder", value: ${JSON.stringify(input.path)} });
          hook.queue.dispatch({ type: "set", key: "pickingFolder", value: false });
          return { ok: true };
        }
        hook = hook.next;
      }
      return { ok: false, reason: "folder reducer dispatch not found" };
    })()`);
    if (!isRecord(injected) || injected.ok !== true) {
      throw new Error(`Could not inject the folder chosen by the native picker: ${JSON.stringify(injected)}`);
    }
    if (input.name) {
      await evalIn(app, `(() => {
        const nameInput = document.querySelector('input[placeholder*="name" i], input[placeholder*="workspace" i]');
        if (!nameInput) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        setter?.call(nameInput, ${JSON.stringify(input.name)});
        nameInput.dispatchEvent(new Event("input", { bubbles: true }));
        nameInput.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      })()`);
    }
    await waitFor(app, `(() => {
      const button = [...document.querySelectorAll("button")]
        .find((candidate) => (candidate.textContent ?? "").trim() === "Create Workspace" && !candidate.disabled);
      if (!button) return false;
      button.click();
      return true;
    })()`, { timeoutMs: 15_000, label: "Create Workspace" });
  }

  await waitForText(app, "Power your first task", { timeoutMs: 120_000 });
  const raw = await evalIn(app, `(async () => {
    const invoke = window.__OPENWORK_ELECTRON__.invokeDesktop;
    const info = await invoke("openworkServerInfo");
    const baseUrl = String(info?.baseUrl || info?.connectUrl || "").replace(/\\/+$/, "");
    const headers = {};
    const token = info?.ownerToken || info?.clientToken || "";
    if (token) headers.authorization = "Bearer " + token;
    if (info?.hostToken) headers["x-openwork-host-token"] = info.hostToken;
    const response = await invoke("__fetch", baseUrl + "/workspaces", { method: "GET", headers, timeoutMs: 8_000 });
    const payload = typeof response?.body === "string" ? JSON.parse(response.body) : response?.body ?? response;
    const workspace = (payload?.workspaces ?? payload?.items ?? []).find((candidate) => candidate.path === ${JSON.stringify(input.path)});
    return {
      id: workspace?.id ?? "",
      name: workspace?.name ?? "",
      path: workspace?.path ?? "",
      route: location.hash,
      entrypoint: ${JSON.stringify(entrypoint)},
    };
  })()`, { awaitPromise: true, timeoutMs: 120_000 });
  return parseWorkspaceFacts(raw);
}
