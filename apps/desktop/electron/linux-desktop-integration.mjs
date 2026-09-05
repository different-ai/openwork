import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  access,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** @typedef {import("@openwork/types/desktop-ipc").DesktopIntegrationIssue} DesktopIntegrationIssue */
/** @typedef {import("@openwork/types/desktop-ipc").DesktopIntegrationResult} DesktopIntegrationResult */
/** @typedef {import("@openwork/types/desktop-ipc").DesktopIntegrationStatus} DesktopIntegrationStatus */

export const OPENWORK_DESKTOP_ID = "com.differentai.openwork.desktop";
export const OPENWORK_DESKTOP_NAME = "com.differentai.openwork";
export const OPENWORK_PROTOCOL_MIME = "x-scheme-handler/openwork";

const INTEGRATION_STATE_VERSION = 1;
const OWNERSHIP_MARKER = "X-OpenWork-Managed";
const MANAGED_VERSION_MARKER = "X-OpenWork-Version";
const ICON_SIZES = [16, 24, 32, 48, 64, 96, 128, 256, 512];

function defaultCommandRunner(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { encoding: "utf8", timeout: 10_000 }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: typeof stdout === "string" ? stdout : "",
        stderr: typeof stderr === "string" ? stderr : error?.message ?? "",
      });
    });
  });
}

function cleanDesktopValue(value) {
  return String(value ?? "").replace(/[\0\r\n]/g, " ").trim();
}

export function quoteDesktopExec(value) {
  const cleaned = cleanDesktopValue(value);
  const quoted = cleaned
    .replaceAll("%", "%%")
    .replace(/([\\`"$])/g, "\\$1");
  return `"${quoted}"`;
}

function parseDesktopEntry(content) {
  const fields = new Map();
  let inDesktopEntry = false;
  for (const rawLine of String(content ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("[") && line.endsWith("]")) {
      inDesktopEntry = line === "[Desktop Entry]";
      continue;
    }
    if (!inDesktopEntry || !line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return fields;
}

function unquoteDesktopValue(value) {
  const trimmed = String(value ?? "").trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\([\\`"$])/g, "$1");
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function entryTargetsAppImage(fields, appImagePath) {
  const tryExec = unquoteDesktopValue(fields.get("TryExec"));
  if (tryExec && path.resolve(tryExec) === appImagePath) return true;
  const exec = fields.get("Exec") ?? "";
  return exec.includes(appImagePath)
    || exec.includes(quoteDesktopExec(appImagePath))
    || exec.includes(`'${appImagePath.replaceAll("'", "'\\''")}'`);
}

function entryHandlesOpenwork(fields) {
  return (fields.get("MimeType") ?? "")
    .split(";")
    .map((value) => value.trim())
    .includes(OPENWORK_PROTOCOL_MIME);
}

function entryAcceptsUrl(fields) {
  return /%(?:u|U)(?:\s|$)/.test(fields.get("Exec") ?? "");
}

function emptyState() {
  return {
    version: INTEGRATION_STATE_VERSION,
    dismissedAppImages: [],
    previousProtocolHandler: null,
  };
}

function normalizeState(value) {
  if (!value || typeof value !== "object") return emptyState();
  const dismissed = Array.isArray(value.dismissedAppImages)
    ? value.dismissedAppImages.filter((item) => typeof item === "string")
    : [];
  return {
    version: INTEGRATION_STATE_VERSION,
    dismissedAppImages: dismissed,
    previousProtocolHandler:
      typeof value.previousProtocolHandler === "string" && value.previousProtocolHandler.trim()
        ? value.previousProtocolHandler.trim()
        : null,
  };
}

async function fileExists(target) {
  return access(target, fsConstants.F_OK).then(() => true).catch(() => false);
}

async function atomicWrite(target, content) {
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o644 });
  await rename(temporary, target);
}

async function removeDesktopAssociation(filePath, desktopId) {
  const content = await readFile(filePath, "utf8").catch(() => null);
  if (content == null) return false;
  let section = "";
  let changed = false;
  const next = content.split(/\r?\n/).map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      section = trimmed;
      return line;
    }
    if (
      (section !== "[Default Applications]" && section !== "[Added Associations]")
      || !trimmed.startsWith(`${OPENWORK_PROTOCOL_MIME}=`)
    ) {
      return line;
    }
    const separator = line.indexOf("=");
    const handlers = line
      .slice(separator + 1)
      .split(";")
      .map((value) => value.trim())
      .filter((value) => value && value !== desktopId);
    changed = true;
    return `${line.slice(0, separator + 1)}${handlers.length ? `${handlers.join(";")};` : ""}`;
  }).join("\n");
  if (changed) await atomicWrite(filePath, next);
  return changed;
}

/** @returns {DesktopIntegrationStatus} */
function unsupportedStatus() {
  return {
    supported: false,
    state: "unsupported",
    ownership: "none",
    appImagePath: null,
    desktopEntryPath: null,
    handlerDesktopId: null,
    issues: [],
  };
}

export function buildOpenworkDesktopEntry({
  appImagePath,
  appName,
  appVersion,
  distribution,
}) {
  return `[Desktop Entry]
Type=Application
Version=1.0
Name=${cleanDesktopValue(appName)}
Comment=Run agents, skills, and MCP with OpenWork
Exec=${quoteDesktopExec(appImagePath)} %U
TryExec=${cleanDesktopValue(appImagePath)}
Icon=${OPENWORK_DESKTOP_NAME}
StartupWMClass=${OPENWORK_DESKTOP_NAME}
Terminal=false
Categories=Development;Utility;
MimeType=${OPENWORK_PROTOCOL_MIME};
X-AppImage-Name=${cleanDesktopValue(appName)}
X-AppImage-Version=${cleanDesktopValue(appVersion)}
${OWNERSHIP_MARKER}=true
${MANAGED_VERSION_MARKER}=${cleanDesktopValue(appVersion)}
X-OpenWork-Distribution=${cleanDesktopValue(distribution)}
X-OpenWork-AppImage=${cleanDesktopValue(appImagePath)}
`;
}

export function createLinuxDesktopIntegration({
  app,
  dialog,
  appName,
  distribution,
  env = process.env,
  platform = process.platform,
  homeDir = os.homedir(),
  resourcesPath = process.resourcesPath,
  runCommand = defaultCommandRunner,
}) {
  const rawAppImagePath = typeof env.APPIMAGE === "string" ? env.APPIMAGE.trim() : "";
  const appImagePath = rawAppImagePath && path.isAbsolute(rawAppImagePath)
    ? path.resolve(rawAppImagePath)
    : null;
  const supported = platform === "linux" && app.isPackaged && appImagePath != null;
  const dataHome = env.XDG_DATA_HOME?.trim() || path.join(homeDir, ".local", "share");
  const configHome = env.XDG_CONFIG_HOME?.trim() || path.join(homeDir, ".config");
  const desktopEntryPath = path.join(dataHome, "applications", OPENWORK_DESKTOP_ID);
  const iconPaths = Object.fromEntries(ICON_SIZES.map((size) => [
    size,
    path.join(dataHome, "icons", "hicolor", `${size}x${size}`, "apps", `${OPENWORK_DESKTOP_NAME}.png`),
  ]));
  const iconSources = Object.fromEntries(ICON_SIZES.map((size) => [
    size,
    path.join(resourcesPath ?? "", "icons", "linux", `${size}x${size}.png`),
  ]));
  const statePath = path.join(configHome, "openwork", "desktop-integration.json");

  async function readState() {
    const raw = await readFile(statePath, "utf8").catch(() => null);
    if (raw == null) return emptyState();
    try {
      return normalizeState(JSON.parse(raw));
    } catch {
      return emptyState();
    }
  }

  async function writeState(state) {
    await atomicWrite(statePath, `${JSON.stringify(normalizeState(state), null, 2)}\n`);
  }

  async function queryDefaultHandler() {
    const result = await runCommand("xdg-mime", ["query", "default", OPENWORK_PROTOCOL_MIME]);
    return result.ok && result.stdout.trim() ? result.stdout.trim() : null;
  }

  function desktopSearchRoots() {
    const systemRoots = (env.XDG_DATA_DIRS?.trim() || "/usr/local/share:/usr/share")
      .split(":")
      .filter(Boolean);
    return [dataHome, ...systemRoots].map((root) => path.join(root, "applications"));
  }

  async function locateDesktopEntry(desktopId) {
    if (!desktopId || desktopId.includes("/") || desktopId.includes("\\")) return null;
    for (const root of desktopSearchRoots()) {
      const candidate = path.join(root, desktopId);
      if (await fileExists(candidate)) return candidate;
    }
    return null;
  }

  async function inspectDesktopFile(candidate, desktopId) {
    const content = await readFile(candidate, "utf8").catch(() => null);
    if (content == null) return null;
    const fields = parseDesktopEntry(content);
    if (!entryTargetsAppImage(fields, appImagePath)) return null;
    return {
      desktopId,
      path: candidate,
      managed: fields.get(OWNERSHIP_MARKER) === "true",
      acceptsUrl: entryAcceptsUrl(fields),
      handlesProtocol: entryHandlesOpenwork(fields),
    };
  }

  async function findExternalEntry(handlerDesktopId) {
    const inspected = handlerDesktopId
      ? await locateDesktopEntry(handlerDesktopId)
        .then((candidate) => candidate && inspectDesktopFile(candidate, handlerDesktopId))
      : null;
    if (inspected && !inspected.managed) return inspected;

    const applicationsRoot = path.join(dataHome, "applications");
    const entries = await readdir(applicationsRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".desktop") || entry.name === OPENWORK_DESKTOP_ID) continue;
      const candidate = await inspectDesktopFile(path.join(applicationsRoot, entry.name), entry.name);
      if (candidate && !candidate.managed) return candidate;
    }
    return null;
  }

  /** @returns {Promise<DesktopIntegrationStatus>} */
  async function getStatus() {
    if (!supported) return unsupportedStatus();
    const handlerDesktopId = await queryDefaultHandler();
    const ownContent = await readFile(desktopEntryPath, "utf8").catch(() => null);
    const ownFields = ownContent == null ? null : parseDesktopEntry(ownContent);
    const ownManaged = ownFields?.get(OWNERSHIP_MARKER) === "true";

    if (ownFields && ownManaged) {
      /** @type {DesktopIntegrationIssue[]} */
      const issues = [];
      if (!entryTargetsAppImage(ownFields, appImagePath)) issues.push("appimage-path");
      if (!entryHandlesOpenwork(ownFields)) issues.push("desktop-entry");
      if (ownFields.get(MANAGED_VERSION_MARKER) !== app.getVersion()) issues.push("version");
      const iconsPresent = await Promise.all(
        ICON_SIZES.map((size) => fileExists(iconPaths[size])),
      );
      if (!iconsPresent.every(Boolean)) issues.push("icon");
      if (handlerDesktopId !== OPENWORK_DESKTOP_ID) issues.push("protocol-handler");
      return {
        supported: true,
        state: issues.length ? "needs_repair" : "integrated",
        ownership: "openwork",
        appImagePath,
        desktopEntryPath,
        handlerDesktopId,
        issues,
      };
    }

    const external = await findExternalEntry(handlerDesktopId);
    if (external) {
      /** @type {DesktopIntegrationIssue[]} */
      const issues = [];
      if (!external.acceptsUrl || !external.handlesProtocol) issues.push("desktop-entry");
      if (handlerDesktopId !== external.desktopId) issues.push("protocol-handler");
      return {
        supported: true,
        state: issues.length ? "needs_repair" : "managed_externally",
        ownership: "external",
        appImagePath,
        desktopEntryPath: external.path,
        handlerDesktopId,
        issues,
      };
    }

    return {
      supported: true,
      state: "not_integrated",
      ownership: "none",
      appImagePath,
      desktopEntryPath: null,
      handlerDesktopId,
      issues: ["desktop-entry", "icon", "protocol-handler"],
    };
  }

  async function refreshDesktopCaches() {
    await runCommand("update-desktop-database", [path.join(dataHome, "applications")]);
    await runCommand("gtk-update-icon-cache", ["-f", "-t", path.join(dataHome, "icons", "hicolor")]);
  }

  /**
   * @param {{ useExternalLauncher?: boolean }} [options]
   * @returns {Promise<DesktopIntegrationResult>}
   */
  async function install(options = {}) {
    if (!supported) {
      return { ok: false, status: unsupportedStatus(), error: "Desktop integration is available only for packaged Linux AppImages." };
    }
    const before = await getStatus();
    if (before.ownership === "external" && options.useExternalLauncher !== true) {
      return {
        ok: false,
        status: before,
        error: "This AppImage is managed by an external integration tool.",
      };
    }
    if (before.ownership === "external") {
      if (before.issues.includes("desktop-entry")) {
        return {
          ok: false,
          status: before,
          error: "The external launcher cannot accept browser callback URLs. Repair it with the tool that manages this AppImage.",
        };
      }
      if (!before.desktopEntryPath) {
        return {
          ok: false,
          status: before,
          error: "The external launcher path is unavailable.",
        };
      }
      const registration = await runCommand("xdg-mime", [
        "default",
        path.basename(before.desktopEntryPath),
        OPENWORK_PROTOCOL_MIME,
      ]);
      if (!registration.ok) {
        return {
          ok: false,
          status: await getStatus(),
          error: registration.stderr || "xdg-mime could not register the external launcher.",
        };
      }
      const status = await getStatus();
      if (status.state === "managed_externally") return { ok: true, status };
      return {
        ok: false,
        status,
        error: "The external launcher was not selected for openwork:// callbacks.",
      };
    }
    if (
      await fileExists(desktopEntryPath)
      && before.ownership !== "openwork"
    ) {
      return {
        ok: false,
        status: before,
        error: "The canonical OpenWork launcher is externally managed and will not be overwritten.",
      };
    }

    try {
      for (const size of ICON_SIZES) {
        await mkdir(path.dirname(iconPaths[size]), { recursive: true });
        await copyFile(iconSources[size], iconPaths[size]);
      }
      await atomicWrite(desktopEntryPath, buildOpenworkDesktopEntry({
        appImagePath,
        appName,
        appVersion: app.getVersion(),
        distribution,
      }));

      const state = await readState();
      if (before.handlerDesktopId && before.handlerDesktopId !== OPENWORK_DESKTOP_ID) {
        state.previousProtocolHandler = before.handlerDesktopId;
      }
      state.dismissedAppImages = state.dismissedAppImages.filter((candidate) => candidate !== appImagePath);
      await writeState(state);

      await refreshDesktopCaches();
      const registration = await runCommand("xdg-mime", ["default", OPENWORK_DESKTOP_ID, OPENWORK_PROTOCOL_MIME]);
      if (!registration.ok) {
        throw new Error(registration.stderr || "xdg-mime could not register openwork://.");
      }
      const status = await getStatus();
      if (status.state !== "integrated") {
        throw new Error("The desktop entry was installed, but the desktop did not select it as the openwork:// handler.");
      }
      return { ok: true, status };
    } catch (error) {
      return {
        ok: false,
        status: await getStatus(),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** @returns {Promise<DesktopIntegrationResult>} */
  async function remove() {
    if (!supported) {
      return { ok: false, status: unsupportedStatus(), error: "Desktop integration is unavailable." };
    }
    const before = await getStatus();
    if (before.ownership !== "openwork") {
      return {
        ok: false,
        status: before,
        error: before.ownership === "external"
          ? "Remove this AppImage with the tool that manages it."
          : "OpenWork does not own a desktop integration to remove.",
      };
    }

    try {
      const state = await readState();
      await rm(desktopEntryPath, { force: true });
      await Promise.all(Object.values(iconPaths).map((target) => rm(target, { force: true })));

      if (before.handlerDesktopId === OPENWORK_DESKTOP_ID) {
        const previousPath = await locateDesktopEntry(state.previousProtocolHandler);
        if (state.previousProtocolHandler && previousPath) {
          await runCommand("xdg-mime", ["default", state.previousProtocolHandler, OPENWORK_PROTOCOL_MIME]);
        } else {
          await removeDesktopAssociation(path.join(configHome, "mimeapps.list"), OPENWORK_DESKTOP_ID);
          await removeDesktopAssociation(path.join(dataHome, "applications", "mimeapps.list"), OPENWORK_DESKTOP_ID);
        }
      }

      state.previousProtocolHandler = null;
      if (!state.dismissedAppImages.includes(appImagePath)) state.dismissedAppImages.push(appImagePath);
      await writeState(state);
      await refreshDesktopCaches();
      return { ok: true, status: await getStatus() };
    } catch (error) {
      return {
        ok: false,
        status: await getStatus(),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async function shouldSkipPrompt() {
    if (!supported) return true;
    const state = await readState();
    return state.dismissedAppImages.includes(appImagePath);
  }

  async function rememberPromptDismissal() {
    if (!supported) return;
    const state = await readState();
    if (!state.dismissedAppImages.includes(appImagePath)) state.dismissedAppImages.push(appImagePath);
    await writeState(state);
  }

  async function maybePrompt(window) {
    const status = await getStatus();
    if (
      !status.supported
      || status.state === "integrated"
      || status.state === "managed_externally"
      || status.ownership === "external"
    ) {
      return status;
    }

    // The user already accepted this integration, so drift in the files OpenWork
    // owns is maintenance rather than a new decision. A self-update lands under a
    // new versioned filename and a moved AppImage changes its path; both stale the
    // launcher. Repair silently instead of prompting after every release.
    if (status.ownership === "openwork") {
      const repaired = await install();
      if (!repaired.ok) {
        console.warn("[desktop-integration] silent repair failed", repaired.error);
      }
      return repaired.status;
    }

    if (await shouldSkipPrompt()) return status;

    const { response, checkboxChecked } = await dialog.showMessageBox(window, {
      type: "question",
      title: "Add OpenWork to your applications?",
      message: "Add OpenWork to your application launcher and register browser sign-in callbacks?",
      detail: `The launcher will use this AppImage in its current location:\n${appImagePath}\n\nIf you move or update it later, OpenWork repairs the launcher automatically. You can change or remove this in Settings → Preferences → AppImage desktop integration.`,
      buttons: ["Not now", "Integrate"],
      defaultId: 1,
      cancelId: 0,
      checkboxLabel: "Don’t ask again for this AppImage",
      checkboxChecked: false,
    });

    if (response !== 1) {
      if (checkboxChecked) await rememberPromptDismissal();
      return status;
    }

    const result = await install();
    if (!result.ok) {
      await dialog.showMessageBox(window, {
        type: "warning",
        title: "Desktop integration failed",
        message: "OpenWork could not complete desktop integration.",
        detail: result.error ?? "Unknown error",
        buttons: ["OK"],
      });
    }
    return result.status;
  }

  return {
    getStatus,
    install,
    remove,
    maybePrompt,
    paths: {
      dataHome,
      configHome,
      desktopEntryPath,
      iconPaths,
      statePath,
    },
  };
}
