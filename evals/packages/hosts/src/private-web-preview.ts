import { defaultDaytonaExec } from "./daytona.ts";
import type { DaytonaExec } from "./daytona.ts";

export async function privateSandboxId(sandbox: string, exec: DaytonaExec = defaultDaytonaExec): Promise<string> {
  const result = await exec(["info", sandbox, "-f", "json"], { timeoutMs: 30_000 });
  if (result.code !== 0) throw new Error("Could not verify private sandbox identity.");
  let info: unknown;
  try { info = JSON.parse(result.stdout); } catch { throw new Error("Invalid private sandbox identity receipt."); }
  if (typeof info !== "object" || info === null || !("public" in info) || info.public !== false
    || !("id" in info) || typeof info.id !== "string" || !/^[a-zA-Z0-9-]+$/.test(info.id)) {
    throw new Error("Security prerequisite: Daytona must confirm a private sandbox before app-web starts.");
  }
  return info.id;
}

export function parsePrivatePreview(output: string, sandboxId: string, port: number): { browserOrigin: string; unsignedOrigin: string; browserHostSuffix: string } {
  const match = output.match(/https:\/\/[^\s"'<>)]+/);
  if (!match) throw new Error("Daytona did not return a signed preview origin.");
  const url = new URL(match[0]);
  const [label, ...domain] = url.hostname.split(".");
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || url.port
    || !label?.startsWith(`${port}-`) || label.length <= `${port}-`.length || label === `${port}-${sandboxId}` || domain.length < 2
    || /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(label.slice(`${port}-`.length))) {
    throw new Error("Security prerequisite: app-web requires a port-bound signed hostname, not a query token or public URL.");
  }
  return { browserOrigin: url.origin, unsignedOrigin: `https://${port}-${sandboxId}.${domain.join(".")}`, browserHostSuffix: `.${domain.join(".")}` };
}

export async function privateWebPreview(sandboxId: string, port: number, exec: DaytonaExec = defaultDaytonaExec, expiresInSeconds = 3600) {
  if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 86400) throw new Error("Signed preview expiry must be 1-86400 seconds.");
  const identity = await exec(["info", sandboxId, "-f", "json"], { timeoutMs: 30_000 });
  let info: unknown;
  try { info = JSON.parse(identity.stdout); } catch { throw new Error("Invalid preview identity receipt."); }
  if (identity.code !== 0 || typeof info !== "object" || info === null || !("id" in info) || info.id !== sandboxId
    || !("public" in info) || info.public !== false || !("toolboxProxyUrl" in info) || typeof info.toolboxProxyUrl !== "string") {
    throw new Error("Security prerequisite: sandbox info must confirm its private preview domain.");
  }
  let toolbox: URL;
  try { toolbox = new URL(info.toolboxProxyUrl); } catch { throw new Error("Invalid sandbox preview domain."); }
  if (toolbox.protocol !== "https:" || toolbox.hostname.split(".").length < 2
    || toolbox.username || toolbox.password || toolbox.port || toolbox.search || toolbox.hash || toolbox.pathname !== "/toolbox") {
    throw new Error("Security prerequisite: sandbox info must confirm a supported toolbox proxy domain.");
  }
  const result = await exec(["preview-url", sandboxId, "-p", String(port), "--expires", String(expiresInSeconds)], { timeoutMs: 30_000 });
  if (result.code !== 0) throw new Error("Could not create private app-web preview.");
  return parsePrivatePreview(result.stdout, sandboxId, port);
}

async function socketOpens(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, "vite-hmr");
    const timer = setTimeout(() => finish(false), 10_000);
    const finish = (opened: boolean) => {
      clearTimeout(timer);
      socket.close();
      resolve(opened);
    };
    socket.addEventListener("open", () => finish(true), { once: true });
    socket.addEventListener("error", () => finish(false), { once: true });
  });
}

export async function verifyPrivateWebPreview(
  preview: { browserOrigin: string; unsignedOrigin: string },
  request: typeof fetch = fetch,
  opens: (url: string) => Promise<boolean> = socketOpens,
): Promise<void> {
  const get = (origin: string, path: string) => request(`${origin}${path}`, {
    redirect: "error", headers: { "X-Daytona-Skip-Preview-Warning": "true" }, signal: AbortSignal.timeout(30_000),
  });
  try {
    for (const path of ["/", "/@vite/client", "/src/main.tsx", "/api/openwork/health"]) {
      const denied = await get(preview.unsignedOrigin, path);
      if (![401, 403].includes(denied.status)) throw new Error("Unsigned access was not denied.");
    }
    const index = await get(preview.browserOrigin, "/");
    if (!index.ok || !(await index.text()).includes("/@vite/client")) throw new Error("Preview did not serve Vite.");
    const client = await get(preview.browserOrigin, "/@vite/client");
    if (!client.ok) throw new Error("Preview assets unavailable.");
    const token = (await client.text()).match(/\bwsToken\s*=\s*"([a-zA-Z0-9_-]+)"/)?.[1];
    if (!token) throw new Error("Cannot verify preview WebSocket authentication.");
    const socketUrl = (origin: string) => `${origin.replace(/^https:/, "wss:")}/?token=${token}`;
    if (await opens(socketUrl(preview.unsignedOrigin))) throw new Error("Unsigned WebSocket access was not denied.");
    if (!await opens(socketUrl(preview.browserOrigin))) throw new Error("Signed WebSocket unavailable.");
    const health = await get(preview.browserOrigin, "/api/openwork/health");
    if (!health.ok || !health.headers.get("content-type")?.includes("application/json")) throw new Error("Same-origin backend unavailable.");
  } catch {
    throw new Error("Security prerequisite: private app-web preview must protect HTTP, assets, and WebSockets and serve the same-origin backend. No browser URL published.");
  }
}
