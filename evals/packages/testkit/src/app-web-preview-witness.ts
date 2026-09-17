import { chrome, daytonaSandbox, parsePrivatePreview, privateSandboxId, verifyPrivateWebPreview } from "@openwork/hosts";
import { evaluateOnSurface } from "@openwork/cdp";
import type { AttachedSurface } from "@openwork/cdp";

export async function appWebPreviewWitness(options: { sandboxId: string; browserOrigin: string }) {
  let surface: AttachedSurface | undefined;
  try {
    await privateSandboxId(options.sandboxId);
    const preview = parsePrivatePreview(options.browserOrigin, options.sandboxId, 5178);
    await verifyPrivateWebPreview(preview);
    surface = await chrome({ name: "private-app-web-browser", host: daytonaSandbox(options.sandboxId), startUrl: "about:blank", headless: true });
    await surface.client.send("Network.enable");
    await surface.client.send("Network.setBlockedURLs", { urls: ["*openworklabs.com*", "*openwork.so*", "*posthog*", "*sentry*", "*api.openai.com*", "*api.anthropic.com*"] });
    await surface.client.send("Network.setExtraHTTPHeaders", { headers: { "X-Daytona-Skip-Preview-Warning": "true" } });
    await surface.client.send("Page.navigate", { url: preview.browserOrigin });
    const browser = surface;
    return {
      surface: browser,
      async read() {
        try {
          return await evaluateOnSurface(browser, async () => {
            const base = localStorage.getItem("openwork.server.urlOverride") ?? "";
            const token = localStorage.getItem("openwork.server.token") ?? "";
            const hostTokenPresent = Boolean(localStorage.getItem("openwork.server.hostToken"));
            const expectedBase = `${location.origin}/api/openwork`;
            const client = await fetch("/@vite/client", { signal: AbortSignal.timeout(10000) });
            const clientSource = await client.text();
            const source = await fetch("/src/app/lib/openwork-server.ts", { signal: AbortSignal.timeout(10000) });
            const appSource = await source.text();
            const sourceOriginFree = source.ok && !clientSource.includes(location.hostname) && !appSource.includes(location.hostname);
            const relativeBackend = /"VITE_OPENWORK_URL"\s*:\s*"\/api\/openwork"/.test(appSource);
            const wsToken = clientSource.match(/\bwsToken\s*=\s*"([a-zA-Z0-9_-]+)"/)?.[1];
            const webSocket = wsToken ? await new Promise<boolean>((done) => {
              const socket = new WebSocket(`${location.origin.replace(/^https:/, "wss:")}/?token=${wsToken}`, "vite-hmr");
              const timer = setTimeout(() => finish(false), 10000);
              const finish = (opened: boolean) => {
                clearTimeout(timer);
                socket.onopen = null;
                socket.onerror = null;
                socket.close();
                done(opened);
              };
              socket.onopen = () => finish(true);
              socket.onerror = () => finish(false);
            }) : false;
            const html = await fetch("/", { signal: AbortSignal.timeout(10000) });
            const health = await fetch("/api/openwork/health", { signal: AbortSignal.timeout(10000) });
            const unauthenticated = await fetch("/api/openwork/workspaces", { signal: AbortSignal.timeout(10000) });
            const headers = { Authorization: `Bearer ${token}` };
            const authenticated = await fetch("/api/openwork/workspaces", { headers, signal: AbortSignal.timeout(10000) });
            const hostOnly = await fetch("/api/openwork/approvals", { headers, signal: AbortSignal.timeout(10000) });
            const workspaces: unknown = authenticated.ok ? await authenticated.json() : null;
            const hasWorkspace = typeof workspaces === "object" && workspaces !== null && "items" in workspaces
              && Array.isArray(workspaces.items) && workspaces.items.length > 0;
            const text = document.body?.innerText ?? "";
            const screenshotSafe = ![text, location.hash, ...Array.from(document.querySelectorAll("input")).map((input) => input.value)]
              .some((value) => value.includes(location.hostname) || (token.length > 0 && value.includes(token)));
            const rendered = document.querySelectorAll("button, input, textarea").length > 0
              && text.length > 30 && !document.querySelector("vite-error-overlay");
            return {
              externalHttps: location.protocol === "https:" && !["localhost", "127.0.0.1"].includes(location.hostname),
              sameOriginBackend: base === expectedBase, sourceOriginFree, relativeBackend,
              tokenPresent: token.length > 0, hostTokenPresent, rendered, screenshotSafe, webSocket,
              html: html.status, htmlHasVite: (await html.text()).includes("/@vite/client"), asset: client.status,
              health: health.status, unauthenticated: unauthenticated.status, authenticated: authenticated.status,
              hostOnly: hostOnly.status, hasWorkspace,
            };
          }, { timeoutMs: 75000, reattachAttempts: 0 });
        } catch {
          throw new Error("Private app-web browser witness failed; sensitive browser details withheld.");
        }
      },
      async [Symbol.asyncDispose]() { await browser.stop(); },
    };
  } catch {
    await surface?.stop().catch(() => undefined);
    throw new Error("Private app-web preview witness setup failed; sensitive connection details withheld.");
  }
}
