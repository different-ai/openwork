import assert from "node:assert/strict";
import test from "node:test";

import {
  applyWindowsTaskbarIcon,
  encodeWindowsIcon,
  WINDOWS_APP_USER_MODEL_ID_MAX_LENGTH,
  WINDOWS_ICON_SIZES,
  windowsBrandAppUserModelId,
  windowsBrandShortcutDetails,
  windowsBrandShortcutFileName,
  writeWindowsBrandShortcut,
  windowsIconFromNativeImage,
} from "./brand-icon-windows.mjs";

const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");

function fakePng(size) {
  const png = Buffer.alloc(24);
  PNG_SIGNATURE.copy(png);
  png.writeUInt32BE(size, 16);
  png.writeUInt32BE(size, 20);
  return png;
}

test("encodes PNG entries into a Windows ICO directory", () => {
  const entries = [16, 256].map((size) => ({ size, png: fakePng(size) }));
  const icon = encodeWindowsIcon(entries);

  assert.equal(icon.readUInt16LE(0), 0);
  assert.equal(icon.readUInt16LE(2), 1);
  assert.equal(icon.readUInt16LE(4), 2);
  assert.equal(icon.readUInt8(6), 16);
  assert.equal(icon.readUInt8(7), 16);
  assert.equal(icon.readUInt8(22), 0);
  assert.equal(icon.readUInt8(23), 0);
  assert.equal(icon.readUInt16LE(10), 1);
  assert.equal(icon.readUInt16LE(12), 32);
  assert.equal(icon.readUInt32LE(18), 38);
  assert.deepEqual(icon.subarray(38, 46), PNG_SIGNATURE);
});

test("renders the standard Windows icon sizes from a native image", () => {
  const rendered = [];
  const image = {
    resize(options) {
      rendered.push(options);
      return { toPNG: () => fakePng(options.width) };
    },
  };

  const icon = windowsIconFromNativeImage(image);

  assert.deepEqual(rendered.map((entry) => entry.width), WINDOWS_ICON_SIZES);
  assert.ok(rendered.every((entry) => entry.width === entry.height && entry.quality === "best"));
  assert.equal(icon.readUInt16LE(4), WINDOWS_ICON_SIZES.length);
});

test("rejects malformed icon entries", () => {
  assert.throws(() => encodeWindowsIcon([]), /at least one image/);
  assert.throws(() => encodeWindowsIcon([{ size: 32, png: Buffer.from("not png") }]), /did not encode as PNG/);
  assert.throws(() => encodeWindowsIcon([{ size: 512, png: fakePng(512) }]), /Invalid Windows brand icon size/);
});

test("updates both the live window icon and Windows taskbar identity", async () => {
  const calls = [];
  const window = {
    isVisible() {
      return true;
    },
    setIcon(image) {
      calls.push(["setIcon", image]);
    },
    setAppDetails(details) {
      calls.push(["setAppDetails", details]);
    },
    setSkipTaskbar(value) {
      calls.push(["setSkipTaskbar", value]);
    },
  };
  const image = { id: "company-icon" };

  await applyWindowsTaskbarIcon(window, {
    image,
    appId: "com.differentai.openwork",
    appIconPath: "C:\\Users\\Admin\\brand-icon.ico",
    relaunchCommand: "C:\\Program Files\\OpenWork\\OpenWork.exe",
    relaunchDisplayName: "OpenWork",
  }, async () => calls.push(["waitForRefresh"]));

  assert.deepEqual(calls, [
    ["setSkipTaskbar", true],
    ["waitForRefresh"],
    ["setAppDetails", {
      appIconPath: "C:\\Users\\Admin\\brand-icon.ico",
      appIconIndex: 0,
      relaunchCommand: "C:\\Program Files\\OpenWork\\OpenWork.exe",
      relaunchDisplayName: "OpenWork",
    }],
    ["setAppDetails", { appId: "com.differentai.openwork" }],
    ["setIcon", image],
    ["waitForRefresh"],
    ["setSkipTaskbar", false],
  ]);
});

test("uses a stable per-brand AppUserModelID to avoid the installed shortcut icon", () => {
  const base = "com.differentai.openwork";
  const first = windowsBrandAppUserModelId(base, "https://den.internal/assets/acme.png");
  const repeated = windowsBrandAppUserModelId(base, "https://den.internal/assets/acme.png");
  const second = windowsBrandAppUserModelId(base, "https://den.internal/assets/other.png");

  assert.match(first, /^com\.differentai\.openwork\.brand\.[a-f0-9]{16}$/);
  assert.equal(first, repeated);
  assert.notEqual(first, second);
  assert.equal(windowsBrandAppUserModelId(base, null), base);
  assert.ok(windowsBrandAppUserModelId("a".repeat(200), "https://den.internal/icon.png").length <= WINDOWS_APP_USER_MODEL_ID_MAX_LENGTH);
});

test("does not refresh the taskbar button before the boot window is shown", async () => {
  const calls = [];
  await applyWindowsTaskbarIcon({
    isVisible: () => false,
    setAppDetails: () => calls.push("details"),
    setIcon: () => calls.push("icon"),
    setSkipTaskbar: () => calls.push("skip"),
  }, {
    image: { id: "company-icon" },
    appId: "com.differentai.openwork.brand.1234",
    appIconPath: "C:\\brand.ico",
    relaunchCommand: "C:\\OpenWork.exe",
    relaunchDisplayName: "OpenWork",
  }, async () => calls.push("wait"));

  assert.deepEqual(calls, ["details", "details", "icon"]);
});

test("restores a visible taskbar button when refresh staging fails", async () => {
  const calls = [];
  await assert.rejects(() => applyWindowsTaskbarIcon({
    isVisible: () => true,
    setAppDetails: () => calls.push("details"),
    setIcon: () => calls.push("icon"),
    setSkipTaskbar: (value) => calls.push(["skip", value]),
  }, {
    image: { id: "company-icon" },
    appId: "com.differentai.openwork.brand.1234",
    appIconPath: "C:\\brand.ico",
    relaunchCommand: "C:\\OpenWork.exe",
    relaunchDisplayName: "OpenWork",
  }, async () => {
    calls.push("wait");
    throw new Error("refresh failed");
  }), /refresh failed/);

  assert.deepEqual(calls, [["skip", true], "wait", ["skip", false]]);
});

test("builds a per-user Start Menu shortcut with the branded Windows identity", () => {
  assert.equal(windowsBrandShortcutFileName('Agent: Blue/West'), "Agent- Blue-West Organization.lnk");
  assert.deepEqual(windowsBrandShortcutDetails({
    target: "C:\\Program Files\\OpenWork\\OpenWork.exe",
    appId: "com.differentai.openwork.brand.1234",
    appIconPath: "C:\\Users\\Admin\\brand-icon.ico",
    appName: "OpenWork",
  }), {
    target: "C:\\Program Files\\OpenWork\\OpenWork.exe",
    cwd: "C:\\Program Files\\OpenWork",
    description: "OpenWork organization desktop",
    icon: "C:\\Users\\Admin\\brand-icon.ico",
    iconIndex: 0,
    appUserModelId: "com.differentai.openwork.brand.1234",
  });
});

test("creates a first-time branded shortcut and replaces it on repeat applies", () => {
  const calls = [];
  const details = { appUserModelId: "com.differentai.openwork.brand.1234" };
  const shellApi = {
    writeShortcutLink: (...args) => {
      calls.push(args);
      return true;
    },
  };
  const shortcutPath = "C:\\Users\\Admin\\OpenWork Organization.lnk";

  const created = writeWindowsBrandShortcut(shellApi, shortcutPath, details, false);
  const replaced = writeWindowsBrandShortcut(shellApi, shortcutPath, details, true);

  assert.equal(created, true);
  assert.equal(replaced, true);
  assert.deepEqual(calls, [
    [shortcutPath, "create", details],
    [shortcutPath, "replace", details],
  ]);
});
