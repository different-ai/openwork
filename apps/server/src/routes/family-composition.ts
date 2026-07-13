import {
  CONTRIBUTION_CONTRACT_VERSION,
  createContributionRegistry,
  type ContributionDescriptor,
  type RegistryDiagnostic,
  type RegistryDiagnosticCode,
} from "@openwork/contribution-registry";

import type { Route } from "./registry.js";

export const SERVER_ROUTE_FAMILY_CONTRACT_VERSION = CONTRIBUTION_CONTRACT_VERSION;

export interface ServerRouteFamilyDescriptor extends ContributionDescriptor {
  readonly kind: "server-route-family";
  readonly purpose: string;
}

/** Serializable metadata and executable registration deliberately stay separate. */
export interface ServerRouteFamilyContribution {
  readonly descriptor: ServerRouteFamilyDescriptor;
  readonly register: (routes: Route[]) => void;
}

export interface ComposedServerRouteFamily {
  readonly descriptor: Readonly<ServerRouteFamilyDescriptor>;
  readonly routes: readonly Route[];
}

export interface ServerRouteFamilyDiagnostic {
  readonly severity: "error";
  readonly code: RegistryDiagnosticCode | "family-registration-failed";
  readonly message: string;
  readonly familyId?: string;
  readonly relatedIds?: readonly string[];
}

export type ServerRouteFamilyCompositionResult =
  | Readonly<{
      status: "ready";
      descriptors: readonly Readonly<ServerRouteFamilyDescriptor>[];
      families: readonly ComposedServerRouteFamily[];
    }>
  | Readonly<{
      status: "invalid";
      descriptors: readonly Readonly<ServerRouteFamilyDescriptor>[];
      diagnostics: readonly ServerRouteFamilyDiagnostic[];
    }>;

const SERVER_ROUTE_PROVENANCE = Object.freeze({
  packageName: "openwork-server",
  source: "apps/server/src/routes",
});

function bundledDescriptor(
  id: string,
  order: number,
  purpose: string,
): ServerRouteFamilyDescriptor {
  return Object.freeze({
    id,
    kind: "server-route-family" as const,
    contractVersion: SERVER_ROUTE_FAMILY_CONTRACT_VERSION,
    provenance: SERVER_ROUTE_PROVENANCE,
    order,
    purpose,
  });
}

/**
 * This bounded catalog documents the legacy order without claiming that every
 * route or router in OpenWork belongs to one universal runtime.
 */
export const BUNDLED_SERVER_ROUTE_FAMILY_DESCRIPTORS = Object.freeze({
  core: bundledDescriptor(
    "server/routes/core",
    100,
    "Host health, capability, token, environment, and experimental extension routes.",
  ),
  workspaces: bundledDescriptor(
    "server/routes/workspaces",
    200,
    "Workspace creation, activation, display-name, and removal routes.",
  ),
  sessions: bundledDescriptor(
    "server/routes/sessions",
    300,
    "Workspace session read models and session-group routes.",
  ),
  operations: bundledDescriptor(
    "server/routes/operations",
    400,
    "Reload event, engine reload, and approval-operation routes.",
  ),
  files: bundledDescriptor(
    "server/routes/files",
    500,
    "Inbox, artifact, bounded file-session, and workspace file routes.",
  ),
});

const frozenArray = <Value>(values: readonly Value[]): readonly Value[] =>
  Object.freeze([...values]);

function diagnostic(
  code: ServerRouteFamilyDiagnostic["code"],
  message: string,
  familyId?: string,
  relatedIds?: readonly string[],
): ServerRouteFamilyDiagnostic {
  return Object.freeze({
    severity: "error" as const,
    code,
    message,
    ...(familyId === undefined ? {} : { familyId }),
    ...(relatedIds === undefined ? {} : { relatedIds: frozenArray(relatedIds) }),
  });
}

function fromRegistryDiagnostic(issue: RegistryDiagnostic): ServerRouteFamilyDiagnostic {
  return diagnostic(issue.code, issue.message, issue.contributionId, issue.relatedIds);
}

function failureMessage(cause: unknown): string {
  return cause instanceof Error && cause.message.trim()
    ? cause.message.trim()
    : "Unknown registration failure";
}

/**
 * Compose one server realm. Each registrar writes to an isolated staging array,
 * so one broken family cannot leak a partial route table into the host.
 */
export function composeServerRouteFamilies(
  contributions: readonly ServerRouteFamilyContribution[],
): ServerRouteFamilyCompositionResult {
  const registry = createContributionRegistry<
    ServerRouteFamilyDescriptor,
    undefined,
    readonly Route[]
  >({ supportedContractVersions: [SERVER_ROUTE_FAMILY_CONTRACT_VERSION] });

  registry.registerAll(contributions.map((contribution) => ({
    descriptor: contribution.descriptor,
    binding: {
      status: "ready" as const,
      create: () => {
        const routes: Route[] = [];
        contribution.register(routes);
        return frozenArray(routes);
      },
    },
  })));

  const frozen = registry.freeze();
  const descriptors = frozenArray(
    frozen.snapshot.entries.map((entry) => entry.descriptor),
  );
  if (frozen.status === "invalid") {
    return Object.freeze({
      status: "invalid",
      descriptors,
      diagnostics: frozenArray(frozen.snapshot.diagnostics.map(fromRegistryDiagnostic)),
    });
  }

  const families: ComposedServerRouteFamily[] = [];
  const diagnostics: ServerRouteFamilyDiagnostic[] = [];
  for (const result of registry.constructAll(undefined)) {
    if (result.status === "constructed") {
      families.push(Object.freeze({
        descriptor: result.descriptor,
        routes: result.value,
      }));
      continue;
    }
    const familyId = "descriptor" in result ? result.descriptor.id : result.id;
    const cause = result.status === "failed" ? `: ${failureMessage(result.cause)}` : "";
    diagnostics.push(diagnostic(
      "family-registration-failed",
      `Route family "${familyId}" failed to register${cause}.`,
      familyId,
    ));
  }

  return diagnostics.length > 0
    ? Object.freeze({
        status: "invalid",
        descriptors,
        diagnostics: frozenArray(diagnostics),
      })
    : Object.freeze({
        status: "ready",
        descriptors,
        families: frozenArray(families),
      });
}
