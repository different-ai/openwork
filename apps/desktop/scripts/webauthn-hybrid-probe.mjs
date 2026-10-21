// Probe whether this Electron can offer passkeys from a phone (WebAuthn hybrid
// transport) to the built-in browser, using OpenWork's real integration
// module. Run with the Electron you want to check:
//
//   pnpm --filter @openwork/desktop exec electron ./scripts/webauthn-hybrid-probe.mjs [--timeout-ms=200000] [--sheet=out.png]
//
// It loads a localhost page in a hidden window with a throwaway partition,
// turns the integration on, and asks for a passkey that only a phone could
// hold. On an Electron with the hybrid events, Chromium's own `FIDO:/` payload
// arrives and the result says so (scan it with a real phone to finish). On
// stock Electron nothing arrives and the request fails at Chromium's minimum
// timeout (3 minutes) without any UI. `--sheet` also captures the sheet's
// layout from a placeholder payload that no phone accepts, for design review.
import http from "node:http";
import { writeFileSync } from "node:fs";
import { app, BrowserWindow, session } from "electron";
import { createBrowserPhonePasskeys, PHONE_PASSKEY_REQUEST_EVENT } from "../electron/browser-phone-passkeys.mjs";
import { renderPhonePasskeySheetHtml } from "../electron/phone-passkey-sheet.mjs";

const arg = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const timeoutMs = Number(arg("timeout-ms") ?? 200_000);
const sheetPath = arg("sheet");
const result = { electron: process.versions.electron, chrome: process.versions.chrome, platform: process.platform, sheetsOpened: [] };

async function captureSheetLayout(path) {
  const win = new BrowserWindow({ show: false, width: 360, height: 432, webPreferences: { javascript: false, sandbox: true, partition: "probe-sheet", offscreen: true } });
  const placeholder = `FIDO:/${"0".repeat(200)}`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(renderPhonePasskeySheetHtml({ relyingPartyId: "example.com", requestType: "get", origin: "https://example.com", qrCode: placeholder, state: "waiting", canCancel: true }))}`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  writeFileSync(path, (await win.webContents.capturePage()).toPNG());
  win.destroy();
}

app.whenReady().then(async () => {
  const server = http.createServer((_request, response) => { response.setHeader("content-type", "text/html"); response.end("<!doctype html><title>probe</title>"); });
  await new Promise((resolve) => server.listen(0, "localhost", resolve));
  const probeSession = session.fromPartition(`probe-hybrid-${Date.now()}`);
  const win = new BrowserWindow({ show: false, webPreferences: { session: probeSession, sandbox: true, contextIsolation: true } });
  const tab = { tabId: "probe-tab" };
  const passkeys = createBrowserPhonePasskeys({
    getSession: () => probeSession,
    tabForFrame: (frame) => (frame && win.webContents.mainFrame === frame ? tab : null),
    ownerOf: () => "probe",
    isTabOnScreen: () => true,
    openSheet: (view) => {
      // Record only that a genuine payload arrived; never print the secret.
      result.sheetsOpened.push({ relyingPartyId: view.relyingPartyId, requestType: view.requestType, origin: view.origin, payloadIsFido: /^FIDO:\/\d+$/.test(view.qrCode), payloadLength: view.qrCode.length });
      return { update() {}, close() {} };
    },
  });
  result.enabled = passkeys.setEnabled(true);
  result.listeners = probeSession.listenerCount(PHONE_PASSKEY_REQUEST_EVENT);
  await win.loadURL(`http://localhost:${server.address().port}/`);
  win.webContents.debugger.attach();
  // WebAuthn needs a focused document; emulate focus instead of showing a window.
  await win.webContents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
  result.capabilities = await win.webContents.executeJavaScript("PublicKeyCredential.getClientCapabilities().then(c => ({ hybridTransport: c.hybridTransport, passkeyPlatformAuthenticator: c.passkeyPlatformAuthenticator }))");
  const started = Date.now();
  const outcome = win.webContents.executeJavaScript(`navigator.credentials.get({ publicKey: {
    challenge: crypto.getRandomValues(new Uint8Array(32)), rpId: "localhost", timeout: ${timeoutMs}, hints: ["hybrid"],
    allowCredentials: [{ type: "public-key", id: crypto.getRandomValues(new Uint8Array(32)), transports: ["hybrid"] }] } })
    .then(() => ({ ok: true }), (error) => ({ ok: false, name: error.name }))`);
  const watchdog = new Promise((resolve) => setTimeout(() => resolve({ pending: true }), timeoutMs + 20_000));
  result.request = await Promise.race([outcome, watchdog]);
  result.request.elapsedMs = Date.now() - started;
  result.pendingAfter = passkeys.pending();
  result.hybridEventsAvailable = result.sheetsOpened.some((sheet) => sheet.payloadIsFido);
  if (sheetPath) { await captureSheetLayout(sheetPath); result.sheetLayout = sheetPath; }
  passkeys.setEnabled(false);
  console.log(JSON.stringify(result, null, 2));
  server.close();
  app.exit(0);
});
