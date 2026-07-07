import { execFile } from "node:child_process";
import { createServer } from "node:https";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "desktop-fetch-os-trust";
const vo = await loadVoiceoverParagraphs(FLOW_ID);
const execFileAsync = promisify(execFile);

const state = {
  originalDeveloperMode: null,
  server: null,
  serverUrl: null,
  serverDir: null,
};

async function navigateToSettingsTab(ctx, tab) {
  const workspaceId = await ctx.eval("(window.location.hash.match(/\\/workspace\\/([^/]+)/) ?? [])[1] ?? ''");
  await ctx.navigateHash(workspaceId ? `/workspace/${workspaceId}/settings/${tab}` : `/settings/${tab}`);
  await ctx.waitFor(`window.location.hash.includes('/settings/${tab}')`, {
    timeoutMs: 30_000,
    label: `${tab} settings route`,
  });
  await ctx.waitFor("(document.body?.innerText ?? '').includes('Back to app')", {
    timeoutMs: 30_000,
    label: "settings surface mounted",
  });
}

async function closeStaleDialogs(ctx) {
  await ctx.eval(`(() => {
    const text = document.body?.innerText ?? "";
    if (!text.includes("Remote server details") && !text.includes("Create Workspace")) return false;
    const buttons = [...document.querySelectorAll('button')];
    const button = buttons.find((candidate) => (candidate.textContent ?? '').trim() === 'Cancel')
      ?? buttons.find((candidate) => (candidate.textContent ?? '').trim() === 'Close');
    button?.click();
    return Boolean(button);
  })()`);
  await ctx.eval("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
}

async function ensureDeveloperMode(ctx) {
  const current = await ctx.eval("window.localStorage.getItem('openwork.developerMode')");
  if (state.originalDeveloperMode === null) state.originalDeveloperMode = current;
  if (current === "1") return;

  await navigateToSettingsTab(ctx, "advanced");
  await ctx.waitForText("Developer mode", { timeoutMs: 30_000 });
  await ctx.eval(`(() => {
    const switchButton = [...document.querySelectorAll('button, [role="switch"]')]
      .find((candidate) => (candidate.getAttribute('aria-label') ?? candidate.textContent ?? '').includes('Developer mode'));
    if (!switchButton) throw new Error('Developer mode switch not found');
    switchButton.scrollIntoView({ block: 'center' });
    switchButton.click();
    return true;
  })()`);
  await ctx.waitFor("window.localStorage.getItem('openwork.developerMode') === '1'", {
    timeoutMs: 10_000,
    label: "developer mode enabled",
  });
}

async function restoreDeveloperMode(ctx) {
  if (state.originalDeveloperMode === null || state.originalDeveloperMode === "1") return;
  await navigateToSettingsTab(ctx, "advanced");
  await ctx.waitForText("Developer mode", { timeoutMs: 30_000 });
  await ctx.eval(`(() => {
    const switchButton = [...document.querySelectorAll('button, [role="switch"]')]
      .find((candidate) => (candidate.getAttribute('aria-label') ?? candidate.textContent ?? '').includes('Developer mode'));
    if (!switchButton) throw new Error('Developer mode switch not found');
    switchButton.scrollIntoView({ block: 'center' });
    switchButton.click();
    return true;
  })()`);
  await ctx.waitFor("window.localStorage.getItem('openwork.developerMode') !== '1'", {
    timeoutMs: 10_000,
    label: "developer mode restored",
  });
}

async function openCloudAccount(ctx) {
  await navigateToSettingsTab(ctx, "cloud-account");
  await ctx.waitFor("(document.body?.innerText ?? '').includes('OpenWork Cloud')", {
    timeoutMs: 30_000,
    label: "cloud account content",
  });
}

async function returnToApp(ctx) {
  const inSettings = await ctx.eval("(document.body?.innerText ?? '').includes('Back to app')");
  if (inSettings) {
    await ctx.clickText("Back to app", { selector: "button", timeoutMs: 10_000 });
  }
  await ctx.waitFor("(document.body?.innerText ?? '').includes('Add workspace')", {
    timeoutMs: 30_000,
    label: "session sidebar with Add workspace",
  });
}

async function startSelfSignedOpenworkServer() {
  if (state.serverUrl) return state.serverUrl;

  const dir = await mkdtemp(join(tmpdir(), "openwork-self-signed-"));
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  await execFileAsync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
    "-keyout",
    keyPath,
    "-out",
    certPath,
  ]);

  const key = await readFile(keyPath);
  const cert = await readFile(certPath);
  const server = createServer({ key, cert }, (request, response) => {
    if (request.url?.startsWith("/workspaces")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        workspaces: [{ id: "ws_self_signed", name: "Self-signed remote", path: "/srv/self-signed" }],
        selectedId: "ws_self_signed",
      }));
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  server.unref();
  state.server = server;
  state.serverDir = dir;
  state.serverUrl = `https://127.0.0.1:${server.address().port}`;
  return state.serverUrl;
}

async function stopSelfSignedOpenworkServer() {
  const server = state.server;
  state.server = null;
  state.serverUrl = null;
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  if (state.serverDir) {
    await rm(state.serverDir, { recursive: true, force: true });
    state.serverDir = null;
  }
}

function summarizeError(error) {
  if (!error || (typeof error !== "object" && typeof error !== "function")) return String(error);
  return {
    name: typeof error.name === "string" ? error.name : "",
    message: typeof error.message === "string" ? error.message : String(error),
    code: typeof error.code === "string" ? error.code : "",
    cause: error.cause ? summarizeError(error.cause) : null,
  };
}

async function nodeFetchFailure(url) {
  try {
    await fetch(`${url}/workspaces`);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: summarizeError(error) };
  }
}

async function visibleRemoteError(ctx) {
  return ctx.eval(`(() => {
    const lines = (document.body?.innerText ?? '').split(/\\n+/).map((line) => line.trim()).filter(Boolean);
    return lines.find((line) => /certificate|ERR_CERT|net::ERR_FAILED|fetch failed|OpenWork server is unavailable/i.test(line)) ?? '';
  })()`);
}

export default {
  id: FLOW_ID,
  title: "Desktop fetch uses OS trust plumbing and shows certificate failures clearly",
  kind: "user-facing",
  steps: [
    {
      name: "Cloud account opens without a generic fetch failure",
      run: async (ctx) => {
        await ctx.waitFor("Boolean(window.__openworkControl)", {
          timeoutMs: 60_000,
          label: "window.__openworkControl",
        });
        await closeStaleDialogs(ctx);

        await ctx.prove("The Cloud account settings surface opens cleanly", {
          claim: "Settings → Account renders the OpenWork Cloud account controls and does not show a generic fetch failure.",
          voiceover: vo[0],
          action: async () => {
            await ensureDeveloperMode(ctx);
            await openCloudAccount(ctx);
          },
          assert: async () => {
            await ctx.expectText("OpenWork Cloud");
            await ctx.expectText("Cloud control plane URL");
            await ctx.expectNoText("fetch failed");
          },
          screenshot: {
            name: "cloud-account-ready",
            requireText: ["OpenWork Cloud", "Cloud control plane URL"],
            rejectText: ["fetch failed", "Something went wrong"],
            hashIncludes: "/settings/cloud-account",
          },
        });
      },
    },
    {
      name: "Remote worker certificate failure is descriptive",
      run: async (ctx) => {
        const serverUrl = await startSelfSignedOpenworkServer();

        await ctx.prove("Connecting a worker with an untrusted certificate shows the certificate cause", {
          claim: "The Connect remote dialog keeps the user in context and shows a certificate-specific HTTPS failure instead of collapsing to a bare fetch failure.",
          voiceover: vo[1],
          action: async () => {
            await returnToApp(ctx);
            await closeStaleDialogs(ctx);
            await ctx.clickText("Add workspace", { selector: "button", timeoutMs: 30_000 });
            await ctx.clickText("Connect custom remote", { selector: "button", timeoutMs: 30_000 });
            await ctx.waitForText("Remote server details", { timeoutMs: 30_000 });
            await ctx.fill('input[placeholder="https://worker.example.com"]', serverUrl);
            await ctx.clickText("Connect remote", { selector: "button", timeoutMs: 10_000 });
            await ctx.waitFor(
              "(() => { const text = document.body?.innerText ?? ''; return text.toLowerCase().includes('certificate') || text.includes('ERR_CERT'); })()",
              { timeoutMs: 30_000, label: "certificate-specific remote connection error" },
            );
          },
          assert: async () => {
            const errorText = await visibleRemoteError(ctx);
            ctx.assert(/certificate|ERR_CERT/i.test(errorText), `Expected a certificate-specific error, got: ${errorText}`);
            ctx.assert(!/TypeError:\s*fetch failed$/i.test(errorText), `Remote error was still a bare fetch failure: ${errorText}`);
            ctx.assert(!errorText.includes("OpenWork server is unavailable"), `Remote error was swallowed into a generic availability message: ${errorText}`);
            ctx.output("self-signed-fetch-differential.json", JSON.stringify({
              selfSignedServer: serverUrl,
              visibleDesktopError: errorText,
              nodeUndiciFetch: await nodeFetchFailure(serverUrl),
            }, null, 2));
          },
          screenshot: {
            name: "remote-certificate-error",
            requireText: ["Remote server details", "ERR_CERT_AUTHORITY_INVALID"],
            rejectText: ["OpenWork server is unavailable", "TypeError: fetch failed"],
          },
        });
      },
    },
    {
      name: "Canceling returns the app to a healthy account page",
      run: async (ctx) => {
        await ctx.prove("After canceling, the app returns to normal account settings", {
          claim: "The failed certificate probe is recoverable: canceling the dialog and returning to Account shows the normal Cloud account controls again.",
          voiceover: vo[2],
          action: async () => {
            await ctx.clickText("Cancel", { selector: "button", timeoutMs: 10_000 });
            await ctx.waitFor("!(document.body?.innerText ?? '').includes('Remote server details')", {
              timeoutMs: 10_000,
              label: "remote dialog closed",
            });
            await stopSelfSignedOpenworkServer();
            await restoreDeveloperMode(ctx);
            await openCloudAccount(ctx);
          },
          assert: async () => {
            await ctx.expectText("OpenWork Cloud");
            await ctx.expectNoText("Remote server details");
            await ctx.expectNoText("fetch failed");
          },
          screenshot: {
            name: "cloud-account-recovered",
            requireText: ["OpenWork Cloud"],
            rejectText: ["Remote server details", "fetch failed", "Something went wrong"],
            hashIncludes: "/settings/cloud-account",
          },
        });
      },
    },
  ],
};
