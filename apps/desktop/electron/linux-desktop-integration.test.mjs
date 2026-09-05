import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  OPENWORK_DESKTOP_ID,
  buildOpenworkDesktopEntry,
  createLinuxDesktopIntegration,
  quoteDesktopExec,
} from "./linux-desktop-integration.mjs";

const temporaryRoots = [];
const iconSizes = [16, 24, 32, 48, 64, 96, 128, 256, 512];

async function createHarness(options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwork-appimage-integration-"));
  temporaryRoots.push(root);
  const homeDir = path.join(root, "home");
  const dataHome = path.join(root, "data");
  const configHome = path.join(root, "config");
  const resourcesPath = path.join(root, "resources");
  const appImagePath = options.appImagePath ?? path.join(root, "OpenWork AppImage");
  await mkdir(path.join(resourcesPath, "icons", "linux"), { recursive: true });
  await Promise.all(iconSizes.map((size) => (
    writeFile(path.join(resourcesPath, "icons", "linux", `${size}x${size}.png`), String(size))
  )));
  await writeFile(appImagePath, "appimage");

  let defaultHandler = options.defaultHandler ?? null;
  const commands = [];
  const runCommand = async (command, args) => {
    commands.push([command, args]);
    if (command === "xdg-mime" && args[0] === "query") {
      return { ok: true, stdout: defaultHandler ? `${defaultHandler}\n` : "", stderr: "" };
    }
    if (command === "xdg-mime" && args[0] === "default") {
      defaultHandler = args[1];
    }
    return { ok: true, stdout: "", stderr: "" };
  };
  const dialogResponses = [...(options.dialogResponses ?? [])];
  const dialogs = [];
  const dialog = {
    async showMessageBox(_window, dialogOptions) {
      dialogs.push(dialogOptions);
      return dialogResponses.shift() ?? { response: 0, checkboxChecked: false };
    },
  };
  const app = {
    isPackaged: options.isPackaged ?? true,
    getVersion: () => options.version ?? "0.18.7",
  };
  const integration = createLinuxDesktopIntegration({
    app,
    dialog,
    appName: "OpenWork",
    distribution: "public",
    env: {
      APPIMAGE: appImagePath,
      XDG_DATA_HOME: dataHome,
      XDG_CONFIG_HOME: configHome,
      XDG_DATA_DIRS: path.join(root, "system-data"),
    },
    platform: options.platform ?? "linux",
    homeDir,
    resourcesPath,
    runCommand,
  });
  return {
    appImagePath,
    commands,
    configHome,
    dataHome,
    dialogs,
    getDefaultHandler: () => defaultHandler,
    integration,
    root,
  };
}

// Simulates the next launch of the same install: same XDG dirs and state, but a
// possibly different AppImage path and app version.
function relaunchAt(harness, appImagePath, options = {}) {
  let defaultHandler = options.defaultHandler ?? OPENWORK_DESKTOP_ID;
  const dialogs = [];
  const integration = createLinuxDesktopIntegration({
    app: { isPackaged: true, getVersion: () => options.version ?? "0.18.7" },
    dialog: {
      async showMessageBox(_window, dialogOptions) {
        dialogs.push(dialogOptions);
        return { response: 0, checkboxChecked: false };
      },
    },
    appName: "OpenWork",
    distribution: "public",
    env: {
      APPIMAGE: appImagePath,
      XDG_DATA_HOME: harness.dataHome,
      XDG_CONFIG_HOME: harness.configHome,
      XDG_DATA_DIRS: path.join(harness.root, "system-data"),
    },
    platform: "linux",
    resourcesPath: path.join(harness.root, "resources"),
    runCommand: async (command, args) => {
      if (command === "xdg-mime" && args[0] === "query") {
        return { ok: true, stdout: defaultHandler ? `${defaultHandler}\n` : "", stderr: "" };
      }
      if (command === "xdg-mime" && args[0] === "default") defaultHandler = args[1];
      return { ok: true, stdout: "", stderr: "" };
    },
  });
  return { dialogs, getDefaultHandler: () => defaultHandler, integration };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Linux AppImage desktop integration", () => {
  it("quotes AppImage paths for Desktop Entry Exec fields", () => {
    const appImagePath = String.raw`/home/alice/Applications/Open Work "daily"$%draft\archive`;
    assert.equal(
      quoteDesktopExec(appImagePath),
      String.raw`"/home/alice/Applications/Open Work \"daily\"\$%%draft\\archive"`,
    );
    assert.equal(quoteDesktopExec("`"), '"\\`"');
    const entry = buildOpenworkDesktopEntry({
      appImagePath,
      appName: "OpenWork",
      appVersion: "0.18.7",
      distribution: "public",
    });
    assert.match(entry, /^Exec=".*" %U$/m);
    assert.match(entry, /^MimeType=x-scheme-handler\/openwork;$/m);
    assert.match(entry, /^StartupWMClass=com\.differentai\.openwork$/m);
  });

  it("is unavailable outside a packaged Linux AppImage", async () => {
    const harness = await createHarness({ isPackaged: false });
    const status = await harness.integration.getStatus();
    assert.equal(status.supported, false);
    assert.equal(status.state, "unsupported");
  });

  it("installs its launcher, icons, and openwork handler", async () => {
    const harness = await createHarness();
    const result = await harness.integration.install();
    assert.equal(result.ok, true);
    assert.equal(result.status.state, "integrated");
    assert.equal(harness.getDefaultHandler(), OPENWORK_DESKTOP_ID);

    const desktopEntry = await readFile(harness.integration.paths.desktopEntryPath, "utf8");
    assert.match(desktopEntry, new RegExp(`^Exec=${quoteDesktopExec(harness.appImagePath)} %U$`, "m"));
    assert.match(desktopEntry, /^X-OpenWork-Managed=true$/m);
    for (const size of iconSizes) {
      assert.equal(await readFile(harness.integration.paths.iconPaths[size], "utf8"), String(size));
    }
  });

  it("detects a moved AppImage and repairs the launcher for the new path", async () => {
    const first = await createHarness();
    assert.equal((await first.integration.install()).ok, true);
    const movedPath = path.join(first.root, "Applications", "OpenWork.AppImage");
    await mkdir(path.dirname(movedPath), { recursive: true });
    await rename(first.appImagePath, movedPath);

    const moved = createLinuxDesktopIntegration({
      app: { isPackaged: true, getVersion: () => "0.18.7" },
      dialog: { showMessageBox: async () => ({ response: 0, checkboxChecked: false }) },
      appName: "OpenWork",
      distribution: "public",
      env: {
        APPIMAGE: movedPath,
        XDG_DATA_HOME: first.dataHome,
        XDG_CONFIG_HOME: first.configHome,
        XDG_DATA_DIRS: path.join(first.root, "system-data"),
      },
      platform: "linux",
      resourcesPath: path.join(first.root, "resources"),
      runCommand: async (command, args) => {
        if (command === "xdg-mime" && args[0] === "query") {
          return { ok: true, stdout: `${OPENWORK_DESKTOP_ID}\n`, stderr: "" };
        }
        return { ok: true, stdout: "", stderr: "" };
      },
    });
    const before = await moved.getStatus();
    assert.equal(before.state, "needs_repair");
    assert.deepEqual(before.issues, ["appimage-path"]);
    assert.equal((await moved.install()).ok, true);
    assert.match(
      await readFile(moved.paths.desktopEntryPath, "utf8"),
      new RegExp(`^TryExec=${movedPath}$`, "m"),
    );
  });

  it("silently repairs an owned launcher after a self-update lands a new filename", async () => {
    const harness = await createHarness();
    assert.equal((await harness.integration.install()).ok, true);

    // Linux artifacts carry the version in their filename, so electron-updater
    // installs each release at a new path and stales the launcher.
    const updatedPath = path.join(harness.root, "openwork-linux-x86_64-0.18.8.AppImage");
    await rename(harness.appImagePath, updatedPath);
    const relaunched = relaunchAt(harness, updatedPath, { version: "0.18.8" });
    assert.equal((await relaunched.integration.getStatus()).state, "needs_repair");

    const status = await relaunched.integration.maybePrompt({});
    assert.equal(status.state, "integrated");
    assert.equal(relaunched.dialogs.length, 0);
    const entry = await readFile(relaunched.integration.paths.desktopEntryPath, "utf8");
    assert.match(entry, new RegExp(`^TryExec=${updatedPath}$`, "m"));
    assert.match(entry, /^X-OpenWork-Version=0\.18\.8$/m);
  });

  it("silently refreshes an owned launcher when only the version changed", async () => {
    const harness = await createHarness();
    assert.equal((await harness.integration.install()).ok, true);

    const relaunched = relaunchAt(harness, harness.appImagePath, { version: "0.18.8" });
    assert.deepEqual((await relaunched.integration.getStatus()).issues, ["version"]);

    const status = await relaunched.integration.maybePrompt({});
    assert.equal(status.state, "integrated");
    assert.equal(relaunched.dialogs.length, 0);
  });

  it("keeps a failed silent repair quiet and leaves it to Settings", async () => {
    const harness = await createHarness();
    assert.equal((await harness.integration.install()).ok, true);

    const movedPath = path.join(harness.root, "openwork-linux-x86_64-0.18.8.AppImage");
    await rename(harness.appImagePath, movedPath);
    const relaunched = relaunchAt(harness, movedPath, { version: "0.18.8" });
    await rm(path.join(harness.root, "resources"), { recursive: true, force: true });

    const status = await relaunched.integration.maybePrompt({});
    assert.equal(status.state, "needs_repair");
    assert.equal(relaunched.dialogs.length, 0);
  });

  it("does not prompt after a remembered Not now response", async () => {
    const harness = await createHarness({
      dialogResponses: [{ response: 0, checkboxChecked: true }],
    });
    await harness.integration.maybePrompt({});
    await harness.integration.maybePrompt({});
    assert.equal(harness.dialogs.length, 1);
    assert.equal(harness.dialogs[0].buttons[1], "Integrate");
  });

  it("integrates from the first-run prompt and points to the matching Settings control", async () => {
    const harness = await createHarness({
      dialogResponses: [{ response: 1, checkboxChecked: false }],
    });
    const status = await harness.integration.maybePrompt({});
    assert.equal(status.state, "integrated");
    assert.equal(harness.dialogs.length, 1);
    assert.match(harness.dialogs[0].detail, /Settings → Preferences → AppImage desktop integration/);
  });

  it("recognizes an external manager and does not duplicate its integration", async () => {
    const managerDesktopId = "it.mijorus.gearlever.openwork.desktop";
    const harness = await createHarness({ defaultHandler: managerDesktopId });
    const applications = path.join(harness.dataHome, "applications");
    await mkdir(applications, { recursive: true });
    await writeFile(path.join(applications, managerDesktopId), `[Desktop Entry]
Type=Application
Name=OpenWork
Exec=${quoteDesktopExec(harness.appImagePath)} %U
TryExec=${harness.appImagePath}
MimeType=x-scheme-handler/openwork;
`);

    const status = await harness.integration.getStatus();
    assert.equal(status.state, "managed_externally");
    assert.equal(status.ownership, "external");
    assert.equal((await harness.integration.install()).ok, false);
    await harness.integration.maybePrompt({});
    assert.equal(harness.dialogs.length, 0);
  });

  it("registers an externally managed canonical launcher without rewriting it", async () => {
    const harness = await createHarness({ defaultHandler: OPENWORK_DESKTOP_ID });
    await mkdir(path.dirname(harness.integration.paths.desktopEntryPath), { recursive: true });
    const original = `[Desktop Entry]
Type=Application
Name=Manager-owned OpenWork
Exec=${quoteDesktopExec(harness.appImagePath)} %U
TryExec=${harness.appImagePath}
MimeType=x-scheme-handler/openwork;
`;
    await writeFile(harness.integration.paths.desktopEntryPath, original);
    const result = await harness.integration.install({ useExternalLauncher: true });
    assert.equal(result.ok, true);
    assert.equal(await readFile(harness.integration.paths.desktopEntryPath, "utf8"), original);
  });

  it("never overwrites a canonical launcher it does not own", async () => {
    const harness = await createHarness();
    await mkdir(path.dirname(harness.integration.paths.desktopEntryPath), { recursive: true });
    const original = "[Desktop Entry]\nType=Application\nName=Unrelated launcher\nExec=/usr/bin/false\n";
    await writeFile(harness.integration.paths.desktopEntryPath, original);
    const result = await harness.integration.install();
    assert.equal(result.ok, false);
    assert.match(result.error, /will not be overwritten/);
    assert.equal(await readFile(harness.integration.paths.desktopEntryPath, "utf8"), original);
  });

  it("registers an existing manager launcher without creating a duplicate", async () => {
    const managerDesktopId = "appimagelauncher-openwork.desktop";
    const harness = await createHarness({ defaultHandler: "firefox.desktop" });
    const managerPath = path.join(harness.dataHome, "applications", managerDesktopId);
    await mkdir(path.dirname(managerPath), { recursive: true });
    const managerEntry = `[Desktop Entry]
Type=Application
Name=OpenWork
Exec=${quoteDesktopExec(harness.appImagePath)} %U
TryExec=${harness.appImagePath}
MimeType=x-scheme-handler/openwork;
`;
    await writeFile(managerPath, managerEntry);

    const before = await harness.integration.getStatus();
    assert.equal(before.state, "needs_repair");
    assert.equal(before.ownership, "external");
    const result = await harness.integration.install({ useExternalLauncher: true });
    assert.equal(result.ok, true);
    assert.equal(result.status.state, "managed_externally");
    assert.equal(harness.getDefaultHandler(), managerDesktopId);
    assert.equal(await readFile(managerPath, "utf8"), managerEntry);
    await assert.rejects(readFile(harness.integration.paths.desktopEntryPath, "utf8"));
  });

  it("removes only owned files and restores the previous protocol handler", async () => {
    const previousHandler = "firefox.desktop";
    const harness = await createHarness({ defaultHandler: previousHandler });
    const systemApplications = path.join(harness.root, "system-data", "applications");
    await mkdir(systemApplications, { recursive: true });
    await writeFile(path.join(systemApplications, previousHandler), "[Desktop Entry]\nType=Application\n");

    assert.equal((await harness.integration.install()).ok, true);
    const result = await harness.integration.remove();
    assert.equal(result.ok, true);
    assert.equal(harness.getDefaultHandler(), previousHandler);
    assert.equal(result.status.state, "not_integrated");
    assert.equal(
      harness.commands.some(([command, args]) => (
        command === "xdg-mime"
        && args[0] === "default"
        && args[1] === previousHandler
      )),
      true,
    );
  });
});
