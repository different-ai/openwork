// Open any App's own MCP server in the standard reference MCP Apps host.
//
//   node evals/fixtures/standard-mcp-app-host-serve.ts --url <App MCP URL> [--header "Name: value"]... [--port 4455]
//
// The host page is the same one the mcp-app-servers E2E journey drives. This
// local server forwards its JSON-RPC to the App URL with the given headers and
// nothing else, so it shows what any compatible MCP Apps host would render.
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const appUrl = argv[argv.indexOf("--url") + 1];
if (!argv.includes("--url") || !appUrl) throw new Error("Pass --url <App MCP URL>.");
const port = argv.includes("--port") ? Number(argv[argv.indexOf("--port") + 1]) : 0;
const forwarded: Record<string, string> = {};
argv.forEach((value, index) => {
  if (value !== "--header") return;
  const header = argv[index + 1] ?? "";
  const split = header.indexOf(":");
  if (split > 0) forwarded[header.slice(0, split).trim()] = header.slice(split + 1).trim();
});

const appRequire = createRequire(new URL("../../apps/app/package.json", import.meta.url));
const { build } = await import(createRequire(appRequire.resolve("vite")).resolve("esbuild"));
const bundle = await build({
  entryPoints: [fileURLToPath(new URL("./standard-mcp-app-host.ts", import.meta.url))],
  bundle: true, write: false, platform: "browser", format: "esm", minify: true,
});
const script = String(bundle.outputFiles[0].text);
const html = await readFile(new URL("./standard-mcp-app-host.html", import.meta.url), "utf8");

const server = createServer((request, response) => {
  void (async () => {
    response.setHeader("cache-control", "no-store");
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (request.method === "GET" && path === "/app/") {
      response.setHeader("content-type", "text/html");
      response.end(html);
    } else if (request.method === "GET" && path === "/host.js") {
      response.setHeader("content-type", "text/javascript");
      response.end(script);
    } else if (request.method === "POST" && path === "/app/rpc") {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      const upstream = await fetch(appUrl, {
        method: "POST",
        headers: { ...forwarded, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body,
        signal: AbortSignal.timeout(90_000),
      });
      const raw = await upstream.text();
      const data = raw.split("\n").find((line) => line.startsWith("data:"));
      response.setHeader("content-type", "application/json");
      response.writeHead(upstream.ok ? 200 : 502);
      response.end(data ? data.slice(5) : raw);
    } else {
      response.writeHead(404).end();
    }
  })().catch((error: unknown) => {
    response.writeHead(502).end(error instanceof Error ? error.message : "The App MCP server could not be reached.");
  });
});
server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  const bound = address && typeof address === "object" ? address.port : port;
  console.log(`Reference MCP Apps host for ${appUrl}\nOpen http://127.0.0.1:${bound}/app/?tool=open_app\nPress Ctrl-C to stop.`);
});
