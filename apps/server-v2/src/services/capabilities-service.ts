import type { RequestActor } from "./auth-service.js";
import type { RuntimeService } from "./runtime-service.js";
import type { AuthService } from "./auth-service.js";

export type CapabilitiesData = {
  auth: ReturnType<AuthService["getSummary"]>;
  bundles: {
    fetch: true;
    publish: true;
    workspaceExport: true;
    workspaceImport: true;
  };
  cloud: {
    persistence: true;
    validation: true;
  };
  config: {
    projection: true;
    rawRead: true;
    rawWrite: true;
    read: true;
    write: true;
  };
  files: {
    artifacts: true;
    contentRoutes: true;
    fileSessions: true;
    inbox: true;
    mutations: true;
  };
  managed: {
    assignments: true;
    mcps: true;
    plugins: true;
    providerConfigs: true;
    skills: true;
  };
  reload: {
    manualEngineReload: true;
    reconciliation: true;
    watch: true;
    workspaceEvents: true;
  };
  registry: {
    backendResolution: true;
    hiddenWorkspaceFiltering: true;
    remoteServerConnections: true;
    remoteWorkspaceSync: true;
    serverInventory: true;
    workspaceDetail: true;
    workspaceList: true;
  };
  sessions: {
    events: true;
    list: true;
    messages: true;
    mutations: true;
    promptAsync: true;
    revertHistory: true;
  };
  runtime: {
    opencodeHealth: true;
    routerHealth: true;
    runtimeSummary: true;
    runtimeUpgrade: true;
    runtimeVersions: true;
  };
  router: {
    bindings: true;
    identities: true;
    outboundSend: true;
    productRoutes: true;
  };
  shares: {
    workspaceScoped: true;
  };
  workspaces: {
    activate: true;
    createLocal: true;
  };
  transport: {
    rootMounted: true;
    sdkPackage: "@openwork/server-sdk";
    v2: true;
  };
};

export type CapabilitiesService = ReturnType<typeof createCapabilitiesService>;

export function createCapabilitiesService(input: {
  auth: AuthService;
  runtime: RuntimeService;
}) {
  return {
    getCapabilities(actor: RequestActor): CapabilitiesData {
      const runtimeSummary = input.runtime.getRuntimeSummary();
      void runtimeSummary;
      return {
        auth: input.auth.getSummary(actor),
        bundles: {
          fetch: true,
          publish: true,
          workspaceExport: true,
          workspaceImport: true,
        },
        cloud: {
          persistence: true,
          validation: true,
        },
        config: {
          projection: true,
          rawRead: true,
          rawWrite: true,
          read: true,
          write: true,
        },
        files: {
          artifacts: true,
          contentRoutes: true,
          fileSessions: true,
          inbox: true,
          mutations: true,
        },
        managed: {
          assignments: true,
          mcps: true,
          plugins: true,
          providerConfigs: true,
          skills: true,
        },
        reload: {
          manualEngineReload: true,
          reconciliation: true,
          watch: true,
          workspaceEvents: true,
        },
        registry: {
          backendResolution: true,
          hiddenWorkspaceFiltering: true,
          remoteServerConnections: true,
          remoteWorkspaceSync: true,
          serverInventory: true,
          workspaceDetail: true,
          workspaceList: true,
        },
        sessions: {
          events: true,
          list: true,
          messages: true,
          mutations: true,
          promptAsync: true,
          revertHistory: true,
        },
        runtime: {
          opencodeHealth: true,
          routerHealth: true,
          runtimeSummary: true,
          runtimeUpgrade: true,
          runtimeVersions: true,
        },
        router: {
          bindings: true,
          identities: true,
          outboundSend: true,
          productRoutes: true,
        },
        shares: {
          workspaceScoped: true,
        },
        workspaces: {
          activate: true,
          createLocal: true,
        },
        transport: {
          rootMounted: true,
          sdkPackage: "@openwork/server-sdk",
          v2: true,
        },
      };
    },
  };
}
