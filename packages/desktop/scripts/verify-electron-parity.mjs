import { app, BrowserWindow } from "electron";
import { appendFile, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, "..");
const packagesDir = path.resolve(desktopDir, "..");
const appDistIndex = path.resolve(packagesDir, "app", "dist", "index.html");
const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "openwork-electron-parity-"));
const evidenceDir = path.join(artifactRoot, "evidence");
const logPath = path.join(evidenceDir, "runner.log");

await mkdir(evidenceDir, { recursive: true });

process.env.OPENWORK_DEV_MODE = process.env.OPENWORK_DEV_MODE || "1";
process.env.OPENWORK_DATA_DIR = process.env.OPENWORK_DATA_DIR || path.join(artifactRoot, "orchestrator-data");
process.env.ELECTRON_RENDERER_URL = process.env.ELECTRON_RENDERER_URL || pathToFileURL(appDistIndex).toString();

const report = {
  ok: true,
  artifactRoot,
  screenshotPath: path.join(evidenceDir, "electron-parity-window.png"),
  checks: [],
};

async function log(message) {
  console.error(message);
  await appendFile(logPath, `${new Date().toISOString()} ${message}\n`, "utf8");
}

function pushResult(name, status, payload = {}) {
  report.checks.push({ name, status, ...payload });
}

async function withTimeout(name, promise, timeoutMs = 120000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out: ${name}`)), timeoutMs)),
  ]);
}

async function check(name, fn, options = { required: true }) {
  await log(`start ${name}`);
  try {
    const data = await withTimeout(name, Promise.resolve().then(fn));
    pushResult(name, "ok", { data });
    await log(`ok ${name}`);
    return data;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    pushResult(name, options.required ? "error" : "skipped", { error: message });
    await log(`${options.required ? "error" : "skip"} ${name}: ${message}`);
    if (options.required) {
      report.ok = false;
      throw error;
    }
    return null;
  }
}

async function waitForWindow(timeoutMs = 30000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const win = BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
      return win;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for Electron window");
}

async function waitForWindowLoad(win, timeoutMs = 30000) {
  if (!win.webContents.isLoadingMainFrame()) {
    return;
  }

  await Promise.race([
    new Promise((resolve) => win.webContents.once("did-finish-load", resolve)),
    new Promise((_, reject) =>
      win.webContents.once("did-fail-load", (_event, code, description) =>
        reject(new Error(`Window failed to load (${code}): ${description}`)),
      ),
    ),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for renderer load")), timeoutMs)),
  ]);
}

async function rendererEval(win, source) {
  return win.webContents.executeJavaScript(`(async () => (${source}))()`, true);
}

async function rendererCall(win, fnPath, arg) {
  const argSource = arg === undefined ? "" : JSON.stringify(arg);
  const source = arg === undefined ? `await ${fnPath}()` : `await ${fnPath}(${argSource})`;
  return rendererEval(win, source);
}

function authHeaders(info) {
  if (!info?.opencodeUsername || !info?.opencodePassword) {
    return {};
  }
  const encoded = Buffer.from(`${info.opencodeUsername}:${info.opencodePassword}`, "utf8").toString("base64");
  return { Authorization: `Basic ${encoded}` };
}

function bearerHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

process.on("uncaughtException", (error) => {
  void log(`uncaughtException: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
});

process.on("unhandledRejection", (error) => {
  void log(`unhandledRejection: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
});

await log(`artifactRoot=${artifactRoot}`);
await log(`renderer=${process.env.ELECTRON_RENDERER_URL}`);
await import("../dist/main/main.cjs");
await log("imported main bundle");

async function runChecks() {
  let win;
  let localWorkspaceDir;
  let importWorkspaceDir;
  let remoteWorkspaceId = null;

  try {
    win = await waitForWindow();
    await log("window ready");
    await waitForWindowLoad(win);
    await log(`window loaded url=${win.webContents.getURL()}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const image = await win.webContents.capturePage();
    await writeFile(report.screenshotPath, image.toPNG());
    await log(`screenshot=${report.screenshotPath}`);

    await check("renderer.bridge.available", async () => {
      const available = await rendererEval(win, "Boolean(window.openworkDesktop)");
      if (!available) throw new Error("window.openworkDesktop is missing");
      return { available };
    });

    await check("runtime.info", async () => {
      const info = await rendererCall(win, "window.openworkDesktop.runtime.getInfo");
      if (info.runtime !== "electron") throw new Error(`Unexpected runtime: ${info.runtime}`);
      return info;
    });

    await check("app.version", async () => {
      const version = await rendererCall(win, "window.openworkDesktop.app.getVersion");
      if (!version) throw new Error("Missing app version");
      return { version };
    });

    await check("deepLinks.pending", async () => {
      const urls = await rendererCall(win, "window.openworkDesktop.deepLinks.getPending");
      if (!Array.isArray(urls)) throw new Error("Pending deep links did not return an array");
      return { urls };
    });

    const bootstrap = await check("workspace.bootstrap", async () => {
      const result = await rendererCall(win, "window.openworkDesktop.workspace.bootstrap");
      if (!Array.isArray(result.workspaces)) throw new Error("workspace.bootstrap returned invalid payload");
      return result;
    });

    localWorkspaceDir = await mkdtemp(path.join(artifactRoot, "local-workspace-"));
    const localWorkspace = await check("workspace.local.create", async () => {
      const result = await rendererCall(win, "window.openworkDesktop.workspace.create", {
        folderPath: localWorkspaceDir,
        name: "Electron Parity Workspace",
        preset: "starter",
      });
      const created = result.workspaces.find((entry) => entry.path === localWorkspaceDir);
      if (!created) throw new Error("Failed to create local workspace");
      return created;
    });

    await check("workspace.displayName.update", async () => {
      const result = await rendererCall(win, "window.openworkDesktop.workspace.updateDisplayName", {
        workspaceId: localWorkspace.id,
        displayName: "Electron Worker",
      });
      const updated = result.workspaces.find((entry) => entry.id === localWorkspace.id);
      if (!updated || updated.displayName !== "Electron Worker") throw new Error("Display name was not updated");
      return updated;
    });

    await check("workspace.openwork.read-write", async () => {
      const before = await rendererCall(win, "window.openworkDesktop.workspace.openworkRead", {
        workspacePath: localWorkspaceDir,
      });
      await rendererCall(win, "window.openworkDesktop.workspace.openworkWrite", {
        workspacePath: localWorkspaceDir,
        config: {
          ...before,
          reload: { auto: true, resume: false },
        },
      });
      const after = await rendererCall(win, "window.openworkDesktop.workspace.openworkRead", {
        workspacePath: localWorkspaceDir,
      });
      if (!after.reload?.auto) throw new Error("workspace.openworkWrite did not persist reload.auto");
      return after;
    });

    await check("workspace.authorizedRoots.add", async () => {
      const extraRoot = path.join(localWorkspaceDir, "authorized-root");
      await mkdir(extraRoot, { recursive: true });
      await rendererCall(win, "window.openworkDesktop.workspace.addAuthorizedRoot", {
        workspacePath: localWorkspaceDir,
        folderPath: extraRoot,
      });
      const config = await rendererCall(win, "window.openworkDesktop.workspace.openworkRead", {
        workspacePath: localWorkspaceDir,
      });
      if (!config.authorizedRoots.includes(extraRoot)) throw new Error("Authorized root was not added");
      return { extraRoot };
    });

    const exportArchivePath = path.join(artifactRoot, "workspace-export.openwork-workspace");
    await check("workspace.export-import", async () => {
      const exported = await rendererCall(win, "window.openworkDesktop.workspace.exportConfig", {
        workspaceId: localWorkspace.id,
        outputPath: exportArchivePath,
      });
      importWorkspaceDir = await mkdtemp(path.join(artifactRoot, "imported-workspace-"));
      const imported = await rendererCall(win, "window.openworkDesktop.workspace.importConfig", {
        archivePath: exportArchivePath,
        targetDir: importWorkspaceDir,
        name: "Imported Electron Worker",
      });
      return { exported, importedCount: imported.workspaces.length };
    });

    await check("commandFiles.crud", async () => {
      await rendererCall(win, "window.openworkDesktop.commandFiles.write", {
        scope: "workspace",
        projectDir: localWorkspaceDir,
        command: { name: "electron-verify", description: "Parity verification command", template: "echo verify" },
      });
      const listed = await rendererCall(win, "window.openworkDesktop.commandFiles.list", {
        scope: "workspace",
        projectDir: localWorkspaceDir,
      });
      if (!listed.includes("electron-verify")) throw new Error("Command file not listed after write");
      await rendererCall(win, "window.openworkDesktop.commandFiles.delete", {
        scope: "workspace",
        projectDir: localWorkspaceDir,
        name: "electron-verify",
      });
      return { listedCount: listed.length };
    });

    await check("config.crud", async () => {
      await rendererCall(win, "window.openworkDesktop.config.writeOpencode", {
        scope: "project",
        projectDir: localWorkspaceDir,
        content: `${JSON.stringify({ $schema: "https://opencode.ai/config.json", plugin: ["opencode-scheduler"] }, null, 2)}\n`,
      });
      const updated = await rendererCall(win, "window.openworkDesktop.config.readOpencode", {
        scope: "project",
        projectDir: localWorkspaceDir,
      });
      if (!updated.content?.includes("opencode-scheduler")) throw new Error("Config write not persisted");
      return { path: updated.path };
    });

    await check("skills.crud", async () => {
      await rendererCall(win, "window.openworkDesktop.skills.installTemplate", {
        projectDir: localWorkspaceDir,
        name: "electron-parity",
        content: `---\nname: electron-parity\ndescription: parity test skill\n---\n\n# Electron Parity\n`,
        overwrite: true,
      });
      const listed = await rendererCall(win, "window.openworkDesktop.skills.listLocal", {
        projectDir: localWorkspaceDir,
      });
      if (!listed.some((entry) => entry.name === "electron-parity")) throw new Error("Installed skill missing from list");
      const importSource = path.join(artifactRoot, "import-skill", "imported-skill");
      await mkdir(importSource, { recursive: true });
      await writeFile(path.join(importSource, "SKILL.md"), `---\nname: imported-skill\ndescription: imported skill\n---\n\n# Imported\n`, "utf8");
      await rendererCall(win, "window.openworkDesktop.skills.importFromDirectory", {
        projectDir: localWorkspaceDir,
        sourceDir: importSource,
        overwrite: true,
      });
      await rendererCall(win, "window.openworkDesktop.skills.uninstall", {
        projectDir: localWorkspaceDir,
        name: "electron-parity",
      });
      return { listedCount: listed.length };
    });

    await check("engine.doctor", async () => rendererCall(win, "window.openworkDesktop.engine.doctor", { preferSidecar: true }));

    const engineStarted = await check("engine.direct.start", async () => {
      const started = await rendererCall(win, "window.openworkDesktop.engine.start", {
        projectDir: localWorkspaceDir,
        preferSidecar: true,
        runtime: "direct",
        workspacePaths: [localWorkspaceDir],
        opencodeBinPath: null,
      });
      const health = await fetch(`${started.baseUrl}/global/health`, { headers: authHeaders(started) });
      if (!health.ok) throw new Error(`Engine health failed: ${health.status}`);
      return started;
    });

    await check("openworkServer.restart", async () => {
      try {
        const info = await rendererCall(win, "window.openworkDesktop.openworkServer.restart");
        const health = await fetch(`${info.baseUrl}/health`, { headers: bearerHeaders(info.clientToken) });
        if (!health.ok) throw new Error(`OpenWork server health failed: ${health.status}`);
        return info;
      } catch (error) {
        const info = await rendererCall(win, "window.openworkDesktop.openworkServer.info");
        throw new Error(`${error instanceof Error ? error.message : String(error)} | info=${JSON.stringify(info)}`);
      }
    });

    await check("router.lifecycle", async () => {
      const started = await rendererCall(win, "window.openworkDesktop.router.start", {
        workspacePath: localWorkspaceDir,
        opencodeUrl: engineStarted.baseUrl,
        opencodeUsername: engineStarted.opencodeUsername,
        opencodePassword: engineStarted.opencodePassword,
      });
      const status = await rendererCall(win, "window.openworkDesktop.router.status");
      const groupsEnabled = await rendererCall(win, "window.openworkDesktop.router.getGroupsEnabled");
      await rendererCall(win, "window.openworkDesktop.router.setGroupsEnabled", { enabled: groupsEnabled === null ? false : groupsEnabled });
      await rendererCall(win, "window.openworkDesktop.router.stop");
      return { started, status };
    });

    await check("engine.stop", async () => rendererCall(win, "window.openworkDesktop.engine.stop"));

    await check("workspace.remote.stateFlow", async () => {
      const result = await rendererCall(win, "window.openworkDesktop.workspace.createRemote", {
        baseUrl: "http://127.0.0.1:40123",
        directory: "/tmp/remote-worker",
        displayName: "Remote Worker",
        remoteType: "opencode",
      });
      const remote = result.workspaces.find((entry) => entry.workspaceType === "remote" && entry.displayName === "Remote Worker");
      if (!remote) throw new Error("Remote workspace was not created");
      remoteWorkspaceId = remote.id;
      const updated = await rendererCall(win, "window.openworkDesktop.workspace.updateRemote", {
        workspaceId: remoteWorkspaceId,
        displayName: "Remote Worker Updated",
      });
      return updated.workspaces.find((entry) => entry.id === remoteWorkspaceId);
    });

    await check("orchestrator.status", async () => rendererCall(win, "window.openworkDesktop.orchestrator.status"));
    await check("updater.gating", async () => ({
      environment: await rendererCall(win, "window.openworkDesktop.updates.getEnvironment"),
      check: await rendererCall(win, "window.openworkDesktop.updates.check", { timeoutMs: 2000 }),
    }));
    await check("scheduler.listJobs", async () => rendererCall(win, "window.openworkDesktop.scheduler.listJobs"));
    const sandboxDoctor = await check("sandbox.doctor", async () => rendererCall(win, "window.openworkDesktop.orchestrator.sandboxDoctor"));
    await check("sandbox.cleanup", async () => rendererCall(win, "window.openworkDesktop.orchestrator.sandboxCleanupOpenworkContainers"));
    if (sandboxDoctor?.ready) {
      await check("sandbox.debugProbe", async () => rendererCall(win, "window.openworkDesktop.orchestrator.sandboxDebugProbe"), {
        required: false,
      });
    }

    await check("obsidian.mirror", async () => {
      const mirroredPath = await rendererCall(win, "window.openworkDesktop.obsidian.writeMirrorFile", {
        workspaceId: localWorkspace.id,
        filePath: "notes/test.md",
        content: "# Electron Parity\n",
      });
      const mirrored = await rendererCall(win, "window.openworkDesktop.obsidian.readMirrorFile", {
        workspaceId: localWorkspace.id,
        filePath: "notes/test.md",
      });
      if (!mirrored.exists || !mirrored.content?.includes("Electron Parity")) {
        throw new Error("Obsidian mirror round-trip failed");
      }
      return { mirroredPath };
    });

    await check("workspace.remote.cleanup", async () => {
      if (!remoteWorkspaceId) return { skipped: true };
      return rendererCall(win, "window.openworkDesktop.workspace.forget", { workspaceId: remoteWorkspaceId });
    });
  } catch (error) {
    report.ok = false;
    report.error = error instanceof Error ? error.message : String(error);
  } finally {
    await writeFile(path.join(evidenceDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await log(report.ok ? "report written" : `report error=${report.error}`);
    console.log(JSON.stringify(report, null, 2));
    app.exit(report.ok ? 0 : 1);
  }
}

void app.whenReady().then(runChecks).catch(async (error) => {
  report.ok = false;
  report.error = error instanceof Error ? error.message : String(error);
  await writeFile(path.join(evidenceDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await log(`fatal error=${report.error}`);
  console.error(JSON.stringify(report, null, 2));
  app.exit(1);
});
