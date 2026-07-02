import { execFile as execFileCallback } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const TOKEN = "fraimz-token";

const workspaceOne = { id: "ws_1", name: "Main", path: "/tmp/main" };
const workspaceTwo = { id: "ws_2", name: "Archive", displayName: "Archive", path: "/tmp/archive" };
const sessionAlpha = { id: "ses_alpha", title: "Alpha planning", time: { created: 100, updated: 300 } };
const sessionBeta = { id: "ses_beta", title: "Neon backlog", time: { created: 50, updated: 200 } };
const sessionArchive = { id: "ses_archive", title: "Archive decisions", time: { created: 10, updated: 100 } };

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function startMockOpenWorkServer() {
  const requests = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.push({ pathname: url.pathname, search: url.search, authorization: request.headers.authorization ?? null });

    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      json(response, 401, { message: "Unauthorized" });
      return;
    }

    if (url.pathname === "/workspaces") {
      json(response, 200, { items: [workspaceOne, workspaceTwo], workspaces: [workspaceOne, workspaceTwo] });
      return;
    }
    if (url.pathname === "/workspace/ws_1/sessions") {
      json(response, 200, { items: [sessionAlpha, sessionBeta] });
      return;
    }
    if (url.pathname === "/workspace/ws_2/sessions") {
      json(response, 200, { items: [sessionArchive] });
      return;
    }
    if (url.pathname === "/workspace/ws_1/sessions/ses_alpha") {
      json(response, 200, { item: sessionAlpha });
      return;
    }
    if (url.pathname === "/workspace/ws_1/sessions/ses_beta") {
      json(response, 200, { item: sessionBeta });
      return;
    }
    if (url.pathname === "/workspace/ws_2/sessions/ses_archive") {
      json(response, 200, { item: sessionArchive });
      return;
    }
    if (url.pathname === "/workspace/ws_1/sessions/ses_alpha/messages") {
      json(response, 200, {
        items: [
          {
            info: { id: "msg_assistant", role: "assistant", time: { created: 301 } },
            parts: [{ type: "text", text: "The launch checklist can wait." }],
          },
          {
            info: { id: "msg_user", role: "user", time: { created: 302 } },
            parts: [{ type: "text", text: "Please remember the raven launch checklist." }],
          },
        ],
      });
      return;
    }
    if (url.pathname === "/workspace/ws_1/sessions/ses_beta/messages") {
      json(response, 200, { items: [] });
      return;
    }
    if (url.pathname === "/workspace/ws_2/sessions/ses_archive/messages") {
      json(response, 200, {
        items: [
          {
            info: { id: "msg_old", role: "assistant", time: { created: 101 } },
            parts: [{ type: "text", text: "Ignored implementation note", ignored: true }],
          },
          {
            info: { id: "msg_latest", role: "assistant", time: { created: 102 } },
            parts: [{ type: "text", text: "We decided to ship the archive importer first." }],
          },
        ],
      });
      return;
    }

    json(response, 404, { message: "Not found" });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Mock OpenWork server did not bind a port."));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        requests,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

async function runInjectedSessionTools(baseUrl) {
  const script = `
    const { OpenWorkExtensionsPreview } = await import("./apps/server/src/opencode-plugins/openwork-extensions-preview.ts");
    const plugin = await OpenWorkExtensionsPreview();
    const search = JSON.parse(await plugin.tool.openwork_session_search.execute({ query: "raven launch", limit: 5, scanLimit: 10 }));
    const read = JSON.parse(await plugin.tool.openwork_session_read.execute({ sessionId: "ses_archive", count: 2 }));
    console.log(JSON.stringify({ search, read }));
  `;
  const { stdout } = await execFile("bun", ["--eval", script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OPENWORK_SERVER_URL: baseUrl,
      OPENWORK_SERVER_TOKEN: TOKEN,
    },
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(stdout.trim());
}

async function showProofPanel(ctx, title, rows) {
  await ctx.eval(
    `(() => {
      const id = "openwork-fraimz-past-chat-proof";
      document.getElementById(id)?.remove();
      const panel = document.createElement("section");
      panel.id = id;
      panel.style.cssText = [
        "position:fixed",
        "inset:24px",
        "z-index:2147483647",
        "background:#fff",
        "color:#111827",
        "border:2px solid #4f46e5",
        "border-radius:18px",
        "box-shadow:0 24px 80px rgba(15,23,42,.28)",
        "font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
        "padding:28px",
        "overflow:auto"
      ].join(";");
      const titleEl = document.createElement("h1");
      titleEl.textContent = ${JSON.stringify(title)};
      titleEl.style.cssText = "margin:0 0 18px;font-size:30px;line-height:1.1";
      panel.appendChild(titleEl);
      for (const row of ${JSON.stringify(rows)}) {
        const item = document.createElement("div");
        item.style.cssText = "margin:12px 0;padding:14px 16px;border:1px solid #d1d5db;border-radius:12px;background:#f9fafb";
        const label = document.createElement("div");
        label.textContent = row.label;
        label.style.cssText = "font-size:12px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#4f46e5;margin-bottom:6px";
        const value = document.createElement("div");
        value.textContent = row.value;
        value.style.cssText = "font-size:18px;font-weight:650;white-space:pre-wrap";
        item.appendChild(label);
        item.appendChild(value);
        panel.appendChild(item);
      }
      document.body.appendChild(panel);
      return document.body.innerText;
    })()`,
  );
}

export default {
  id: "past-chat-search-tool",
  title: "Injected tools can search and read past OpenWork chats",
  spec: "OpenWork injected tool surface for cross-session memory",
  steps: [
    {
      name: "Real app boots before tool proof",
      run: async (ctx) => {
        await ctx.prove("The real OpenWork app is running for frame proof", {
          action: async () => {
            await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000, label: "control API" });
            await ctx.waitFor("document.body.innerText.trim().length > 40", { label: "rendered app text" });
          },
          assert: async () => {
            const route = await ctx.eval("window.__openworkControl.snapshot().route");
            ctx.assert(typeof route === "string" && route.length > 0, "OpenWork route was not available.");
            ctx.log(`route: ${route}`);
          },
          screenshot: { name: "app-ready", rejectText: ["Something went wrong"] },
        });
      },
    },
    {
      name: "Injected search tool finds a past chat transcript match",
      run: async (ctx) => {
        const server = await startMockOpenWorkServer();
        try {
          const output = await runInjectedSessionTools(server.baseUrl);
          ctx.toolOutput = output;
          await ctx.prove("openwork_session_search returns a transcript hit from another chat", {
            action: async () => {
              const hit = output.search.results[0];
              await showProofPanel(ctx, "Past Chat Search Tool Proof", [
                { label: "Tool called", value: "openwork_session_search" },
                { label: "Query", value: output.search.query },
                { label: "Matched session", value: `${hit.workspaceId} / ${hit.sessionId}` },
                { label: "Match kind", value: `${hit.kind} (${hit.role})` },
                { label: "Snippet", value: `${hit.snippet.before}${hit.snippet.match}${hit.snippet.after}` },
              ]);
            },
            assert: async () => {
              const hit = output.search.results[0];
              ctx.assert(output.search.ok === true, "Search tool did not return ok: true.");
              ctx.assert(hit?.sessionId === "ses_alpha", "Search did not return ses_alpha as the first result.");
              ctx.assert(hit?.role === "user", "Search did not prefer the user's matching message.");
              ctx.assert(hit?.snippet?.match?.toLowerCase() === "raven launch", "Search snippet did not highlight the query.");
              ctx.assert(
                server.requests.some((request) => request.pathname === "/workspace/ws_1/sessions/ses_alpha/messages" && request.search === "?limit=400"),
                "Search did not load transcript messages through the OpenWork server API.",
              );
            },
            screenshot: { name: "session-search-hit", requireText: ["openwork_session_search", "raven launch", "ses_alpha"] },
          });
        } finally {
          await server.close();
        }
      },
    },
    {
      name: "Injected read tool retrieves another chat transcript",
      run: async (ctx) => {
        const output = ctx.toolOutput;
        await ctx.prove("openwork_session_read retrieves the referenced session transcript", {
          action: async () => {
            await showProofPanel(ctx, "Past Chat Read Tool Proof", [
              { label: "Tool called", value: "openwork_session_read" },
              { label: "Session", value: `${output.read.workspaceId} / ${output.read.sessionId}` },
              { label: "Title", value: output.read.title },
              { label: "Returned transcript", value: output.read.messages.map((message) => `${message.role}: ${message.text}`).join("\n") },
            ]);
          },
          assert: async () => {
            ctx.assert(output.read.ok === true, "Read tool did not return ok: true.");
            ctx.assert(output.read.workspaceId === "ws_2", "Read tool did not resolve ses_archive in ws_2.");
            ctx.assert(output.read.sessionId === "ses_archive", "Read tool returned the wrong session id.");
            ctx.assert(
              output.read.messages.some((message) => message.text === "We decided to ship the archive importer first."),
              "Read tool did not return the expected transcript text.",
            );
          },
          screenshot: { name: "session-read-transcript", requireText: ["openwork_session_read", "Archive decisions", "ship the archive importer first"] },
        });
      },
    },
  ],
};
