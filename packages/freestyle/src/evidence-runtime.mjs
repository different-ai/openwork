import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { openSync, closeSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { createServer, request } from "node:http";
import { bootAcmeWeb } from "/workspace/worlds/acme-web.ts";
import { chrome, localHost } from "/workspace/evals/packages/hosts/src/index.ts";
import { signInDesktopAs, selectModel, waitUntilInteractive, evalIn } from "/workspace/evals/packages/behaviors/src/index.ts";
import { browserScript } from "/workspace/evals/packages/cdp/src/index.ts";

const root = "/opt/openwork-preview";
process.env.OPENWORK_WORLD_PLACE = "local";
process.env.OPENWORK_EVAL_DEN_API_PREPARED = "1";
process.env.pnpm_config_verify_deps_before_run = "false";
process.env.OPENWORK_EVAL_MYSQL_URL = "mysql://root:password@127.0.0.1:3306";
process.env.DATABASE_REDIS_URL = "redis://127.0.0.1:6379";
process.env.DISPLAY = ":99";
process.env.CHROME_BIN = "/opt/openwork-preview/evidence-chrome";
process.env.GOMEMLIMIT = "512MiB";
const stack = new AsyncDisposableStack();
function service(command, args, name) {
  const fd = openSync(`${root}/${name}.log`, "a", 0o600);
  const child = spawn(command, args, { env: process.env, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  stack.defer(() => child.kill("SIGTERM"));
}
async function ready(check, label) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) { try { if (await check()) return; } catch {} await delay(250); }
  throw new Error(`${label} did not become ready`);
}
try {
  await mkdir("/tmp/.X11-unix", { recursive: true, mode: 0o1777 });
  service("Xvfb", [":99", "-screen", "0", "1440x900x24", "-nolisten", "tcp"], "evidence-display");
  await ready(() => access("/tmp/.X11-unix/X99").then(() => true), "display");
  service("x11vnc", ["-display", ":99", "-localhost", "-rfbport", "5900", "-forever", "-shared", "-nopw", "-quiet"], "evidence-vnc");
  service("websockify", ["--web", "/usr/share/novnc", "127.0.0.1:6080", "127.0.0.1:5900"], "evidence-viewer");
  let held = false;
  let complete = false;
  let streamCount = 0;
  let release;
  const world = await bootAcmeWeb(stack, undefined, {
    trigger: "Show a checkpoint demonstration",
    prefix: "This response is paused at the saved checkpoint. ",
    suffix: "The same response continued from the saved browser.",
    async hold() { streamCount++; held = true; await new Promise((resolve) => { release = resolve; }); held = false; complete = true; },
  });
  const browser = stack.use(await chrome({ host: localHost({ repoRoot: "/workspace", log: () => {} }), name: "evidence-web", startUrl: world.web.manifest.webUrl, headless: false }));
  await waitUntilInteractive(browser);
  await signInDesktopAs(browser, world.den.ref, world.den.admin);
  // bootAcmeWeb already owns a fresh workspace. The desktop workspace helper
  // waits on hash routes; app-web uses pathname routes and needs no second one.
  await evalIn(browser, browserScript((value) => { localStorage.setItem("openwork.defaultModel", value); window.dispatchEvent(new Event("openwork.defaultModelChanged")); }, [`${world.model.providerId}/${world.model.modelId}`]));
  await selectModel(browser, world.model.modelName, { provider: "Acme AI Gateway" });
  // The viewer keeps the saved Chromium tab. A direct app link would open a new
  // document and is deliberately not presented as an exact checkpoint restore.
  const viewer = createServer((req, res) => {
    if (req.url === "/__evidence/state") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ held, complete, streamCount })); return; }
    if (req.url === "/__evidence/continue" && req.method === "POST") { release?.(); res.end("continued"); return; }
    if (req.url === "/") {
      res.setHeader("content-type", "text/html");
      res.end(`<!doctype html><html><head><title>Saved OpenWork browser</title><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;font:13px system-ui;background:Canvas;color:CanvasText"><header style="display:flex;align-items:center;gap:16px;padding:12px"><strong>Saved browser</strong><button id="continue" hidden>Continue response</button><span id="state" role="status"></span></header><iframe title="Saved browser (noVNC)" src="/vnc.html?autoconnect=1&resize=scale" style="border:0;width:100%;height:calc(100vh - 55px)"></iframe><script>
const button=document.getElementById('continue');const label=document.getElementById('state');
async function state(){try{const s=await fetch('/__evidence/state').then(r=>r.json());button.hidden=!s.held;label.textContent=s.held?'Response paused at checkpoint':s.complete?'Response continued':'';}catch{label.textContent='Connection lost. Reopen this checkpoint from its report.';}}
button.onclick=async()=>{button.disabled=true;try{await fetch('/__evidence/continue',{method:'POST'});await state();}finally{button.disabled=false;}};state();setInterval(state,1000);
</script></body></html>`);
      return;
    }
    const upstream = request({ hostname: "127.0.0.1", port: 6080, path: req.url, method: req.method }, (response) => { res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res); });
    upstream.on("error", () => { res.writeHead(502).end(); }); req.pipe(upstream);
  });
  viewer.on("upgrade", (req, socket, head) => {
    const upstream = request({ hostname: "127.0.0.1", port: 6080, path: req.url, headers: req.headers });
    upstream.on("upgrade", (response, peer, upstreamHead) => {
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`);
      if (head.length) peer.write(head); if (upstreamHead.length) socket.write(upstreamHead);
      socket.pipe(peer).pipe(socket); peer.on("error", () => socket.destroy()); socket.on("error", () => peer.destroy());
    });
    upstream.on("error", () => socket.destroy()); upstream.end();
  });
  await new Promise((resolve) => viewer.listen(6081, "127.0.0.1", resolve));
  await writeFile(`${root}/services.json`, JSON.stringify({ desktop: "http://127.0.0.1:6081", cdp: browser.handle.cdpUrl }), { mode: 0o600 });
  await writeFile(`${root}/evidence-ready`, "web-v1");
  await writeFile(`${root}/ready-world`, "ready");
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => { await stack.disposeAsync(); process.exit(0); });
  await new Promise(() => {});
} catch (error) {
  console.error(error);
  await writeFile(`${root}/failed-world`, "failed");
  await stack.disposeAsync(); process.exit(1);
}
