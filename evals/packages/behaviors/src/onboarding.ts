import type { Surface } from "@openwork/cdp";
import { currentHash, evalIn, fill, waitFor } from "./desktop.ts";

export interface LocalWorkspaceFacts {
  id: string;
  name: string;
  path: string;
  route: string;
  entrypoint: "manual-folder";
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
    entrypoint !== "manual-folder"
  ) {
    throw new Error(`Workspace creation returned malformed facts: ${JSON.stringify(value)}`);
  }
  return { id: value.id, name: value.name, path: value.path, route: value.route, entrypoint };
}

async function submitFolder(app: Surface, path: string): Promise<void> {
  await fill(app, 'input[placeholder="/workspace/my-project"]', path);
  await waitFor(app, `(() => {
    const input = document.querySelector('input[placeholder="/workspace/my-project"]');
    const button = input?.closest("div")?.querySelector("button");
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`, { timeoutMs: 20_000, label: "manual workspace folder submit" });
}

export async function createLocalWorkspaceViaUi(
  app: Surface,
  input: { path: string; name?: string },
): Promise<LocalWorkspaceFacts> {
  await waitFor(app, "location.hash.includes('/welcome')", { timeoutMs: 30_000, label: "welcome route" });
  let manualFolderVisible = await evalIn(app, 'Boolean(document.querySelector(\'input[placeholder="/workspace/my-project"]\'))') === true;
  if (!manualFolderVisible) {
    const useWithoutCloudVisible = await evalIn(app, `Boolean(document.querySelector('[data-testid="welcome-use-without-cloud"]:not(:disabled)'))`);
    if (useWithoutCloudVisible === true) {
      await evalIn(app, `document.querySelector('[data-testid="welcome-use-without-cloud"]')?.click()`);
      await waitFor(app, 'Boolean(document.querySelector(\'input[placeholder="/workspace/my-project"]\'))', {
        timeoutMs: 15_000,
        label: "local workspace folder input",
      });
      manualFolderVisible = true;
    }
  }
  if (!manualFolderVisible) throw new Error("The real manual workspace folder path is not available.");
  await submitFolder(app, input.path);

  await waitFor(app, 'Boolean(document.querySelector(\'[data-testid="provider-selection-step"]\'))', {
    timeoutMs: 120_000,
    label: "provider selection step",
  });
  // Deliberately do NOT query the workspace record here. The local server has
  // credentials in localStorage before it can actually serve, so an in-page fetch
  // at this point never settles. The caller resolves the id from the product's
  // own active-workspace state once onboarding finishes, which is both cheaper
  // and the state a user's app really uses.
  const raw = {
    id: "",
    name: input.name ?? "",
    path: input.path,
    route: await currentHash(app),
    entrypoint: "manual-folder",
  };
  return parseWorkspaceFacts(raw);
}
