import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { createServerPersistence } from "./persistence.js";
import { runSpecificMigrations } from "./migrations/index.js";
import { ensureServerWorkingDirectoryLayout, resolveServerWorkingDirectory } from "./working-directory.js";

const cleanupPaths: string[] = [];

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (!target) {
      continue;
    }

    fs.rmSync(target, { force: true, recursive: true });
  }
});

function makeTempDir(name: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  cleanupPaths.push(directory);
  return directory;
}

function createPersistence(overrides: Partial<Parameters<typeof createServerPersistence>[0]> = {}) {
  return createServerPersistence({
    environment: "development",
    localServer: {
      baseUrl: null,
      hostingKind: "self_hosted",
      label: "Local OpenWork Server",
    },
    version: "0.0.0-test",
    ...overrides,
  });
}

test("fresh bootstrap seeds the local server and hidden workspaces", () => {
  const workingDirectory = makeTempDir("openwork-server-v2-phase2-fresh");
  const persistence = createPersistence({ workingDirectory });

  expect(persistence.diagnostics.mode).toBe("fresh");
  expect(persistence.repositories.servers.getById(persistence.registry.localServerId)).not.toBeNull();

  const hiddenWorkspaces = persistence.repositories.workspaces.list({ includeHidden: true }).filter((workspace) => workspace.isHidden);
  expect(hiddenWorkspaces.map((workspace) => workspace.kind).sort()).toEqual(["control", "help"]);
  for (const workspace of hiddenWorkspaces) {
    expect(workspace.configDir).toBeTruthy();
    expect(fs.existsSync(workspace.configDir!)).toBe(true);
  }

  persistence.close();
});

test("migration runner upgrades an existing database from the first migration", () => {
  const rootDir = makeTempDir("openwork-server-v2-phase2-upgrade");
  const workingDirectory = resolveServerWorkingDirectory({ environment: "development", explicitRootDir: rootDir });
  ensureServerWorkingDirectoryLayout(workingDirectory);
  const database = new Database(workingDirectory.databasePath, { create: true });
  runSpecificMigrations(database, ["0001"]);
  database.close(false);

  const persistence = createPersistence({ workingDirectory: rootDir });

  expect(persistence.diagnostics.mode).toBe("existing");
  expect(persistence.diagnostics.migrations.applied).toEqual(["0002", "0003"]);
  expect(persistence.repositories.providerConfigs.list()).toEqual([]);

  persistence.close();
});

test("legacy workspace import only runs once across repeated boots", () => {
  const rootDir = makeTempDir("openwork-server-v2-phase2-idempotent");
  const desktopDataDir = makeTempDir("openwork-server-v2-phase2-desktop");
  const orchestratorDataDir = makeTempDir("openwork-server-v2-phase2-orchestrator");
  const localWorkspaceDir = makeTempDir("openwork-server-v2-phase2-local-workspace");
  const orchestratorOnlyWorkspaceDir = makeTempDir("openwork-server-v2-phase2-orch-only-workspace");

  fs.writeFileSync(
    path.join(desktopDataDir, "openwork-workspaces.json"),
    JSON.stringify(
      {
        selectedWorkspaceId: "ws_legacy_selected",
        watchedWorkspaceId: "ws_legacy_selected",
        workspaces: [
          {
            id: "ws_legacy_selected",
            name: "Local Test",
            path: localWorkspaceDir,
            preset: "starter",
            workspaceType: "local",
          },
          {
            id: "ws_remote_legacy",
            name: "Remote Test",
            workspaceType: "remote",
            remoteType: "openwork",
            baseUrl: "https://remote.example.com/w/remote-one",
            openworkHostUrl: "https://remote.example.com",
            openworkWorkspaceId: "remote-one",
            openworkToken: "client-token",
          },
        ],
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(
    path.join(orchestratorDataDir, "openwork-orchestrator-state.json"),
    JSON.stringify(
      {
        activeId: "orch-1",
        cliVersion: "0.11.206",
        daemon: {
          baseUrl: "http://127.0.0.1:4321",
          pid: 123,
          port: 4321,
          startedAt: Date.now(),
        },
        opencode: {
          baseUrl: "http://127.0.0.1:4322",
          pid: 456,
          port: 4322,
          startedAt: Date.now(),
        },
        workspaces: [
          {
            id: "orch-1",
            name: "Local Test",
            path: localWorkspaceDir,
            workspaceType: "local",
          },
          {
            id: "orch-2",
            name: "Orchestrator Only",
            path: orchestratorOnlyWorkspaceDir,
            workspaceType: "local",
          },
        ],
      },
      null,
      2,
    ),
  );

  const first = createPersistence({
    legacy: {
      cloudSigninJson: JSON.stringify({
        authToken: "den-token",
        baseUrl: "https://app.openworklabs.com",
        userId: "user-1",
      }),
      desktopDataDir,
      orchestratorDataDir,
    },
    workingDirectory: rootDir,
  });

  const firstServers = first.repositories.servers.list();
  const firstVisibleWorkspaces = first.repositories.workspaces.list();
  expect(firstServers).toHaveLength(2);
  expect(firstVisibleWorkspaces).toHaveLength(3);
  expect(first.repositories.cloudSignin.getPrimary()?.cloudBaseUrl).toBe("https://app.openworklabs.com");
  first.close();

  const second = createPersistence({
    legacy: {
      desktopDataDir,
      orchestratorDataDir,
    },
    workingDirectory: rootDir,
  });

  expect(second.diagnostics.mode).toBe("existing");
  expect(second.repositories.servers.list()).toHaveLength(2);
  expect(second.repositories.workspaces.list()).toHaveLength(3);
  expect(second.repositories.workspaces.list({ includeHidden: true })).toHaveLength(5);
  expect(second.diagnostics.importReports.desktopWorkspaceState.status).toBe("skipped");
  expect(second.diagnostics.importReports.orchestratorState.status).toBe("skipped");
  expect(second.diagnostics.legacyWorkspaceImport.completedAt).toBeTruthy();
  expect(second.diagnostics.legacyWorkspaceImport.skipped).toBe(true);
  second.close();
});

test("deleted legacy-imported workspace stays deleted after restart", () => {
  const rootDir = makeTempDir("openwork-server-v2-phase2-delete-persist");
  const desktopDataDir = makeTempDir("openwork-server-v2-phase2-delete-desktop");
  const localWorkspaceDir = makeTempDir("openwork-server-v2-phase2-delete-workspace");

  fs.writeFileSync(
    path.join(desktopDataDir, "openwork-workspaces.json"),
    JSON.stringify(
      {
        selectedWorkspaceId: "ws_legacy_selected",
        workspaces: [
          {
            id: "ws_legacy_selected",
            name: "Local Test",
            path: localWorkspaceDir,
            preset: "starter",
            workspaceType: "local",
          },
        ],
      },
      null,
      2,
    ),
  );

  const first = createPersistence({
    legacy: {
      desktopDataDir,
    },
    workingDirectory: rootDir,
  });

  const normalizedWorkspaceDir = fs.realpathSync.native(localWorkspaceDir);
  const importedWorkspace = first.repositories.workspaces
    .list()
    .find((workspace) => workspace.dataDir === normalizedWorkspaceDir);
  expect(importedWorkspace).not.toBeUndefined();
  first.close();

  const second = createPersistence({
    legacy: {
      desktopDataDir,
    },
    workingDirectory: rootDir,
  });
  expect(second.diagnostics.importReports.desktopWorkspaceState.status).toBe("skipped");
  expect(second.repositories.workspaces.deleteById(importedWorkspace!.id)).toBe(true);
  expect(second.repositories.workspaces.list().some((workspace) => workspace.id === importedWorkspace!.id)).toBe(false);
  second.close();

  const third = createPersistence({
    legacy: {
      desktopDataDir,
    },
    workingDirectory: rootDir,
  });
  expect(third.diagnostics.importReports.desktopWorkspaceState.status).toBe("skipped");
  expect(third.repositories.workspaces.list().some((workspace) => workspace.id === importedWorkspace!.id)).toBe(false);
  third.close();
});

test("corrupt legacy workspace state is surfaced without blocking bootstrap", () => {
  const rootDir = makeTempDir("openwork-server-v2-phase2-corrupt");
  const desktopDataDir = makeTempDir("openwork-server-v2-phase2-corrupt-desktop");
  const orchestratorDataDir = makeTempDir("openwork-server-v2-phase2-corrupt-orchestrator");
  fs.writeFileSync(path.join(desktopDataDir, "openwork-workspaces.json"), "{not-json");

  const persistence = createPersistence({
    legacy: {
      desktopDataDir,
      orchestratorDataDir,
    },
    workingDirectory: rootDir,
  });

  expect(persistence.diagnostics.importReports.desktopWorkspaceState.status).toBe("error");
  expect(persistence.repositories.servers.list()).toHaveLength(1);
  expect(persistence.repositories.workspaces.list({ includeHidden: true })).toHaveLength(2);

  persistence.close();
});
