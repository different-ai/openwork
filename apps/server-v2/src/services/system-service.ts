import type { ProcessInfoAdapter } from "../adapters/process-info.js";
import type { DatabaseStatusProvider } from "../database/status-provider.js";
import { routeNamespaces, workspaceResourcePattern } from "../routes/route-paths.js";

export type SystemService = ReturnType<typeof createSystemService>;

export function createSystemService(input: {
  environment: string;
  processInfo: ProcessInfoAdapter;
  database: DatabaseStatusProvider;
  startedAt: Date;
  version: string;
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

    getHealth(now: Date = new Date()) {
      return {
        service,
        status: "ok" as const,
        startedAt: input.startedAt.toISOString(),
        uptimeMs: Math.max(0, now.getTime() - input.startedAt.getTime()),
        database: input.database.getStatus(),
      };
    },

    getMetadata() {
      return {
        foundation: {
          phase: 1 as const,
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
        },
        requestContext: {
          actorKind: "anonymous" as const,
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
        contract: {
          source: "hono-openapi" as const,
          openapiPath: routeNamespaces.openapi,
          sdkPackage: "@openwork/server-sdk" as const,
        },
      };
    },
  };
}
