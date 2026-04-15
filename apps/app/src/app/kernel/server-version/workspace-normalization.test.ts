// @ts-nocheck
import { expect, test } from "bun:test";
import {
  normalizeServerV2Capabilities,
  normalizeServerV2WorkspaceList,
} from "./normalize";

test("normalizeServerV2Capabilities exposes the migrated registry surface", () => {
  const capabilities = normalizeServerV2Capabilities({
    data: {
      auth: {
        actorKind: "client",
        configured: {
          clientToken: true,
          hostToken: true,
        },
        headers: {
          authorization: "Authorization",
          hostToken: "X-OpenWork-Host-Token",
        },
        required: true,
        scopes: {
          hiddenWorkspaceReads: "host",
          serverInventory: "host",
          visibleRead: "client_or_host",
        },
      },
      capabilities: {
        auth: {
          actorKind: "client",
          configured: {
            clientToken: true,
            hostToken: true,
          },
          headers: {
            authorization: "Authorization",
            hostToken: "X-OpenWork-Host-Token",
          },
          required: true,
          scopes: {
            hiddenWorkspaceReads: "host",
            serverInventory: "host",
            visibleRead: "client_or_host",
          },
        },
        registry: {
          backendResolution: true,
          hiddenWorkspaceFiltering: true,
          serverInventory: true,
          workspaceDetail: true,
          workspaceList: true,
        },
        runtime: {
          opencodeHealth: true,
          routerHealth: true,
          runtimeSummary: true,
          runtimeVersions: true,
        },
        transport: {
          rootMounted: true,
          sdkPackage: "@openwork/server-sdk",
          v2: true,
        },
      },
      database: {
        bootstrapMode: "fresh",
        configured: true,
        importWarnings: 0,
        kind: "sqlite",
        migrations: {
          appliedThisRun: [],
          currentVersion: "0002",
          totalApplied: 2,
        },
        path: ":memory:",
        phaseOwner: 2,
        status: "ready",
        summary: "ready",
        workingDirectory: ":memory:",
      },
      environment: "test",
      registry: {
        hiddenWorkspaceCount: 2,
        localServerId: "srv_local",
        remoteServerCount: 1,
        totalServers: 2,
        visibleWorkspaceCount: 2,
      },
      runtime: {
        opencode: { baseUrl: null, running: false, status: "disabled", version: null },
        router: { baseUrl: null, running: false, status: "disabled", version: null },
        source: "development",
        target: "darwin-arm64",
      },
      service: "openwork-server-v2",
      startedAt: "2026-04-14T00:00:00.000Z",
      status: "ok",
      uptimeMs: 100,
      version: "0.0.0-test",
    },
  });

  expect(capabilities.serverV2).toMatchObject({
    auth: {
      actorKind: "client",
      hostTokenConfigured: true,
      required: true,
    },
    registry: {
      workspaceList: true,
      workspaceDetail: true,
    },
    transport: {
      rootMounted: true,
      v2: true,
    },
  });
});

test("normalizeServerV2WorkspaceList keeps legacy remote connection compatibility at the boundary", () => {
  const normalized = normalizeServerV2WorkspaceList({
    legacyWorkspaceList: {
      selectedId: "ws_remote",
      watchedId: "ws_remote",
      workspaces: [
        {
          id: "ws_remote",
          name: "Legacy Remote",
          path: "",
          preset: "remote",
          workspaceType: "remote",
          remoteType: "openwork",
          baseUrl: "http://legacy-opencode.example/opencode",
          directory: "/srv/project",
          displayName: "Legacy Remote",
          openworkHostUrl: "https://remote.example.com",
          openworkToken: "legacy-token",
          openworkClientToken: "legacy-client",
          openworkHostToken: "legacy-host",
          openworkWorkspaceId: "remote-alpha",
          openworkWorkspaceName: "Remote Alpha",
        },
      ],
    },
    response: {
      data: {
        items: [
          {
            backend: {
              kind: "remote_openwork",
              local: null,
              remote: {
                directory: "/srv/project",
                hostUrl: "https://remote.example.com",
                remoteType: "openwork",
                remoteWorkspaceId: "remote-alpha",
                workspaceName: "Remote Alpha",
              },
              serverId: "srv_remote",
            },
            createdAt: "2026-04-14T00:00:00.000Z",
            displayName: "Remote Alpha",
            hidden: false,
            id: "ws_remote",
            kind: "remote",
            notes: null,
            preset: "remote",
            runtime: {
              backendKind: "remote_openwork",
              health: null,
              lastError: null,
              lastSessionRefreshAt: null,
              lastSyncAt: null,
              updatedAt: null,
            },
            server: {
              auth: { configured: true, scheme: "bearer" },
              baseUrl: null,
              capabilities: {},
              hostingKind: "self_hosted",
              id: "srv_remote",
              isEnabled: true,
              isLocal: false,
              kind: "remote",
              label: "remote.example.com",
              lastSeenAt: null,
              source: "imported",
              updatedAt: "2026-04-14T00:00:00.000Z",
            },
            slug: "remote-alpha",
            status: "ready",
            updatedAt: "2026-04-14T00:00:00.000Z",
          },
        ],
      },
    },
  });

  expect(normalized.selectedId).toBe("ws_remote");
  expect(normalized.workspaces[0]).toMatchObject({
    id: "ws_remote",
    workspaceType: "remote",
    openworkHostUrl: "https://remote.example.com",
    openworkToken: "legacy-token",
    openworkClientToken: "legacy-client",
    openworkHostToken: "legacy-host",
    openworkWorkspaceId: "remote-alpha",
  });
});
