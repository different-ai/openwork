import { createServer } from "node:http";
import { browserScript, evaluate } from "@openwork/cdp";
import { resolveEvalEngine, SkipError, type Place, type Seed } from "@openwork/env";
import { configureProvider } from "./chat.ts";

export async function sessionProviderAttribution(seed: Seed, { place }: { place: Place }) {
  if (place.kind !== "local" || resolveEvalEngine() !== "v1") throw new SkipError("Requires isolated local Electron and engine v1");
  if (process.env.OPENWORK_EVAL_ELECTRON_BINARY?.trim()) throw new SkipError("Requires source-built isolated Electron");
  await using resources = new AsyncDisposableStack();
  const prompt = `Attribute terminal provider rejection ${Date.now()}-${process.pid}.`;
  const errorMessage = "Attribution witness: provider rejected this request before assistant text.";
  const requests: { at: number; method: string; path: string; marker: boolean; status: number; assistantTextBytes: number }[] = [];
  const provider = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    const status = request.method === "POST" && request.url === "/v1/chat/completions" ? 400 : 404;
    requests.push({ at: Date.now(), method: request.method ?? "", path: request.url ?? "", marker: body.includes(prompt), status, assistantTextBytes: 0 });
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: errorMessage, type: "invalid_request_error", code: "attribution_terminal_rejection" } }));
  });
  await new Promise<void>((resolve, reject) => {
    provider.once("error", reject);
    provider.listen(0, "127.0.0.1", resolve);
  });
  resources.defer(async () => {
    provider.closeAllConnections();
    await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
  });
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("Provider witness failed to bind");
  const providerId = "attribution-terminal";
  const modelId = "attribution-model";
  const app = await seed.desktop({ name: "session-provider-attribution", model: `${providerId}/${modelId}` });
  const workspace = await seed.workspace(app, seed.tmpPath("provider-attribution"));
  await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, {
    model: `${providerId}/${modelId}`, small_model: `${providerId}/${modelId}`,
    provider: { [providerId]: { npm: "@ai-sdk/openai-compatible", name: "Attribution model",
      options: { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: "isolated-attribution-witness" },
      models: { [modelId]: { name: "Attribution model", tool_call: false } } } },
  });
  const [session] = await seed.sessions(app, ["Provider terminal attribution"]);
  if (!session) throw new Error("Attribution session not created");
  const server = await evaluate(app.client, async () => {
    const info = await window.__OPENWORK_ELECTRON__.invokeDesktop("openworkServerInfo");
    if (!info.running || !info.baseUrl) throw new Error("Isolated server is unavailable");
    return { baseUrl: info.baseUrl, token: info.ownerToken ?? info.clientToken };
  }, { awaitPromise: true });
  if (!server.token || !["127.0.0.1", "localhost"].includes(new URL(server.baseUrl).hostname)) throw new Error("Only isolated loopback server is permitted");
  await evaluate(app.client, browserScript(sessionId => {
    let trusted = false;
    let submittedAt: number | null = null;
    const samples: { at: number; draft: string; text: string; status: string[]; actions: string[]; assistantText: string[]; toasts: string[] }[] = [];
    const read = () => {
      const surface = document.querySelector<HTMLElement>(`[data-session-surface-id="${sessionId}"]`);
      const visible = (node: HTMLElement) => Boolean(node.getClientRects().length);
      return {
        at: Date.now(),
        draft: surface?.querySelector<HTMLElement>('[data-lexical-editor="true"]')?.innerText.trim() ?? "",
        text: surface?.innerText ?? "",
        status: [...(surface?.querySelectorAll<HTMLElement>("[data-loading-message]") ?? [])].filter(visible).map(node => node.innerText),
        actions: [...(surface?.querySelectorAll<HTMLElement>("[data-composer-actions] button") ?? [])].filter(visible).map(node => node.getAttribute("aria-label") ?? node.innerText),
        assistantText: [...(surface?.querySelectorAll<HTMLElement>('[data-message-role="assistant"]') ?? [])].filter(visible).map(node => node.innerText),
        toasts: [...document.querySelectorAll<HTMLElement>("[data-sonner-toast]")].filter(visible).map(node => node.innerText),
      };
    };
    const sample = () => {
      const value = read();
      const previous = samples.at(-1);
      if (submittedAt !== null && (!previous || JSON.stringify({ ...previous, at: 0 }) !== JSON.stringify({ ...value, at: 0 }))) samples.push(value);
      return value;
    };
    const capture = (event: KeyboardEvent) => {
      if (submittedAt !== null || !event.isTrusted || event.key !== "Enter" || !(event.target instanceof Element)
        || !event.target.closest(`[data-session-surface-id="${sessionId}"] [data-lexical-editor="true"]`)) return;
      trusted = true;
      submittedAt = Date.now();
      sample();
    };
    const observer = new MutationObserver(sample);
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["aria-label", "data-loading-message"] });
    document.addEventListener("keydown", capture, true);
    window.__providerAttribution = {
      read: () => ({ ...sample(), trusted, submittedAt, samples: [...samples] }),
      dispose: () => { observer.disconnect(); document.removeEventListener("keydown", capture, true); delete window.__providerAttribution; },
    };
  }, [session.sessionId]));
  resources.defer(() => evaluate(app.client, () => window.__providerAttribution?.dispose()).then(() => undefined));
  const get = async (path: string): Promise<unknown> => {
    const response = await fetch(`${server.baseUrl}/workspace/${workspace.workspaceId}/opencode/${path}`, {
      headers: { Authorization: `Bearer ${server.token}` }, signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`Attribution read failed: ${response.status}`);
    return response.json();
  };
  const lifetime = resources.move();
  return {
    app, session, prompt, errorMessage,
    providerRequests: () => requests.map(request => ({ ...request })),
    ui: () => evaluate(app.client, () => {
      if (!window.__providerAttribution) throw new Error("Attribution observer missing");
      return window.__providerAttribution.read();
    }),
    async engine() {
      const [messages, statuses] = await Promise.all([get(`session/${session.sessionId}/message`), get("session/status")]);
      if (!Array.isArray(messages) || typeof statuses !== "object" || statuses === null) throw new Error("Malformed engine readback");
      const rows = messages.map((message: { info: { id: string; role: string; error?: unknown; time: { completed?: number } }; parts: { type: string; text?: string }[] }) => ({
        id: message.info.id, role: message.info.role, error: message.info.error, completed: message.info.time.completed,
        text: message.parts.filter(part => part.type === "text").map(part => part.text).join("\n"),
      }));
      return { messages: rows, statuses, admissions: rows.filter(row => row.role === "user" && row.text === prompt).length };
    },
    async [Symbol.asyncDispose]() { await lifetime.disposeAsync(); },
  };
}

declare global {
  interface Window {
    __providerAttribution?: {
      read(): { at: number; draft: string; text: string; status: string[]; actions: string[]; assistantText: string[]; toasts: string[]; trusted: boolean; submittedAt: number | null;
        samples: { at: number; draft: string; text: string; status: string[]; actions: string[]; assistantText: string[]; toasts: string[] }[] };
      dispose(): void;
    };
  }
}
