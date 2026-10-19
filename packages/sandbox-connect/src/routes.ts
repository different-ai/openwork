import type { SandboxHttpsRoute, SandboxRoute, SandboxSshRoute } from "@openwork/sandbox";

/** The route contract lives in @openwork/sandbox; adapters implement it as `blocks.routes`. */
export type { SandboxRoute };
export type HttpsRoute = SandboxHttpsRoute;
export type SshRoute = SandboxSshRoute;

export interface RouteSummary { kind: SandboxRoute["kind"]; label: string }

export const summarize = (route: SandboxRoute): RouteSummary => ({ kind: route.kind, label: route.label });
