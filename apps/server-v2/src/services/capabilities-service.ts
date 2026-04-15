import type { RequestActor } from "./auth-service.js";
import type { RuntimeService } from "./runtime-service.js";
import type { AuthService } from "./auth-service.js";

export type CapabilitiesData = {
  auth: ReturnType<AuthService["getSummary"]>;
  registry: {
    backendResolution: true;
    hiddenWorkspaceFiltering: true;
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
    runtimeVersions: true;
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
        registry: {
          backendResolution: true,
          hiddenWorkspaceFiltering: true,
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
          runtimeVersions: true,
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
