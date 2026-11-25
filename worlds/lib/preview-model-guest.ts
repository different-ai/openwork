import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

export interface ModelGuest {
  run(command: string): Promise<string>;
  write(path: string, content: string): Promise<unknown>;
}

export async function startModelRelay(guest: ModelGuest, key: string, model: string): Promise<number> {
  const directory = `/tmp/openwork-preview-model-${randomUUID()}`;
  try {
    await guest.run(`mkdir -m 700 ${directory}`);
    const source = await readFile(new URL("./preview-model-relay.mjs", import.meta.url), "utf8");
    await guest.write(`${directory}/relay.mjs`, source);
    await guest.write(`${directory}/credential`, JSON.stringify({ key, model }));
    const port = Number((await guest.run(`sh -c 'cd ${directory} || exit 1; nohup node relay.mjs </dev/null >/dev/null 2>&1 & for i in $(seq 1 100); do if test -s port; then cat port; exit 0; fi; sleep 0.1; done; exit 1'`)).trim());
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error();
    return port;
  } catch {
    // SDK errors can carry the upload body. Never attach them to launcher diagnostics.
    throw new Error("Could not start the private preview model relay.");
  }
}

export async function daytonaModelGuest(sandboxId: string): Promise<ModelGuest> {
  const { worldDaytonaAuth } = await import("../../evals/packages/hosts/src/daytona-auth.ts");
  const { DaytonaApi, daytonaConfig } = await import("../../packages/evidence-daytona/src/api.ts");
  const auth = await worldDaytonaAuth();
  if (auth.mode !== "api-key") throw new Error("Live models require Daytona API key authentication for private file uploads.");
  const config = daytonaConfig({ DAYTONA_API_KEY: auth.apiKey, DAYTONA_API_URL: auth.apiUrl });
  const api = new DaytonaApi(config, (url, options) => {
    if (new URL(String(url)).protocol !== "https:") throw new Error("Daytona live model setup requires HTTPS.");
    return fetch(url, { ...options, redirect: "error" });
  });
  const sandbox = await api.getSandbox(sandboxId);
  if (!sandbox || sandbox.id !== sandboxId || sandbox.public !== false) throw new Error("Private Daytona sandbox required.");
  return { run: (command) => api.execChecked(sandbox, command), write: (path, content) => api.writeFile(sandbox, path, content, 0o600) };
}
