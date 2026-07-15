export type ExternalMcpDiagnostic = {
  referenceId?: string;
  phase?: string;
  category?: string;
  code?: string;
  retryable?: boolean;
  actionOwner?: "openwork" | "network_admin" | "provider_admin" | "organization_admin" | "member";
  operatorAction?: string;
  message?: string;
  highestPassed?: "configured" | "reachable" | "authorized" | "protocol_ready" | "catalog_ready" | "operation_ready";
  httpStatus?: number;
  operationPhase?: string;
  providerStatus?: number;
  providerRequestId?: string;
  providerCode?: string;
};

type InspectionEvidence = {
  request?: unknown;
  response?: {
    status: number;
    headers?: Array<{ name: string; value: string; redacted: boolean }>;
  };
  diagnosis?: {
    layer?: string;
    summary?: string;
  };
};

type BrowserTimeoutEvidence = {
  timeoutMs: number;
  outcome: "unknown";
};

export type ExternalMcpFailureAttribution = {
  summary: string;
  lastConfirmedBoundary: string;
  likelySource: string;
  confidence: "Confirmed" | "Inferred";
  retryGuidance: string;
  outcome: "failed" | "unknown";
  diagnosticReference?: string;
  providerRequestId?: string;
  diagnosticCode?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalActionOwner(value: unknown): ExternalMcpDiagnostic["actionOwner"] {
  if (
    value === "openwork"
    || value === "network_admin"
    || value === "provider_admin"
    || value === "organization_admin"
    || value === "member"
  ) return value;
  return undefined;
}

function optionalHighestPassed(value: unknown): ExternalMcpDiagnostic["highestPassed"] {
  if (
    value === "configured"
    || value === "reachable"
    || value === "authorized"
    || value === "protocol_ready"
    || value === "catalog_ready"
    || value === "operation_ready"
  ) return value;
  return undefined;
}

export function parseExternalMcpDiagnostic(value: unknown): ExternalMcpDiagnostic | null {
  if (!isRecord(value)) return null;

  const referenceId = optionalString(value.referenceId);
  const phase = optionalString(value.phase);
  const category = optionalString(value.category);
  const code = optionalString(value.code);
  const actionOwner = optionalActionOwner(value.actionOwner);
  const operatorAction = optionalString(value.operatorAction);
  const message = optionalString(value.message);
  const highestPassed = optionalHighestPassed(value.highestPassed);
  const httpStatus = optionalNumber(value.httpStatus);
  const operationPhase = optionalString(value.operationPhase);
  const providerStatus = optionalNumber(value.providerStatus);
  const providerRequestId = optionalString(value.providerRequestId);
  const providerCode = optionalString(value.providerCode);
  const diagnostic: ExternalMcpDiagnostic = {
    ...(referenceId ? { referenceId } : {}),
    // Keep unknown future phases/categories as safe strings so an older
    // dashboard can still show the reference and fall back to wire evidence.
    ...(phase ? { phase } : {}),
    ...(category ? { category } : {}),
    ...(code ? { code } : {}),
    ...(typeof value.retryable === "boolean" ? { retryable: value.retryable } : {}),
    ...(actionOwner ? { actionOwner } : {}),
    ...(operatorAction ? { operatorAction } : {}),
    ...(message ? { message } : {}),
    ...(highestPassed ? { highestPassed } : {}),
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(operationPhase ? { operationPhase } : {}),
    ...(providerStatus !== undefined ? { providerStatus } : {}),
    ...(providerRequestId ? { providerRequestId } : {}),
    ...(providerCode ? { providerCode } : {}),
  };

  return Object.keys(diagnostic).length > 0 ? diagnostic : null;
}

function providerRequestIdFromInspection(inspection: InspectionEvidence | null): string | undefined {
  const requestIdHeaders = new Set([
    "x-ms-request-id",
    "x-ms-correlation-request-id",
    "x-servicenow-request-id",
    "x-correlation-id",
    "x-transaction-id",
    "request-id",
    "x-request-id",
  ]);
  return inspection?.response?.headers?.find((header) => (
    !header.redacted
    && requestIdHeaders.has(header.name.toLowerCase())
    && header.value.trim().length > 0
  ))?.value;
}

function unknownOutcomeGuidance(mayHaveSideEffects: boolean): string {
  return mayHaveSideEffects
    ? "Do not retry immediately. This tool may have changed external data; verify provider state before trying again."
    : "The first call may still finish. Check recent provider activity before retrying.";
}

function lastBoundaryFromDiagnostic(diagnostic: ExternalMcpDiagnostic | null): string | undefined {
  if (diagnostic?.highestPassed === "operation_ready") return "Den started remote tool execution";
  if (diagnostic?.highestPassed === "catalog_ready") return "Den loaded the remote MCP tool catalog";
  if (diagnostic?.highestPassed === "protocol_ready") return "Den initialized the remote MCP session";
  if (diagnostic?.highestPassed === "authorized") return "Remote MCP accepted the connection credential";
  if (diagnostic?.highestPassed === "reachable") return "Den reached the remote MCP endpoint";
  if (diagnostic?.highestPassed === "configured") return "Den loaded the MCP connection configuration";
  return undefined;
}

function diagnosticDetails(diagnostic: ExternalMcpDiagnostic | null, inspection: InspectionEvidence | null) {
  const providerRequestId = diagnostic?.providerRequestId ?? providerRequestIdFromInspection(inspection);
  return {
    ...(diagnostic?.referenceId ? { diagnosticReference: diagnostic.referenceId } : {}),
    ...(providerRequestId ? { providerRequestId } : {}),
    ...(diagnostic?.code || diagnostic?.category
      ? { diagnosticCode: diagnostic.code ?? diagnostic.category }
      : {}),
  };
}

export function attributeExternalMcpToolFailure(input: {
  diagnostic: ExternalMcpDiagnostic | null;
  inspection: InspectionEvidence | null;
  browserTimeout: BrowserTimeoutEvidence | null;
  mayHaveSideEffects: boolean;
}): ExternalMcpFailureAttribution {
  const { browserTimeout, diagnostic, inspection, mayHaveSideEffects } = input;
  const details = diagnosticDetails(diagnostic, inspection);

  if (browserTimeout) {
    const seconds = browserTimeout.timeoutMs / 1000;
    const duration = Number.isInteger(seconds) ? `${seconds}` : seconds.toFixed(1);
    return {
      summary: `The OpenWork dashboard stopped waiting for Den after ${duration} seconds. The operation’s outcome is unknown.`,
      lastConfirmedBoundary: "Dashboard started the request to Den",
      likelySource: "Den, the network path, the remote MCP, or the downstream tool",
      confidence: "Inferred",
      retryGuidance: unknownOutcomeGuidance(mayHaveSideEffects),
      outcome: "unknown",
      ...details,
    };
  }

  const blockedBeforeSend = diagnostic?.category === "security_blocked"
    || diagnostic?.code === "MCP_URL_BLOCKED"
    || diagnostic?.code === "MCP_FETCH_FORBIDDEN_PORT";
  if (blockedBeforeSend) {
    return {
      summary: "OpenWork blocked the request before it left Den.",
      lastConfirmedBoundary: "Den evaluated the outbound request",
      likelySource: "OpenWork policy or connection configuration",
      confidence: "Confirmed",
      retryGuidance: diagnostic?.operatorAction ?? "Resolve the OpenWork policy or connection configuration, then run the tool again.",
      outcome: "failed",
      ...details,
    };
  }

  const responseStatus = inspection?.response?.status ?? diagnostic?.httpStatus;
  if (responseStatus !== undefined && (responseStatus < 200 || responseStatus >= 300)) {
    const retryableStatus = responseStatus === 408 || responseStatus === 429 || responseStatus === 502
      || responseStatus === 503 || responseStatus === 504;
    return {
      summary: `The remote MCP returned HTTP ${responseStatus}.`,
      lastConfirmedBoundary: `Remote MCP returned HTTP ${responseStatus}`,
      likelySource: "Remote MCP HTTP layer",
      confidence: "Confirmed",
      retryGuidance: mayHaveSideEffects && (responseStatus === 408 || responseStatus === 504)
        ? "Check the remote MCP or provider for a completed operation before retrying this tool."
        : diagnostic?.operatorAction
          ?? (diagnostic?.retryable || retryableStatus
            ? "Retry with bounded backoff after confirming the operation is safe to repeat."
            : "Inspect the remote MCP response and configuration before retrying."),
      outcome: "failed",
      ...details,
    };
  }

  const providerFailure = diagnostic?.phase?.startsWith("PROVIDER_")
    || diagnostic?.providerStatus !== undefined
    || diagnostic?.providerCode !== undefined;
  if (providerFailure) {
    return {
      summary: "The remote MCP responded, but the downstream provider rejected the operation.",
      lastConfirmedBoundary: responseStatus !== undefined
        ? `Remote MCP returned HTTP ${responseStatus} with a tool error`
        : "Remote MCP returned a tool error",
      likelySource: "Downstream provider or tool",
      confidence: "Confirmed",
      retryGuidance: diagnostic?.operatorAction
        ?? (diagnostic?.retryable
          ? "Retry with bounded backoff after checking the provider status."
          : "Resolve the provider error before retrying."),
      outcome: "failed",
      ...details,
    };
  }

  const deadlineAfterSend = Boolean(inspection?.request)
    && !inspection?.response
    && (diagnostic?.code === "MCP_LIFECYCLE_DEADLINE" || diagnostic?.code === "MCP_REQUEST_TIMEOUT");
  if (deadlineAfterSend) {
    return {
      summary: "Den sent the request, but the remote MCP did not respond before OpenWork’s deadline.",
      lastConfirmedBoundary: "Den started the outbound tools/call",
      likelySource: "Network path or remote MCP after Den",
      confidence: "Inferred",
      retryGuidance: unknownOutcomeGuidance(mayHaveSideEffects),
      outcome: "unknown",
      ...details,
    };
  }

  if (inspection?.request && !inspection.response) {
    return {
      summary: "Den started the outbound request, but no HTTP response was captured. This does not prove the remote MCP caused the failure.",
      lastConfirmedBoundary: "Den started the outbound tools/call",
      likelySource: "Den outbound path, network, or remote MCP",
      confidence: "Inferred",
      retryGuidance: unknownOutcomeGuidance(mayHaveSideEffects),
      outcome: "unknown",
      ...details,
    };
  }

  if (inspection?.response) {
    return {
      summary: inspection.diagnosis?.summary ?? "The remote MCP responded, but the tool result was not successful.",
      lastConfirmedBoundary: `Remote MCP returned HTTP ${inspection.response.status}`,
      likelySource: "MCP protocol or tool result",
      confidence: "Inferred",
      retryGuidance: diagnostic?.operatorAction ?? "Inspect the MCP tool result and diagnostic reference before retrying.",
      outcome: "failed",
      ...details,
    };
  }

  const networkSetup = diagnostic?.phase?.startsWith("NETWORK_") || inspection?.diagnosis?.layer === "network";
  return {
    summary: inspection?.diagnosis?.summary
      ?? diagnostic?.message
      ?? "The request failed before OpenWork received a tool result.",
    lastConfirmedBoundary: lastBoundaryFromDiagnostic(diagnostic)
      ?? (diagnostic ? "Den returned a structured diagnostic" : "Dashboard started the request to Den"),
    likelySource: networkSetup ? "Den connection path or remote MCP setup" : "OpenWork or MCP connection setup",
    confidence: "Inferred",
    retryGuidance: diagnostic?.operatorAction ?? "Use the diagnostic reference to inspect Den and MCP connection health before retrying.",
    outcome: "failed",
    ...details,
  };
}
