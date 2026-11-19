import { createServer } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { evaluate } from "@openwork/cdp";
import type { Place, Seed } from "@openwork/env";
import { chrome } from "@openwork/hosts";
import { buildGeneratedMcpApp } from "../../ee/apps/den-api/src/generated-artifact-view-builder.ts";
import { appStarter } from "../../ee/apps/den-api/src/mcp/app-authoring-starter.ts";
import { listen, close } from "./openwork-server-cli.ts";

/** Only the host is a fixture: both framed apps use the real compiler/runtime,
 * and theme changes travel over the SDK's AppBridge/PostMessageTransport. */
export async function generatedAppTheme(_seed: Seed, { place }: { place: Place }) {
  const resources = new AsyncDisposableStack();
  try {
    const starter = appStarter([]);
    const sources = {
      runtime: { reactSource: `export default function Checklist() {
        const [checked, setChecked] = React.useState(false);
        return <main><h2>Project checklist</h2><label><input type="checkbox" checked={checked} onChange={event => setChecked(event.target.checked)} />Review the report</label><button onClick={() => setChecked(true)}>Mark reviewed</button></main>;
      }`, cssSource: "body { margin: 0; } main { padding: 14px; } h2 { font-size: 18px; }" },
      starter,
    };
    const documents = new Map<string, string>();
    for (const [name, source] of Object.entries(sources)) {
      const compiled = await buildGeneratedMcpApp({ ...source, title: "Theme proof", description: null });
      if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
      documents.set(`/${name}.html`, compiled.html);
    }
    documents.set("/fallback.html", documents.get("/runtime.html")!);
    const denRequire = createRequire(new URL("../../ee/apps/den-api/package.json", import.meta.url));
    const { build } = await import(denRequire.resolve("esbuild"));
    const bundle = await build({
      entryPoints: [fileURLToPath(new URL("../fixtures/generated-app-theme-host.ts", import.meta.url))],
      bundle: true, write: false, platform: "browser", format: "esm", minify: true,
    });
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>App appearance</title>
      <style>:root{color-scheme:light;font:13px/1.5 system-ui}body{margin:20px}header{display:flex;gap:12px;align-items:center}iframe{width:100%;height:240px;border:0;margin-top:16px}h1{font-size:18px}</style></head>
      <body><header><h1>App appearance</h1><button id="light">Light</button><button id="dark">Dark</button><span id="status">light</span></header>
      <div id="apps"></div><script type="module" src="/host.js"></script></body></html>`;
    const server = createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      response.setHeader("Content-Type", path === "/host.js" ? "text/javascript" : "text/html");
      response.end(path === "/host.js" ? bundle.outputFiles[0].text : documents.get(path) ?? html);
    });
    const origin = await listen(server);
    resources.defer(() => close(server));
    const web = resources.use(await chrome({ host: place.host(), name: "generated-app-theme", startUrl: origin, headless: true }));
    return {
      web,
      appearance: () => evaluate(web.client, () => Array.from(document.querySelectorAll("iframe")).map(frame => {
        const doc = frame.contentDocument;
        const main = doc?.querySelector("main");
        if (!doc || !main) return null;
        const rootStyle = getComputedStyle(doc.documentElement);
        const mainStyle = getComputedStyle(main);
        const input = doc.querySelector("input");
        return {
          app: frame.dataset.app, ready: frame.dataset.ready, loads: Number(frame.dataset.loads),
          scheme: rootStyle.colorScheme, rootColor: rootStyle.color, rootBackground: rootStyle.backgroundColor,
          color: mainStyle.color, background: mainStyle.backgroundColor, font: mainStyle.fontFamily,
          checked: input?.checked ?? false,
          textToken: doc.documentElement.style.getPropertyValue("--color-text-primary"),
        };
      })),
      async [Symbol.asyncDispose]() { await resources.disposeAsync(); },
    };
  } catch (error) { await resources.disposeAsync(); throw error; }
}
