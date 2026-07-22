import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "../runner/cdp.mjs";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

// Narration is loaded from the approved script (evals/voiceovers/share-diagnostics.md).
// The runner fails this flow if the narration drifts from that script.
const vo = await loadVoiceoverParagraphs("share-diagnostics");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pressCommandK(ctx) {
  const isMac = await ctx.eval("/Mac/i.test(navigator.platform)");
  const modifier = isMac
    ? { key: "Meta", code: "MetaLeft", windowsVirtualKeyCode: 91, modifiers: 4 }
    : { key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, modifiers: 2 };
  await ctx.client.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: modifier.key,
    code: modifier.code,
    windowsVirtualKeyCode: modifier.windowsVirtualKeyCode,
    modifiers: modifier.modifiers,
  });
  await ctx.client.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "k",
    code: "KeyK",
    windowsVirtualKeyCode: 75,
    modifiers: modifier.modifiers,
  });
  await ctx.client.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "k",
    code: "KeyK",
    windowsVirtualKeyCode: 75,
    modifiers: modifier.modifiers,
  });
  await ctx.client.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: modifier.key,
    code: modifier.code,
    windowsVirtualKeyCode: modifier.windowsVirtualKeyCode,
  });
}

async function openPaletteWithQuery(ctx, query) {
  await pressCommandK(ctx);
  await ctx.waitFor("Boolean(document.querySelector('[data-slot=\"autocomplete-input\"]'))", {
    timeoutMs: 15_000,
    label: "command palette input",
  });
  await ctx.fill('[data-slot="autocomplete-input"]', query);
}

async function waitForCommandItem(ctx, text) {
  await ctx.waitFor(
    `(() => [...document.querySelectorAll('[data-slot="command-item"]')].some((el) => (el.textContent ?? '').includes(${JSON.stringify(text)})))()`,
    { timeoutMs: 15_000, label: `command item ${text}` },
  );
}

async function clickCommandItem(ctx, text) {
  await waitForCommandItem(ctx, text);
  const clicked = await ctx.eval(`(() => {
    const item = [...document.querySelectorAll('[data-slot="command-item"]')]
      .find((el) => (el.textContent ?? '').includes(${JSON.stringify(text)}));
    if (!item) return false;
    item.scrollIntoView({ block: 'center' });
    item.click();
    return true;
  })()`);
  ctx.assert(clicked === true, `Could not click command item: ${text}`);
}

function assertTopLevelDiagnosticsKeys(ctx, value, label) {
  ctx.assert(value && typeof value === "object" && !Array.isArray(value), `${label} is not an object`);
  for (const key of ["capturedAt", "openworkServer", "app", "opencodeEngine", "developerLogs"]) {
    ctx.assert(Object.prototype.hasOwnProperty.call(value, key), `${label} missing ${key}`);
  }
}

async function browserClient(ctx) {
  if (!ctx.cdpBaseUrl) return null;
  const response = await fetch(`${ctx.cdpBaseUrl.replace(/\/$/, "")}/json/version`);
  if (!response.ok) return null;
  const version = await response.json();
  if (!version.webSocketDebuggerUrl) return null;
  const base = new URL(ctx.cdpBaseUrl);
  const ws = new URL(version.webSocketDebuggerUrl);
  ws.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  ws.hostname = base.hostname;
  ws.port = base.port;
  return connect(ws.toString());
}

async function allowDownloads(ctx, downloadPath) {
  const failures = [];
  try {
    await ctx.client.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath });
    ctx.log("Downloads enabled with Browser.setDownloadBehavior on page session.");
    return;
  } catch (error) {
    failures.push(`page Browser.setDownloadBehavior: ${error.message}`);
  }
  try {
    await ctx.client.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath });
    ctx.log("Downloads enabled with Page.setDownloadBehavior on page session.");
    return;
  } catch (error) {
    failures.push(`page Page.setDownloadBehavior: ${error.message}`);
  }
  const browser = await browserClient(ctx);
  if (browser) {
    try {
      await browser.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath });
      ctx.log("Downloads enabled with Browser.setDownloadBehavior on browser session.");
      return;
    } catch (error) {
      failures.push(`browser Browser.setDownloadBehavior: ${error.message}`);
    } finally {
      browser.close();
    }
  }
  throw new Error(`Could not enable downloads: ${failures.join("; ")}`);
}

async function waitForDiagnosticsDownload(downloadPath) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const entries = await readdir(downloadPath);
    const filename = entries.find((entry) => /^openwork-diagnostics-.*\.json$/.test(entry));
    if (filename) return join(downloadPath, filename);
    await sleep(250);
  }
  throw new Error(`Timed out waiting for diagnostics JSON in ${downloadPath}`);
}

export default {
  id: "share-diagnostics",
  title: "Users can share sanitized diagnostics from the command palette",
  kind: "user-facing",
  steps: [
    {
      name: "Frame 1",
      run: async (ctx) => {
        await ctx.prove("Copy diagnostics is available from Cmd/Ctrl+K search", {
          voiceover: vo[0],
          action: async () => {
            await ctx.waitFor("Boolean(window.__openworkControl)", {
              timeoutMs: 60_000,
              label: "control API",
            });
            await openPaletteWithQuery(ctx, "logs");
          },
          assert: async () => {
            await waitForCommandItem(ctx, "Copy diagnostics");
            await ctx.expectText("Copy diagnostics");
          },
          screenshot: { name: "frame-1", requireText: ["Copy diagnostics"] },
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await ctx.prove("Copy diagnostics puts a sanitized bundle on the clipboard", {
          voiceover: vo[1],
          action: async () => {
            await clickCommandItem(ctx, "Copy diagnostics");
          },
          assert: async () => {
            await ctx.waitForText("Diagnostics copied", { timeoutMs: 15_000 });
            const text = await ctx.eval("navigator.clipboard.readText()", { awaitPromise: true });
            ctx.assert(typeof text === "string" && text.trim().startsWith("{"), "Clipboard does not contain diagnostics JSON");
            const parsed = JSON.parse(text);
            assertTopLevelDiagnosticsKeys(ctx, parsed, "clipboard bundle");
            ctx.diagnosticsBundleJson = text;
            ctx.diagnosticsBundle = parsed;
          },
          screenshot: { name: "frame-2", requireText: ["Diagnostics copied"] },
        });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        await ctx.prove("Export diagnostics saves the same kind of bundle as a JSON file", {
          voiceover: vo[2],
          action: async () => {
            ctx.diagnosticsDownloadDir = await mkdtemp(join(tmpdir(), "openwork-diagnostics-"));
            await allowDownloads(ctx, ctx.diagnosticsDownloadDir);
            await openPaletteWithQuery(ctx, "logs");
            await clickCommandItem(ctx, "Export diagnostics");
          },
          assert: async () => {
            await ctx.waitForText("Diagnostics exported", { timeoutMs: 15_000 });
            const filePath = await waitForDiagnosticsDownload(ctx.diagnosticsDownloadDir);
            const text = await readFile(filePath, "utf8");
            const parsed = JSON.parse(text);
            assertTopLevelDiagnosticsKeys(ctx, parsed, "exported bundle");
            ctx.exportedDiagnosticsPath = filePath;
            ctx.exportedDiagnosticsBundle = parsed;
          },
          screenshot: { name: "frame-3", requireText: ["Diagnostics exported"] },
        });
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        await ctx.prove("Diagnostics record token presence without exposing token values", {
          voiceover: vo[3],
          action: async () => {
            await openPaletteWithQuery(ctx, "logs");
          },
          assert: async () => {
            const bundleString = ctx.diagnosticsBundleJson;
            ctx.assert(typeof bundleString === "string" && bundleString.includes('"tokenPresent"'), "Bundle does not record tokenPresent");
            const bundle = JSON.parse(bundleString);
            const secrets = await ctx.eval(`(async () => {
              const invoke = window.__OPENWORK_ELECTRON__?.invokeDesktop;
              const serverInfo = invoke ? await invoke('openworkServerInfo').catch(() => null) : null;
              const engineInfo = invoke ? await invoke('engineInfo').catch(() => null) : null;
              return {
                serverRunning: Boolean(serverInfo?.running),
                settingsToken: window.localStorage.getItem('openwork.server.token') ?? '',
                settingsHostToken: window.localStorage.getItem('openwork.server.hostToken') ?? '',
                clientToken: typeof serverInfo?.clientToken === 'string' ? serverInfo.clientToken : '',
                ownerToken: typeof serverInfo?.ownerToken === 'string' ? serverInfo.ownerToken : '',
                hostToken: typeof serverInfo?.hostToken === 'string' ? serverInfo.hostToken : '',
                opencodePassword: typeof engineInfo?.opencodePassword === 'string' ? engineInfo.opencodePassword : '',
              };
            })()`, { awaitPromise: true });
            const secretValues = [
              secrets.settingsToken,
              secrets.settingsHostToken,
              secrets.clientToken,
              secrets.ownerToken,
              secrets.hostToken,
              secrets.opencodePassword,
            ].filter((value) => typeof value === "string" && value.trim().length >= 4);
            for (const secret of secretValues) {
              ctx.assert(!bundleString.includes(secret), `Bundle leaked secret value: ${secret}`);
            }
            if (secrets.serverRunning) {
              ctx.assert(secretValues.length > 0, "Expected at least one live server secret while the local server is running");
            }
            if (secretValues.length === 0) {
              ctx.assert(bundle.openworkServer?.settings?.tokenPresent === false, "tokenPresent should be false when no real token values are present");
            }
            await waitForCommandItem(ctx, "Copy diagnostics");
          },
          screenshot: { name: "frame-4", requireText: ["Copy diagnostics"] },
        });
      },
    },
  ],
};
