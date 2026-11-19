import { z } from "zod";

const discoverySchema = z.object({
  status: z.enum(["ready", "manual_action_required", "unsupported", "unreachable"]),
  server: z.object({
    url: z.string(),
    protocolVersion: z.string().optional(),
    initialize: z.enum(["succeeded", "authentication_required", "failed"]),
  }),
  authentication: z.object({
    kind: z.enum(["none", "oauth", "manual_bearer", "unknown"]),
    availableRegistrationMethods: z.array(z.enum(["pre_registered", "client_metadata", "dynamic"])),
    recommendedRegistrationMethod: z.enum(["client_metadata", "dynamic", "pre_registered"]),
  }),
  tools: z.object({
    visibility: z.enum(["available_without_auth", "requires_auth", "unavailable"]),
    count: z.number().int().nonnegative().optional(),
  }),
  manualRequirements: z.array(z.object({
    code: z.string(),
    label: z.string(),
    reason: z.string(),
    required: z.boolean(),
  })),
});

/** What Den learned about an MCP server without registering or saving anything. */
export type DenMcpDiscovery = z.infer<typeof discoverySchema>;

export function parseDenMcpDiscovery(payload: unknown): DenMcpDiscovery | null {
  const parsed = discoverySchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

export type McpServerCheckId = "reach" | "protocol" | "sign-in" | "registration" | "tools";
export type McpServerCheckStatus = "pass" | "warn" | "fail" | "skip";

export type McpServerCheck = {
  id: McpServerCheckId;
  status: McpServerCheckStatus;
  /** Plain-words result, e.g. "Signs in with your account". */
  detail: string;
  /** The technical name, for people who know it, e.g. "OAuth · DCR". */
  term?: string;
};

export type McpServerCheckWords = {
  reachOk: string;
  reachFail: string;
  protocolOk: (version: string | undefined) => string;
  protocolFail: string;
  signInOauth: string;
  signInNone: string;
  signInKey: string;
  signInUnknown: string;
  registrationDynamic: string;
  registrationMetadata: string;
  registrationManual: string;
  toolsReady: (count: number) => string;
  toolsAfterSignIn: string;
  toolsNone: string;
};

/**
 * Turns Den's discovery into the rows the Add an MCP server checklist ticks
 * off. Registration only applies to servers that sign in with an account.
 */
export function mcpServerChecks(discovery: DenMcpDiscovery, words: McpServerCheckWords): McpServerCheck[] {
  const reached = discovery.status !== "unreachable";
  const spoke = discovery.server.initialize !== "failed";
  const auth = discovery.authentication;
  const checks: McpServerCheck[] = [
    { id: "reach", status: reached ? "pass" : "fail", detail: reached ? words.reachOk : words.reachFail },
    {
      id: "protocol",
      status: !reached ? "skip" : spoke ? "pass" : "fail",
      detail: spoke ? words.protocolOk(discovery.server.protocolVersion) : words.protocolFail,
      term: "MCP initialize",
    },
  ];
  if (!reached || !spoke) return checks;

  checks.push(
    auth.kind === "oauth"
      ? { id: "sign-in", status: "pass", detail: words.signInOauth, term: "OAuth" }
      : auth.kind === "none"
        ? { id: "sign-in", status: "pass", detail: words.signInNone }
        : auth.kind === "manual_bearer"
          ? { id: "sign-in", status: "pass", detail: words.signInKey, term: "Bearer token" }
          : { id: "sign-in", status: "warn", detail: words.signInUnknown },
  );
  if (auth.kind === "oauth") {
    const methods = auth.availableRegistrationMethods;
    checks.push(
      methods.includes("dynamic")
        ? { id: "registration", status: "pass", detail: words.registrationDynamic, term: "DCR" }
        : methods.includes("client_metadata")
          ? { id: "registration", status: "pass", detail: words.registrationMetadata, term: "CIMD" }
          : { id: "registration", status: "warn", detail: words.registrationManual, term: "Pre-registered client" },
    );
  }
  const tools = discovery.tools;
  checks.push(
    tools.visibility === "available_without_auth" && tools.count !== undefined
      ? { id: "tools", status: tools.count > 0 ? "pass" : "warn", detail: tools.count > 0 ? words.toolsReady(tools.count) : words.toolsNone }
      : tools.visibility === "requires_auth"
        ? { id: "tools", status: "pass", detail: words.toolsAfterSignIn }
        : { id: "tools", status: "warn", detail: words.toolsNone },
  );
  return checks;
}

/** Whether the member can go on: anything but an unreachable or non-MCP server. */
export function mcpServerChecksPassed(checks: McpServerCheck[]) {
  return checks.every((check) => check.status !== "fail");
}
