import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type ServerWorkingDirectory = {
  databaseDir: string;
  databasePath: string;
  importsDir: string;
  managedDir: string;
  managedMcpDir: string;
  managedPluginDir: string;
  managedProviderDir: string;
  managedSkillDir: string;
  rootDir: string;
  runtimeDir: string;
  workspacesDir: string;
};

type ResolveServerWorkingDirectoryOptions = {
  environment: string;
  explicitRootDir?: string;
};

function isTruthy(value: string | undefined) {
  if (!value) {
    return false;
  }

  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function resolvePlatformDataRoot() {
  const home = os.homedir();
  const devMode = isTruthy(process.env.OPENWORK_DEV_MODE);
  const folderName = devMode ? "com.differentai.openwork.dev" : "com.differentai.openwork";

  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", folderName);
  }

  if (process.platform === "win32") {
    const appData = process.env.APPDATA?.trim() || path.join(home, "AppData", "Roaming");
    return path.join(appData, folderName);
  }

  const xdgDataHome = process.env.XDG_DATA_HOME?.trim() || path.join(home, ".local", "share");
  return path.join(xdgDataHome, folderName);
}

function resolveRootDir(options: ResolveServerWorkingDirectoryOptions) {
  if (options.explicitRootDir?.trim()) {
    return path.resolve(options.explicitRootDir.trim());
  }

  const override = process.env.OPENWORK_SERVER_V2_WORKDIR?.trim();
  if (override) {
    return path.resolve(override);
  }

  const sharedDataDir = process.env.OPENWORK_DATA_DIR?.trim();
  if (sharedDataDir) {
    return path.join(path.resolve(sharedDataDir), "server-v2");
  }

  if (options.environment === "test") {
    return path.join(process.cwd(), ".openwork-server-v2-test");
  }

  return path.join(resolvePlatformDataRoot(), "server-v2");
}

export function resolveServerWorkingDirectory(options: ResolveServerWorkingDirectoryOptions): ServerWorkingDirectory {
  const rootDir = resolveRootDir(options);
  const databaseDir = path.join(rootDir, "state");
  const managedDir = path.join(rootDir, "managed");

  return {
    databaseDir,
    databasePath: path.join(databaseDir, "openwork-server-v2.sqlite"),
    importsDir: path.join(rootDir, "imports"),
    managedDir,
    managedMcpDir: path.join(managedDir, "mcps"),
    managedPluginDir: path.join(managedDir, "plugins"),
    managedProviderDir: path.join(managedDir, "providers"),
    managedSkillDir: path.join(managedDir, "skills"),
    rootDir,
    runtimeDir: path.join(rootDir, "runtime"),
    workspacesDir: path.join(rootDir, "workspaces"),
  };
}

export function ensureServerWorkingDirectoryLayout(layout: ServerWorkingDirectory) {
  for (const directory of [
    layout.rootDir,
    layout.databaseDir,
    layout.importsDir,
    layout.managedDir,
    layout.managedMcpDir,
    layout.managedPluginDir,
    layout.managedProviderDir,
    layout.managedSkillDir,
    layout.runtimeDir,
    layout.workspacesDir,
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }
}

export function resolveWorkspaceConfigDir(layout: ServerWorkingDirectory, workspaceId: string) {
  return path.join(layout.workspacesDir, workspaceId, "config");
}

export function ensureWorkspaceConfigDir(layout: ServerWorkingDirectory, workspaceId: string) {
  const directory = resolveWorkspaceConfigDir(layout, workspaceId);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}
