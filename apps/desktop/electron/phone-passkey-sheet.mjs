// The sheet that shows Chromium's hybrid (phone passkey) QR code over the
// window. It is a separate, sandboxed, script-free window: the page that asked
// for the passkey cannot reach it, and it has no preload or Node access.
// Cancel is a link the main process intercepts; Esc cancels too.
import { renderSVG } from "uqr";

const CANCEL_URL = "openwork-passkey:cancel";

// Mirrors apps/app/src/app/index.css tokens (Radix slate, --radius,
// --dls-radius, --dls-accent). This window cannot load the app stylesheet.
const SHEET_CSS = `
:root { color-scheme: light dark; --background: #fcfcfd; --foreground: #1c2024; --muted-foreground: #60646c; --border: rgba(0, 9, 50, 0.12); --dls-accent: #011627; --dls-accent-fg: #fcfcfd; --radius: 0.45rem; --dls-radius: 16px; }
@media (prefers-color-scheme: dark) { :root { --background: #111113; --foreground: #edeef0; --muted-foreground: #b0b4ba; --border: rgba(221, 234, 248, 0.12); } }
* { box-sizing: border-box; margin: 0; }
html, body { height: 100%; }
body { font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; background: var(--background); color: var(--foreground); display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 20px 16px 16px; user-select: none; }
h1 { font-size: 15px; font-weight: 600; letter-spacing: -0.01em; text-align: center; }
.origin { color: var(--muted-foreground); font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; text-align: center; word-break: break-all; }
.code { width: 232px; height: 232px; border-radius: var(--dls-radius); background: #fcfcfd; padding: 8px; box-shadow: 0 0 0 1px var(--border); }
.code svg { width: 100%; height: 100%; display: block; }
.code.dim { opacity: 0.25; }
.state { min-height: 20px; text-align: center; font-weight: 500; }
.state small { display: block; font-weight: 400; color: var(--muted-foreground); font-size: 12px; }
.actions { margin-top: auto; display: flex; justify-content: flex-end; align-self: stretch; }
a.button { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 12px; border-radius: var(--radius); color: var(--foreground); text-decoration: none; box-shadow: inset 0 0 0 1px var(--border); font-weight: 500; }
a.button:focus-visible { outline: 2px solid var(--dls-accent); outline-offset: 2px; }
kbd { font: 11px ui-monospace, Menlo, monospace; color: var(--muted-foreground); }
`;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** What the sheet says for each state: one state line, with a fix when one exists. */
export function phonePasskeyStateLine(state) {
  switch (state) {
    case "phone-connected": return { text: "Phone connected", hint: "Keep your phone near this computer" };
    case "advert-received":
    case "ready": return { text: "Continue on your phone", hint: null };
    case "bluetooth-off": return { text: "Bluetooth is off", hint: "Turn on Bluetooth on this computer to use your phone" };
    case "bluetooth-permission-denied": return { text: "OpenWork can't use Bluetooth", hint: "Allow it in System Settings, Privacy & Security, Bluetooth" };
    default: return { text: "Scan with your phone's camera", hint: null };
  }
}

/** @param {import("./browser-phone-passkeys.mjs").PhonePasskeyView} view */
export function renderPhonePasskeySheetHtml(view) {
  const title = view.requestType === "create"
    ? `Save a passkey for ${view.relyingPartyId} on your phone`
    : `Sign in to ${view.relyingPartyId} with your phone`;
  let originHost = "";
  try { originHost = new URL(view.origin).hostname; } catch { /* validated upstream */ }
  // Show who asked when the page is not on the relying party's own domain.
  const showOrigin = originHost !== view.relyingPartyId && !originHost.endsWith(`.${view.relyingPartyId}`);
  const line = phonePasskeyStateLine(view.state);
  const dim = ["advert-received", "ready", "bluetooth-off", "bluetooth-permission-denied"].includes(view.state);
  const qr = renderSVG(view.qrCode, { ecc: "L", border: 2, pixelSize: 4, whiteColor: "#fcfcfd", blackColor: "#1c2024" });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>${escapeHtml(title)}</title><style>${SHEET_CSS}</style></head>
<body>
<h1>${escapeHtml(title)}</h1>
${showOrigin ? `<p class="origin">Requested by ${escapeHtml(view.origin)}</p>` : ""}
<div class="code${dim ? " dim" : ""}" role="img" aria-label="QR code for signing in with your phone">${qr}</div>
<p class="state" role="status">${escapeHtml(line.text)}${line.hint ? `<small>${escapeHtml(line.hint)}</small>` : ""}</p>
<div class="actions"><a class="button" href="${CANCEL_URL}">Cancel <kbd>esc</kbd></a></div>
</body></html>`;
}

function dataUrl(html) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

/**
 * Opens the sheet over `parent`. Returns the controller the request uses.
 * @param {typeof import("electron").BrowserWindow} BrowserWindow
 * @param {import("electron").BrowserWindow} parent
 * @param {import("./browser-phone-passkeys.mjs").PhonePasskeyView} view
 * @param {{ cancel: () => void }} actions
 */
export function openPhonePasskeySheet(BrowserWindow, parent, view, actions) {
  let closedByOwner = false;
  const sheet = new BrowserWindow({
    parent,
    modal: true,
    show: false,
    width: 360,
    height: 432,
    useContentSize: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: "Use your phone",
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: false,
      webSecurity: true,
      spellcheck: false,
      // In-memory partition: nothing from the browser's profile, nothing kept.
      partition: "openwork-phone-passkey-sheet",
    },
  });
  sheet.removeMenu?.();
  const contents = sheet.webContents;
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event, url) => {
    event.preventDefault();
    if (url === CANCEL_URL) actions.cancel();
  });
  contents.on("before-input-event", (event, input) => {
    if (input.type === "keyDown" && input.key === "Escape") {
      event.preventDefault();
      actions.cancel();
    }
  });
  sheet.on("closed", () => { if (!closedByOwner) actions.cancel(); });
  sheet.once("ready-to-show", () => { if (!sheet.isDestroyed()) sheet.show(); });
  void sheet.loadURL(dataUrl(renderPhonePasskeySheetHtml(view))).catch(() => {});
  return {
    update(next) {
      if (!sheet.isDestroyed()) void sheet.loadURL(dataUrl(renderPhonePasskeySheetHtml(next))).catch(() => {});
    },
    close() {
      closedByOwner = true;
      if (!sheet.isDestroyed()) sheet.close();
    },
  };
}
