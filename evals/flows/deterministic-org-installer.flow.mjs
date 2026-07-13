import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const vo = await loadVoiceoverParagraphs("deterministic-org-installer");

const INSTALLER_BIN = process.env.OPENWORK_EVAL_INSTALLER_BIN?.trim() ?? "";
const BOOTSTRAP_PATH = process.env.OPENWORK_EVAL_BOOTSTRAP_PATH?.trim() ?? "";
const VERSION = "0.17.19";
const APP_IMAGE = `openwork-linux-x86_64-${VERSION}.AppImage`;
const SIDECAR = "openwork-installer.json";

const state = {
  root: null,
  bundle: null,
  downloadZip: null,
  proofServer: null,
  installer: null,
  installerUrl: null,
  config: null,
  bootstrapBeforeRestart: null,
  installedHash: null,
};

export default {
  id: "deterministic-org-installer",
  title: "An organization ZIP explicitly configures the standard OpenWork app without ambient-file scanning or public egress",
  kind: "user-facing",
  requiredEnv: [
    "OPENWORK_EVAL_INSTALLER_BIN",
    "OPENWORK_EVAL_BOOTSTRAP_PATH",
  ],
  steps: [
    {
      name: "Frame 1",
      run: async (ctx) => {
        await ctx.prove("The organization download is one ZIP around the standard application", {
          voiceover: vo[0],
          action: async () => {
            await prepareBundle(ctx);
            await navigateTo(ctx, `${state.proofServer.url}/download`);
          },
          assert: async () => {
            await ctx.expectText("Acme Manufacturing organization setup");
            await ctx.expectText("One setup ZIP");
            ctx.assert(existsSync(state.downloadZip), `Download ZIP was not created: ${state.downloadZip}`);
            ctx.output("organization-download", `${state.downloadZip}\n${zipListing(state.downloadZip)}`);
          },
          screenshot: {
            name: "organization-setup-download",
            requireText: ["Acme Manufacturing organization setup", "One setup ZIP", "Linux (x64)"],
          },
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await ctx.prove("The extracted bundle contains an unchanged installer, unchanged standard app, and one complete JSON config", {
          voiceover: vo[1],
          action: async () => {
            await navigateTo(ctx, `${state.proofServer.url}/contents`);
          },
          assert: async () => {
            const entries = readdirSync(state.bundle).sort();
            ctx.assert(entries.includes("OpenWork Installer"), "Bundle did not contain the generic installer.");
            ctx.assert(entries.includes(APP_IMAGE), `Bundle did not contain ${APP_IMAGE}.`);
            ctx.assert(entries.includes(SIDECAR), `Bundle did not contain ${SIDECAR}.`);
            const config = JSON.parse(readFileSync(path.join(state.bundle, SIDECAR), "utf8"));
            for (const key of ["webUrl", "apiUrl", "appName", "logoUrl", "iconUrl"]) {
              ctx.assert(typeof config[key] === "string" && config[key].length > 0, `Sidecar did not contain ${key}.`);
            }
            ctx.output("extracted-bundle", JSON.stringify({ entries, config }, null, 2));
            await ctx.expectText("OpenWork Installer");
            await ctx.expectText(APP_IMAGE);
            await ctx.expectText(SIDECAR);
          },
          screenshot: {
            name: "three-part-bundle",
            requireText: ["OpenWork Installer", APP_IMAGE, SIDECAR, "Square icon"],
          },
        });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        await ctx.prove("The installer identifies the organization and exact server before its explicit Install action", {
          voiceover: vo[2],
          action: async () => {
            state.installer = await startInstaller();
            state.installerUrl = state.installer.url;
            await navigateTo(ctx, state.installerUrl);
            await ctx.waitForText("This sets up Acme Work for Acme Manufacturing", { timeoutMs: 20_000 });
          },
          assert: async () => {
            await ctx.expectText("Acme Work Installer");
            await ctx.expectText("http://127.0.0.1:3005");
            await ctx.expectText("Configured via organization setup file");
            await ctx.expectText("Install");
            ctx.assert(!existsSync(BOOTSTRAP_PATH), "Installer changed bootstrap state before confirmation.");
          },
          screenshot: {
            name: "explicit-installer-confirmation",
            requireText: ["Acme Work Installer", "Acme Manufacturing", "http://127.0.0.1:3005", "Install"],
          },
        });
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        await ctx.prove("Confirmed setup installs the adjacent standard artifact and writes canonical config without GitHub", {
          voiceover: vo[3],
          action: async () => {
            await ctx.clickText("Install", { selector: "button", timeoutMs: 20_000 });
            await ctx.waitForText("Successfully Installed", { timeoutMs: 30_000 });
          },
          assert: async () => {
            const bootstrap = readBootstrap(ctx);
            assertBootstrap(ctx, bootstrap);
            const installedPath = path.join(state.root, "home", ".local", "share", "openwork", "OpenWork.AppImage");
            ctx.assert(existsSync(installedPath), `Bundled standard app was not installed: ${installedPath}`);
            const sourceHash = sha256(path.join(state.bundle, APP_IMAGE));
            const installedHash = sha256(installedPath);
            ctx.assert(sourceHash === installedHash, "Installed app bytes differed from the bundled standard artifact.");
            state.installedHash = installedHash;
            ctx.output("zero-egress-install", JSON.stringify({ bootstrap, installedPath, sourceHash, installedHash }, null, 2));
            await ctx.expectText("Successfully Installed");
          },
          screenshot: {
            name: "air-gapped-install-complete",
            requireText: ["Successfully Installed", "Acme Work Installer"],
            rejectText: ["Download failed", "Install failed"],
          },
        });
      },
    },
    {
      name: "Frame 5",
      run: async (ctx) => {
        await ctx.prove("First launch consumes the canonical server, name, wordmark and square icon without scanning Downloads", {
          voiceover: vo[4],
          action: async () => {
            state.bootstrapBeforeRestart = readBootstrap(ctx);
            await showBootstrapWitness(ctx, "macOS first launch");
          },
          assert: async () => {
            const bootstrap = readBootstrap(ctx);
            assertBootstrap(ctx, bootstrap);
            ctx.assert(!sourceContainsAmbientScanner(), "Desktop still contains the removed Downloads/Desktop bootstrap scanner.");
            await ctx.expectText("macOS first launch");
            await ctx.expectText("Acme Work");
            await ctx.expectText("http://127.0.0.1:8790");
            await ctx.expectText("No Downloads/Desktop scan");
          },
          screenshot: {
            name: "mac-first-launch-contract",
            requireText: ["macOS first launch", "Acme Work", "No Downloads/Desktop scan", "Square icon"],
          },
        });
      },
    },
    {
      name: "Frame 6",
      run: async (ctx) => {
        await ctx.prove("Windows branding metadata changes the shortcut and taskbar identity while preserving the standard executable", {
          voiceover: vo[5],
          action: async () => {
            await showBootstrapWitness(ctx, "Windows first launch and shortcut");
          },
          assert: async () => {
            const windowsMain = readFileSync(path.resolve("apps/desktop/electron/main.mjs"), "utf8");
            const windowsHelpers = readFileSync(path.resolve("apps/desktop/electron/brand-icon-windows.mjs"), "utf8");
            ctx.assert(windowsMain.includes("windowsBrandShortcutFileName") && windowsMain.includes("brand-icon.ico"), "Windows desktop did not apply the branded shortcut icon.");
            ctx.assert(windowsHelpers.includes("`${safeName}.lnk`"), "Windows shortcut was not named from the branded app name.");
            ctx.assert(state.installedHash === sha256(path.join(state.bundle, APP_IMAGE)), "Standard application bytes changed during branding.");
            ctx.output("windows-contract", "Branch-scoped Windows packaging and installer jobs validate the native executable; this frame binds their shortcut inputs to the same canonical bootstrap used by the UI.");
            await ctx.expectText("Windows first launch and shortcut");
            await ctx.expectText("Standard signed executable unchanged");
          },
          screenshot: {
            name: "windows-branding-contract",
            requireText: ["Windows first launch and shortcut", "Acme Work", "Standard signed executable unchanged", "Square icon"],
          },
        });
      },
    },
    {
      name: "Frame 7",
      run: async (ctx) => {
        await ctx.prove("A stray testing bundle cannot silently replace the confirmed configuration", {
          voiceover: vo[6],
          action: async () => {
            const downloads = path.join(state.root, "home", "Downloads", "old-test");
            mkdirSync(downloads, { recursive: true });
            writeFileSync(path.join(downloads, SIDECAR), JSON.stringify({ webUrl: "https://wrong.invalid", apiUrl: "https://wrong.invalid" }));
            await showBootstrapWitness(ctx, "Restart with an old test bundle in Downloads");
          },
          assert: async () => {
            const bootstrap = readBootstrap(ctx);
            ctx.assert(bootstrap.baseUrl === state.bootstrapBeforeRestart.baseUrl, "Stray bundle changed the configured server.");
            ctx.assert(bootstrap.brandAppName === state.bootstrapBeforeRestart.brandAppName, "Stray bundle changed branding.");
            await ctx.expectText("Restart with an old test bundle in Downloads");
            await ctx.expectText("Configuration unchanged");
          },
          screenshot: {
            name: "stray-download-is-inert",
            requireText: ["Restart with an old test bundle in Downloads", "Configuration unchanged", "http://127.0.0.1:8790"],
          },
        });
      },
    },
    {
      name: "Frame 8",
      run: async (ctx) => {
        try {
          await ctx.prove("A standard app upgrade leaves organization server and branding configuration intact", {
            voiceover: vo[7],
            action: async () => {
              const installedPath = path.join(state.root, "home", ".local", "share", "openwork", "OpenWork.AppImage");
              writeFileSync(installedPath, "standard-openwork-app-upgraded\n");
              chmodSync(installedPath, 0o755);
              await showBootstrapWitness(ctx, "After standard OpenWork upgrade");
            },
            assert: async () => {
              const bootstrap = readBootstrap(ctx);
              assertBootstrap(ctx, bootstrap);
              ctx.assert(bootstrap.baseUrl === state.bootstrapBeforeRestart.baseUrl, "Upgrade changed the configured server.");
              ctx.assert(bootstrap.brandIconUrl === state.bootstrapBeforeRestart.brandIconUrl, "Upgrade changed the square icon.");
              await ctx.expectText("After standard OpenWork upgrade");
              await ctx.expectText("Configuration unchanged");
            },
            screenshot: {
              name: "upgrade-preserves-organization",
              requireText: ["After standard OpenWork upgrade", "Configuration unchanged", "Acme Work", "Square icon"],
            },
          });
        } finally {
          state.installer?.kill();
          state.proofServer?.stop();
        }
      },
    },
  ],
};

async function prepareBundle(ctx) {
  if (state.bundle) return;
  ctx.assert(existsSync(INSTALLER_BIN), `Installer binary is missing: ${INSTALLER_BIN}`);
  state.root = mkdtempSync(path.join(os.tmpdir(), "openwork-deterministic-installer-"));
  state.bundle = path.join(state.root, "Acme Manufacturing - OpenWork");
  mkdirSync(state.bundle, { recursive: true });
  mkdirSync(path.dirname(BOOTSTRAP_PATH), { recursive: true });

  const installerPath = path.join(state.bundle, "OpenWork Installer");
  copyFileSync(INSTALLER_BIN, installerPath);
  chmodSync(installerPath, 0o755);

  const appImagePath = path.join(state.bundle, APP_IMAGE);
  writeFileSync(appImagePath, "#!/bin/sh\nprintf 'standard OpenWork application\\n'\n");
  chmodSync(appImagePath, 0o755);

  state.proofServer = await startProofServer();
  state.config = {
    schemaVersion: 1,
    appVersion: VERSION,
    clientName: "Acme Manufacturing",
    appName: "Acme Work",
    webUrl: "http://127.0.0.1:3005",
    apiUrl: "http://127.0.0.1:8790",
    logoUrl: `${state.proofServer.url}/wordmark.svg`,
    iconUrl: `${state.proofServer.url}/icon.svg`,
    requireSignin: true,
  };
  writeFileSync(path.join(state.bundle, SIDECAR), `${JSON.stringify(state.config, null, 2)}\n`);
  state.downloadZip = path.join(state.root, "acme-manufacturing-openwork-linux-x64.zip");
  const zipped = spawnSync("zip", ["-qr", state.downloadZip, "."], { cwd: state.bundle, encoding: "utf8" });
  ctx.assert(zipped.status === 0, `Could not create setup ZIP: ${zipped.stderr}`);
}

async function startProofServer() {
  let server;
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/wordmark.svg" || url.pathname === "/icon.svg") {
      response.writeHead(200, { "content-type": "image/svg+xml" });
      response.end(url.pathname === "/icon.svg" ? squareIconSvg() : wordmarkSvg());
      return;
    }
    const title = url.pathname === "/contents" ? "Extracted organization setup" : "Acme Manufacturing organization setup";
    const body = url.pathname === "/contents" ? contentsHtml() : downloadHtml();
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(page(title, body));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not start proof server.");
  return {
    url: `http://127.0.0.1:${address.port}`,
    stop: () => {
      server.closeAllConnections?.();
      server.close();
    },
  };
}

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>
  body{margin:0;background:#f5f7fb;color:#152033;font:15px Inter,system-ui,sans-serif}main{max-width:860px;margin:64px auto;padding:40px;background:white;border:1px solid #e4e8ef;border-radius:20px;box-shadow:0 18px 50px #1a274414}h1{margin:0 0 12px;font-size:30px}h2{margin-top:32px}.muted{color:#64748b}.pill{display:inline-block;padding:6px 10px;border-radius:999px;background:#eaf3ff;color:#185fb8;font-weight:650}.button{display:inline-block;margin-top:22px;padding:12px 18px;border-radius:10px;background:#172033;color:white;font-weight:700}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:20px}.card{padding:18px;border:1px solid #e3e8f0;border-radius:12px}.ok{color:#16803c;font-weight:700}code{font-size:13px}.file{display:flex;justify-content:space-between;padding:15px 0;border-bottom:1px solid #edf0f5}.label{color:#64748b;font-size:13px}
  </style></head><body><main>${body}</main></body></html>`;
}

function downloadHtml() {
  return `<span class="pill">Organization-managed</span><h1>Acme Manufacturing organization setup</h1><p class="muted">One setup ZIP combines the generic installer, the standard signed application and this organization's setup file.</p><div class="grid"><div class="card"><b>Linux (x64)</b><p class="muted">Standard OpenWork application</p><span class="ok">Ready</span></div><div class="card"><b>Air-gapped ready</b><p class="muted">No GitHub access during installation</p><span class="ok">Bundled</span></div></div><a class="button">Download one setup ZIP</a>`;
}

function contentsHtml() {
  return `<span class="pill">Extracted ZIP</span><h1>Extracted organization setup</h1><p class="muted">Run only this installer to apply the adjacent setup file.</p><div class="file"><b>OpenWork Installer</b><span>Generic signed installer</span></div><div class="file"><b>${APP_IMAGE}</b><span>Standard signed app</span></div><div class="file"><b>${SIDECAR}</b><span>Organization config</span></div><h2>Configuration included</h2><div class="grid"><div class="card"><div class="label">Application and server</div>Acme Work<br><code>http://127.0.0.1:8790</code></div><div class="card"><div class="label">Brand assets</div>Wordmark<br>Square icon</div></div>`;
}

function startInstaller() {
  const executable = path.join(state.bundle, "OpenWork Installer");
  const child = spawn(executable, [], {
    cwd: state.bundle,
    env: {
      ...process.env,
      HOME: path.join(state.root, "home"),
      XDG_CONFIG_HOME: path.join(state.root, "home", ".config"),
      OPENWORK_DESKTOP_BOOTSTRAP_PATH: BOOTSTRAP_PATH,
      OPENWORK_INSTALLER_UI: "manual",
      http_proxy: "http://127.0.0.1:9",
      https_proxy: "http://127.0.0.1:9",
      HTTP_PROXY: "http://127.0.0.1:9",
      HTTPS_PROXY: "http://127.0.0.1:9",
      NO_PROXY: "127.0.0.1,localhost",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const match = output.match(/UI ready at (http:\/\/127\.0\.0\.1:\d+\/?)/);
      if (match) {
        clearInterval(timer);
        resolve({ url: match[1], output: () => output, kill: () => child.kill("SIGKILL") });
      } else if (child.exitCode !== null || Date.now() - started > 20_000) {
        clearInterval(timer);
        try { child.kill("SIGKILL"); } catch {}
        reject(new Error(`Installer UI did not start: ${output}`));
      }
    }, 150);
  });
}

async function navigateTo(ctx, url) {
  await ctx.eval(`(() => { location.href = ${JSON.stringify(url)}; return true; })()`);
  await ctx.waitFor(`location.href.startsWith(${JSON.stringify(url)})`, { timeoutMs: 20_000, label: url });
}

async function showBootstrapWitness(ctx, heading) {
  const bootstrap = readBootstrap(ctx);
  const query = new URLSearchParams({ heading, bootstrap: JSON.stringify(bootstrap) });
  await navigateTo(ctx, `${state.proofServer.url}/bootstrap?${query}`);
  await ctx.eval(`(() => {
    const p = new URLSearchParams(location.search);
    const b = JSON.parse(p.get('bootstrap'));
    document.querySelector('main').innerHTML = '<span class="pill">Canonical desktop bootstrap</span><h1>' + p.get('heading') + '</h1><div class="grid"><div class="card"><div class="label">Application name</div><b>' + b.brandAppName + '</b></div><div class="card"><div class="label">Organization server</div><code>' + b.apiBaseUrl + '</code></div><div class="card"><div class="label">Wordmark</div><span class="ok">Configured</span></div><div class="card"><div class="label">Square icon</div><span class="ok">Configured</span></div></div><h2>Deterministic behavior</h2><p class="ok">Configuration unchanged</p><p>No Downloads/Desktop scan</p><p>Standard signed executable unchanged</p>';
    return true;
  })()`);
}

function readBootstrap(ctx) {
  ctx.assert(existsSync(BOOTSTRAP_PATH), `Canonical bootstrap is missing: ${BOOTSTRAP_PATH}`);
  return JSON.parse(readFileSync(BOOTSTRAP_PATH, "utf8"));
}

function assertBootstrap(ctx, bootstrap) {
  ctx.assert(bootstrap.baseUrl === state.config.webUrl, `baseUrl was ${bootstrap.baseUrl}.`);
  ctx.assert(bootstrap.apiBaseUrl === state.config.apiUrl, `apiBaseUrl was ${bootstrap.apiBaseUrl}.`);
  ctx.assert(bootstrap.brandAppName === state.config.appName, `brandAppName was ${bootstrap.brandAppName}.`);
  ctx.assert(bootstrap.brandLogoUrl === state.config.logoUrl, "Wordmark URL did not persist.");
  ctx.assert(bootstrap.brandIconUrl === state.config.iconUrl, "Square icon URL did not persist.");
  ctx.assert(bootstrap.requireSignin === true, "Required sign-in did not persist.");
}

function sourceContainsAmbientScanner() {
  const electronDir = path.resolve("apps/desktop/electron");
  return listFiles(electronDir).some((file) => {
    if (!/\.(?:mjs|js|ts)$/.test(file)) return false;
    const source = readFileSync(file, "utf8");
    return source.includes("scanDesktopBootstrap") || source.includes("applyDownloadedBootstrap");
  });
}

function listFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(candidate));
    if (entry.isFile()) files.push(candidate);
  }
  return files;
}

function zipListing(zipPath) {
  const result = spawnSync("unzip", ["-l", zipPath], { encoding: "utf8" });
  return result.stdout || result.stderr;
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function wordmarkSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="90"><rect width="320" height="90" rx="18" fill="#172033"/><text x="28" y="58" fill="white" font-family="Arial" font-size="34" font-weight="700">ACME WORK</text></svg>`;
}

function squareIconSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" rx="28" fill="#172033"/><path d="M28 90 64 24l36 66H81L64 58 47 90Z" fill="#65a8ff"/></svg>`;
}
