import { execFile } from "node:child_process";
import { EvalError } from "../context.ts";
import type { FlowContext } from "../flow.ts";

export interface HostileGatewayFaultCase {
  faultId: string;
  claim: string;
  expectedProductSnippets: readonly string[];
}

export interface HostileGatewayProductEvidence {
  faultId: string;
  actionableImmediately: string;
  behavior: string;
  message: string;
  profileId: string;
}

interface HostileGatewayProductAssertion {
  actual: unknown;
  name: string;
  passed: boolean;
}

interface HostileGatewayProductPayload extends HostileGatewayProductEvidence {
  assertions: readonly HostileGatewayProductAssertion[];
  connect: unknown;
  diagnostic: unknown;
  denCallbackDiagnostic: unknown;
  fileReferences: readonly string[];
  productMessage: string;
  productSource: string;
  requestCounts: unknown;
}

interface HostileGatewayProductProcessResult {
  corroboratingMockProbe: unknown;
  failedAssertion: unknown;
  ok: boolean;
  product: HostileGatewayProductPayload;
}

export const hostileGatewayFaultIds: readonly string[] = [
  "redirect-uri-whitelist",
  "per-connector-redirect",
  "dcr-required",
  "method-405",
  "duplicate-amplification",
  "refresh-expired",
  "trailing-dot-url",
  "per-user-403",
];

export const hostileGatewayFaultCases: readonly HostileGatewayFaultCase[] = [
  {
    faultId: "redirect-uri-whitelist",
    claim: "OpenWork's real connect path shows today's redirect-whitelist surface, including the exact generated callback but not the provider's rejected-URI message.",
    expectedProductSnippets: ["The provider rejected the authorization request before issuing a code", "redirectUri"],
  },
  {
    faultId: "per-connector-redirect",
    claim: "OpenWork's real callback path reaches token exchange and currently collapses a per-connector redirect failure to the generic token-exchange diagnostic.",
    expectedProductSnippets: ["The authorization server rejected the code or token refresh exchange", "MCP_OAUTH_INVALID_GRANT"],
  },
  {
    faultId: "dcr-required",
    claim: "OpenWork's real connect path attempts dynamic client registration when advertised, then currently maps an authorization-time DCR-required error generically.",
    expectedProductSnippets: ["performed DCR", "dynamicRegistrations", "The provider rejected the authorization request before issuing a code"],
  },
  {
    faultId: "method-405",
    claim: "OpenWork's real connect path does not issue a GET to the MCP endpoint, so a GET-only 405 fault is latent in this user flow.",
    expectedProductSnippets: ["GET /mcp count 0", "needs_auth"],
  },
  {
    faultId: "duplicate-amplification",
    claim: "OpenWork sends one tools/call for one user action, but today's Den diagnostic loses the duplicate-upstream-request signal.",
    expectedProductSnippets: ["one MCP tools/call", "provider status 409", "MCP_PROVIDER_TOOL_ERROR"],
  },
  {
    faultId: "refresh-expired",
    claim: "OpenWork's real runtime attempts a refresh-token grant for expired credentials and currently reports a generic token/refresh exchange rejection.",
    expectedProductSnippets: ["refresh_token", "The authorization server rejected the code or token refresh exchange"],
  },
  {
    faultId: "trailing-dot-url",
    claim: "OpenWork's real client canonicalizes the trailing-dot authorization server before issuer discovery and still reaches authorization.",
    expectedProductSnippets: ["canonicalized", "needs_auth", "trailingDotRequests"],
  },
  {
    faultId: "per-user-403",
    claim: "OpenWork's real callback validation classifies a per-user 403 as provider authorization, but today's message does not name the subject.",
    expectedProductSnippets: ["provider policy denied", "MCP_PROVIDER_HTTP_403", "does not name"],
  },
];

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2).slice(0, 8_000);
  } catch {
    return String(value).slice(0, 8_000);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function assertionArray(value: unknown): readonly HostileGatewayProductAssertion[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.name !== "string" || typeof item.passed !== "boolean") return [];
    return [{ actual: item.actual, name: item.name, passed: item.passed }];
  });
}

function parseProductPayload(value: unknown, faultId: string): HostileGatewayProductPayload {
  if (!isRecord(value)) throw new EvalError(`Hostile gateway product probe returned no product payload for ${faultId}.`);
  const productMessage = typeof value.productMessage === "string" ? value.productMessage : "product probe returned no message";
  return {
    faultId: typeof value.faultId === "string" ? value.faultId : faultId,
    actionableImmediately: typeof value.actionableImmediately === "string" ? value.actionableImmediately : "Unknown",
    assertions: assertionArray(value.assertions),
    behavior: typeof value.behavior === "string" ? value.behavior : productMessage,
    connect: value.connect,
    denCallbackDiagnostic: value.denCallbackDiagnostic,
    diagnostic: value.diagnostic,
    fileReferences: stringArray(value.fileReferences),
    message: productMessage,
    productMessage,
    productSource: typeof value.productSource === "string" ? value.productSource : "unknown product source",
    profileId: typeof value.profileId === "string" ? value.profileId : "unknown-profile",
    requestCounts: value.requestCounts,
  };
}

function parseProductProcessResult(stdout: string, faultId: string): HostileGatewayProductProcessResult {
  const parsed: unknown = JSON.parse(stdout.trim());
  if (!isRecord(parsed) || typeof parsed.ok !== "boolean") {
    throw new EvalError(`Hostile gateway product probe returned an invalid payload for ${faultId}: ${stdout.slice(0, 500)}`);
  }
  return {
    corroboratingMockProbe: parsed.corroboratingMockProbe,
    failedAssertion: parsed.failedAssertion,
    ok: parsed.ok,
    product: parseProductPayload(parsed.product, faultId),
  };
}

function execFileText(command: string, args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new EvalError(`${command} ${args.slice(0, 4).join(" ")} failed: ${stderr || error.message}`));
        return;
      }
      resolve(stdout);
    });
  });
}

function mockProbeSucceeded(value: unknown): boolean {
  return isRecord(value) && value.ok === true;
}

async function runProductProcess(faultId: string): Promise<HostileGatewayProductProcessResult> {
  const stdout = await execFileText(
    "bun",
    ["--conditions=development", "evals/runner/journeys/gateway-product-probe.mjs", faultId],
    process.cwd(),
  );
  return parseProductProcessResult(stdout, faultId);
}

export async function hostileGatewayBunPrecondition(command = "bun"): Promise<string | false> {
  try {
    await execFileText(command, ["--version"], process.cwd());
    return false;
  } catch {
    return "bun is required for hostile-gateway-mcp because Den's Vite/Bun-flavored external-MCP route modules are imported in the product probe. Install bun 1.3.9+ or use oven-sh/setup-bun@v2.";
  }
}

export function hostileGatewayCaseById(faultId: string): HostileGatewayFaultCase {
  const faultCase = hostileGatewayFaultCases.find((candidate) => candidate.faultId === faultId);
  if (!faultCase) throw new EvalError(`Unknown hostile gateway fault case: ${faultId}`);
  return faultCase;
}

export function formatHostileGatewayFinding(product: HostileGatewayProductPayload, corroboratingMockProbe: unknown): string {
  return [
    `## ${product.faultId}`,
    `Primary source: ${product.productSource}`,
    `Profile: ${product.profileId}`,
    `Exact product output: ${product.productMessage}`,
    `Behavior: ${product.behavior}`,
    `Actionable immediately: ${product.actionableImmediately}`,
    `Request counts: ${safeJson(product.requestCounts)}`,
    `Diagnostic: ${safeJson(product.diagnostic ?? product.denCallbackDiagnostic ?? product.connect)}`,
    `Follow-up file/function references: ${product.fileReferences.join(", ")}`,
    `Corroborating mock probe: ${safeJson(corroboratingMockProbe)}`,
  ].join("\n\n");
}

export async function probeHostileGatewayFault(
  ctx: FlowContext,
  faultCase: HostileGatewayFaultCase,
): Promise<HostileGatewayProductEvidence> {
  const result = await runProductProcess(faultCase.faultId);
  const finding = formatHostileGatewayFinding(result.product, result.corroboratingMockProbe);
  const searchableProductText = `${finding}\n${safeJson(result.product)}`;
  ctx.output(`${faultCase.faultId}.json`, {
    product: result.product,
    corroboratingMockProbe: result.corroboratingMockProbe,
  });
  ctx.output(`${faultCase.faultId}-finding.md`, finding);

  for (const productAssertion of result.product.assertions) {
    ctx.recordEvidence({
      type: "assertion",
      status: productAssertion.passed ? "passed" : "failed",
      assertion: `${faultCase.faultId}: ${productAssertion.name}`,
      actual: productAssertion.actual,
    });
  }

  const missing = faultCase.expectedProductSnippets.filter((snippet) => !searchableProductText.includes(snippet));
  ctx.recordEvidence({
    type: "assertion",
    status: missing.length === 0 ? "passed" : "failed",
    assertion: `${faultCase.faultId}: product evidence includes the expected current-behavior transcript`,
    actual: missing.length === 0 ? faultCase.expectedProductSnippets : { missing, text: searchableProductText.slice(0, 1_000) },
  });
  ctx.recordEvidence({
    type: "assertion",
    status: mockProbeSucceeded(result.corroboratingMockProbe) ? "passed" : "failed",
    assertion: `${faultCase.faultId}: corroborating mock-server probe reproduced the configured hostile fault`,
    actual: result.corroboratingMockProbe,
  });

  if (!result.ok) throw new EvalError(`${faultCase.faultId} product assertion failed: ${safeJson(result.failedAssertion)}`);
  if (missing.length > 0) throw new EvalError(`${faultCase.faultId} product evidence missed expected text: ${missing.join(", ")}`);
  return {
    faultId: result.product.faultId,
    actionableImmediately: result.product.actionableImmediately,
    behavior: result.product.behavior,
    message: result.product.productMessage,
    profileId: result.product.profileId,
  };
}
