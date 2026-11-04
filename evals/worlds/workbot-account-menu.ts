import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import type { Place, Seed } from "@openwork/env";
import { chrome } from "@openwork/hosts";
import { accountMenuServer } from "../../ee/apps/workbot/test-fixtures/account-menu-server.ts";

async function bodyOf(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

/**
 * Workbot's real header avatar, host and /auth routes in Chrome, without Den, a runner or inference.
 * The first sign-out answers 503, as when Workbot can't be reached, so the menu's failure state is real.
 */
export async function workbotAccountMenu(_seed: Seed, { place }: { place: Place }) {
  const resources = new AsyncDisposableStack();
  const cacheDir = await mkdtemp(join(tmpdir(), "workbot-account-menu-vite-"));
  resources.defer(() => rm(cacheDir, { recursive: true, force: true }));
  try {
    const entry = fileURLToPath(new URL("../../ee/apps/workbot/test-fixtures/account-menu.tsx", import.meta.url));
    let server: ReturnType<typeof accountMenuServer> | undefined;
    let base = "";
    const logouts: number[] = [];
    const vite = await createServer({
      configFile: fileURLToPath(new URL("../../ee/apps/workbot/vite.config.ts", import.meta.url)),
      cacheDir,
      server: { host: "127.0.0.1", port: 0, strictPort: false },
      plugins: [{ name: "workbot-account-menu-fixture", configureServer(vite) {
        vite.middlewares.use(async (request, response, next) => {
          const url = request.url ?? "/";
          if (url === "/" || url.startsWith("/?")) {
            const html = await vite.transformIndexHtml(url, `<!doctype html><html><head><title>Workbot</title></head><body style="margin:0"><div id="root"></div><script type="module" src="/@fs/${entry}"></script></body></html>`);
            response.setHeader("content-type", "text/html"); response.end(html);
            return;
          }
          if (!server || !(url.startsWith("/auth/") || url.startsWith("/fixture-den/"))) return next();
          if (url === "/auth/logout" && request.method === "POST") {
            logouts.push(Date.now());
            if (logouts.length === 1) { response.statusCode = 503; response.end(); return; }
          }
          const headers = new Headers();
          for (const [key, value] of Object.entries(request.headers)) if (typeof value === "string") headers.set(key, value);
          const answer = await server.app.fetch(new Request(`${base}${url}`, { method: request.method, headers, body: request.method === "GET" || request.method === "HEAD" ? undefined : await bodyOf(request) }));
          response.statusCode = answer.status;
          answer.headers.forEach((value, key) => { if (key !== "set-cookie") response.setHeader(key, value); });
          const cookies = answer.headers.getSetCookie();
          if (cookies.length) response.setHeader("set-cookie", cookies);
          response.end(Buffer.from(await answer.arrayBuffer()));
        });
      } }],
    });
    resources.defer(() => vite.close());
    await vite.listen();
    const url = vite.resolvedUrls?.local[0];
    if (!url) throw new Error("Workbot account menu fixture did not start");
    base = url.replace(/\/$/, "");
    server = accountMenuServer({ publicUrl: base });
    const live = server;
    const web = resources.use(await chrome({ host: place.host(), name: "workbot-account-menu", startUrl: `${base}/?menu=off`, headless: true }));
    return {
      web,
      /** The page with the account menu on or off for this person. */
      page: (menu: "on" | "off") => `${base}/?menu=${menu}`,
      logouts: () => logouts.length,
      chooserRequests: () => [...live.chooserRequests],
      async [Symbol.asyncDispose]() { await resources.disposeAsync(); },
    };
  } catch (error) { await resources.disposeAsync(); throw error; }
}
