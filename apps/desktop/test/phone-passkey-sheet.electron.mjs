// Runs the real phone passkey sheet in Electron, hidden, and checks that it
// cannot run script and that Cancel, Esc and closing the window cancel:
//
//   pnpm --filter @openwork/desktop exec electron ./test/phone-passkey-sheet.electron.mjs [--capture=sheet.png]
//
// The QR here is a placeholder payload that no phone accepts. This checks the
// sheet, not hybrid transport.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { app, BrowserWindow } from "electron";
import { openPhonePasskeySheet } from "../electron/phone-passkey-sheet.mjs";

const capture = process.argv.find((value) => value.startsWith("--capture="))?.slice("--capture=".length);
const view = { relyingPartyId: "example.com", requestType: "get", origin: "https://login.example.net", qrCode: `FIDO:/${"0".repeat(200)}`, state: "waiting", canCancel: true };

// Never put a window on screen while testing.
class HiddenWindow extends BrowserWindow {
  constructor(options) { super({ ...options, show: false, paintWhenInitiallyHidden: true }); }
  show() {}
}

const sheets = [];
class TrackedWindow extends HiddenWindow {
  constructor(options) { super(options); sheets.push(this); }
}

function open(parent) {
  let cancels = 0;
  const controller = openPhonePasskeySheet(TrackedWindow, parent, view, { cancel: () => { cancels += 1; } });
  const sheet = sheets.at(-1);
  return { controller, sheet, cancels: () => cancels };
}

async function loaded(sheet) {
  if (sheet.webContents.isLoading()) await new Promise((resolve) => sheet.webContents.once("did-finish-load", resolve));
  await new Promise((resolve) => setTimeout(resolve, 200));
}

async function click(sheet, x, y) {
  for (const type of ["mouseDown", "mouseUp"]) sheet.webContents.sendInputEvent({ type, x, y, button: "left", clickCount: 1 });
  await new Promise((resolve) => setTimeout(resolve, 300));
}

app.whenReady().then(async () => {
  const results = [];
  const parent = new HiddenWindow({ width: 800, height: 600 });
  try {
    // Script is off in the sheet.
    {
      const { sheet, controller } = open(parent);
      await loaded(sheet);
      assert.equal(sheet.webContents.getLastWebPreferences().javascript, false);
      assert.equal(sheet.webContents.getLastWebPreferences().sandbox, true);
      assert.equal(sheet.webContents.getLastWebPreferences().nodeIntegration, false);
      if (capture) writeFileSync(capture, (await sheet.webContents.capturePage()).toPNG());
      controller.close();
      results.push("script, Node and preload are off");
    }
    // The Cancel link cancels, and the sheet stays on its own page.
    {
      const { sheet, controller, cancels } = open(parent);
      await loaded(sheet);
      const before = sheet.webContents.getURL();
      // Cancel sits bottom right: 360x432 content, 16px padding, 28px button.
      await click(sheet, 300, 402);
      assert.equal(cancels(), 1, "Cancel link should cancel");
      assert.equal(sheet.webContents.getURL(), before);
      controller.close();
      results.push("Cancel link cancels without navigating");
    }
    // Esc cancels.
    {
      const { sheet, controller, cancels } = open(parent);
      await loaded(sheet);
      sheet.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(cancels(), 1, "Esc should cancel");
      controller.close();
      results.push("Esc cancels");
    }
    // Closing the window cancels; the owner closing it does not.
    {
      const first = open(parent);
      await loaded(first.sheet);
      first.sheet.close();
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(first.cancels(), 1, "closing the sheet should cancel");
      const second = open(parent);
      await loaded(second.sheet);
      second.controller.close();
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(second.cancels(), 0, "the owner closing the sheet is not a cancel");
      results.push("closing the window cancels; closing by the owner does not");
    }
    console.log(JSON.stringify({ ok: true, electron: process.versions.electron, results }, null, 2));
    app.exit(0);
  } catch (error) {
    console.error(error);
    console.log(JSON.stringify({ ok: false, results }, null, 2));
    app.exit(1);
  }
});
