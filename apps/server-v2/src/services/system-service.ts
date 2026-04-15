import type { ProcessInfoAdapter } from "../adapters/process-info.js";
import type { DatabaseStatusProvider } from "../database/status-provider.js";
import { routeNamespaces, workspaceResourcePattern } from "../routes/route-paths.js";
import type { AuthService, RequestActor } from "./auth-service.js";
import type { CapabilitiesService } from "./capabilities-service.js";
import type { RuntimeService } from "./runtime-service.js";
import type { ServerRegistryService } from "./server-registry-service.js";
import type { WorkspaceRegistryService } from "./workspace-registry-service.js";

export type SystemService = ReturnType<typeof createSystemService>;

export function createSystemService(input: {
  auth: AuthService;
  capabilities: CapabilitiesService;
  environment: string;
  processInfo: ProcessInfoAdapter;
  database: DatabaseStatusProvider;
  runtime: RuntimeService;
  serverRegistry: ServerRegistryService;
  startedAt: Date;
  version: string;
  workspaceRegistry: WorkspaceRegistryService;
}) {
  const service = "openwork-server-v2" as const;
  const packageName = "openwork-server-v2" as const;

  return {
    getRootInfo() {
      return {
        service,
        packageName,
        version: input.version,
        environment: input.environment,
        routes: {
          ...routeNamespaces,
          workspaceResource: workspaceResourcePattern,
        },
        contract: {
          source: "hono-openapi" as const,
          openapiPath: routeNamespaces.openapi,
          sdkPackage: "@openwork/server-sdk" as const,
        },
      };
    },

    getCapabilities(actor: RequestActor) {
      return input.capabilities.getCapabilities(actor);
    },

    getHealth(now: Date = new Date()) {
      return {
        service,
        status: "ok" as const,
        startedAt: input.startedAt.toISOString(),
        uptimeMs: Math.max(0, now.getTime() - input.startedAt.getTime()),
        database: input.database.getStatus(),
      };
    },

    getStatus(actor: RequestActor, now: Date = new Date()) {
      const runtimeSummary = input.runtime.getRuntimeSummary();
      const registry = input.serverRegistry.summarize();
      return {
        auth: input.auth.getSummary(actor),
        capabilities: input.capabilities.getCapabilities(actor),
        database: input.database.getStatus(),
        environment: input.environment,
        registry,
        runtime: {
          opencode: {
            baseUrl: runtimeSummary.opencode.baseUrl,
            running: runtimeSummary.opencode.running,
            status: runtimeSummary.opencode.status,
            version: runtimeSummary.opencode.version,
          },
          router: {
            baseUrl: runtimeSummary.router.baseUrl,
            running: runtimeSummary.router.running,
            status: runtimeSummary.router.status,
            version: runtimeSummary.router.version,
          },
          source: runtimeSummary.source,
          target: runtimeSummary.target,
        },
        service,
        startedAt: input.startedAt.toISOString(),
        status: "ok" as const,
        uptimeMs: Math.max(0, now.getTime() - input.startedAt.getTime()),
        version: input.version,
      };
    },

    getMetadata(actor: RequestActor) {
      return {
        foundation: {
          phase: 10 as const,
          middlewareOrder: [
            "request-id",
            "request-context",
            "response-finalizer",
            "request-logger",
            "error-handler",
          ],
          routeNamespaces: {
            ...routeNamespaces,
            workspaceResource: workspaceResourcePattern,
          },
          database: input.database.getStatus(),
          startup: input.database.getStartupDiagnostics(),
        },
        requestContext: {
          actorKind: actor.kind,
          requestIdHeader: "X-Request-Id" as const,
        },
        runtime: {
          environment: input.processInfo.environment,
          hostname: input.processInfo.hostname,
          pid: input.processInfo.pid,
          platform: input.processInfo.platform,
          runtime: input.processInfo.runtime,
          runtimeVersion: input.processInfo.runtimeVersion,
        },
        runtimeSupervisor: input.runtime.getRuntimeSummary(),
        contract: {
          source: "hono-openapi" as const,
          openapiPath: routeNamespaces.openapi,
          sdkPackage: "@openwork/server-sdk" as const,
        },
      };
    },

    listServers() {
      return {
        items: input.serverRegistry.list({ includeBaseUrl: true }),
      };
    },

    listWorkspaces(options?: { includeHidden?: boolean }) {
      return {
        items: input.workspaceRegistry.list({ includeHidden: options?.includeHidden ?? false }),
      };
    },

    getWorkspace(workspaceId: string, options?: { includeHidden?: boolean }) {
      return input.workspaceRegistry.getById(workspaceId, { includeHidden: options?.includeHidden ?? false });
    },
  };
}
