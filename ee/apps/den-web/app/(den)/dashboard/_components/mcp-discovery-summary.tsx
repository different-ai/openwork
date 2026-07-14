import type {
  ExternalMcpAuthType,
  ExternalMcpConfigurationDiscovery,
  ExternalMcpDiscoveryEvidenceSource,
} from "./mcp-connections-data";

const SOURCE_LABELS: Record<ExternalMcpDiscoveryEvidenceSource, string> = {
  live_protocol: "live MCP response",
  oauth_metadata: "OAuth metadata",
  plugin_manifest: "plugin declaration",
  openwork_preset: "OpenWork preset",
  unknown: "manual review",
};

const AUTH_LABELS: Record<ExternalMcpAuthType | "unknown", string> = {
  oauth: "OAuth",
  apikey: "API key",
  none: "No authentication",
  unknown: "Not advertised",
};

export function discoveredAuthType(
  discovery: ExternalMcpConfigurationDiscovery | null,
  fallback: ExternalMcpAuthType,
): ExternalMcpAuthType {
  return discovery && discovery.auth.kind !== "unknown" ? discovery.auth.kind : fallback;
}

export function discoveryAuthIsEditable(discovery: ExternalMcpConfigurationDiscovery | null): boolean {
  if (!discovery || discovery.auth.kind === "unknown") return true;
  return discovery.auth.confidence === "inferred" || discovery.auth.confidence === "unknown";
}

export function discoveryAuthControlCopy(discovery: ExternalMcpConfigurationDiscovery | null): string {
  if (!discovery || discovery.auth.kind === "unknown" || discovery.auth.confidence === "unknown") {
    return "The MCP server did not reliably advertise an authentication method. Confirm the choice with the provider documentation.";
  }
  switch (discovery.auth.confidence) {
    case "inferred":
      return "OpenWork inferred this from OAuth metadata. Confirm the choice with the provider documentation before continuing.";
    case "verified":
      return "Verified from the live MCP response and locked for this setup.";
    case "declared":
      return "Declared by the plugin and locked for this setup.";
    case "curated":
      return "Matched to an OpenWork preset and locked for this setup.";
  }
}

export function discoveryNeedsInput(
  discovery: ExternalMcpConfigurationDiscovery | null,
  placement: "api_key" | "oauth_client_id" | "oauth_client_secret",
): boolean {
  return discovery?.inputs.some((input) => input.placement === placement && input.required && input.supported) === true;
}

export function discoveryHasUnsupportedRequirements(discovery: ExternalMcpConfigurationDiscovery | null): boolean {
  return discovery?.support.status === "unsupported"
    || discovery?.oauth?.pkce === "missing"
    || discovery?.inputs.some((input) => input.required && !input.supported) === true
    || discovery?.transport.supported === false;
}

export function discoveryRegistrationCopy(discovery: ExternalMcpConfigurationDiscovery | null): string | null {
  switch (discovery?.oauth?.registration) {
    case "dynamic":
      return "This server advertises automatic OAuth app registration. No client ID or secret is needed before people sign in.";
    case "client_metadata_document":
      return "This server accepts a hosted OAuth client metadata document. OpenWork can continue without asking you for a client secret.";
    case "pre_registered":
      return discovery.oauth.clientSecretRequired
        ? "Create an OAuth app with the provider, then enter its client ID and client secret below."
        : "Create an OAuth app with the provider, then enter its client ID below. This provider advertises a public client, so a secret is not required.";
    case "unknown":
      return "The server did not advertise how OAuth clients are registered. You can enter a pre-registered client if the provider requires one.";
    default:
      return null;
  }
}

export function discoveryDocumentationLabel(url: string): string {
  try {
    return `Publisher-provided setup guide (${new URL(url).hostname})`;
  } catch {
    return "Publisher-provided setup guide";
  }
}

function supportLabel(discovery: ExternalMcpConfigurationDiscovery): string {
  if (discovery.oauth?.pkce === "missing") return "Provider OAuth is not compatible yet";
  switch (discovery.support.status) {
    case "auto_configurable":
      return "Ready to configure";
    case "needs_manual_oauth_client":
      return "OAuth app details needed";
    case "needs_values":
      return "Required value needed";
    case "needs_review":
      return "Review setup";
    case "unsupported":
      return "Manual setup required";
  }
}

function confidenceLabel(discovery: ExternalMcpConfigurationDiscovery): string {
  const confidence = discovery.auth.confidence === "unknown"
    ? "Unverified"
    : `${discovery.auth.confidence.slice(0, 1).toUpperCase()}${discovery.auth.confidence.slice(1)}`;
  return `${confidence} from ${SOURCE_LABELS[discovery.auth.source]}`;
}

export function McpDiscoverySummary({ discovery }: { discovery: ExternalMcpConfigurationDiscovery }) {
  const unsupportedInputs = discovery.inputs.filter((input) => input.required && !input.supported);
  const supportedInputs = discovery.inputs.filter((input) => input.required && input.supported);
  const visibleSupportedInputs = supportedInputs.slice(0, 12);
  const visibleUnsupportedInputs = unsupportedInputs.slice(0, 12);
  const visibleScopes = discovery.oauth?.scopes.slice(0, 24) ?? [];
  const visibleWarnings = discovery.warnings.slice(0, 8);
  const registrationCopy = discoveryRegistrationCopy(discovery);
  const scopeHeading = discovery.oauth?.scopesSource === "authorization_server"
    ? "Provider scope catalog"
    : "Requested OAuth permissions";

  return (
    <div className={`rounded-2xl border p-4 ${discoveryHasUnsupportedRequirements(discovery) ? "border-amber-200 bg-amber-50" : "border-emerald-100 bg-emerald-50/50"}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-[13px] font-semibold text-gray-900">{supportLabel(discovery)}</p>
          <p className="mt-0.5 text-[12px] leading-5 text-gray-500">{confidenceLabel(discovery)}</p>
        </div>
        <span className="rounded-full border border-gray-200 bg-white px-2.5 py-1 text-[11px] font-medium text-gray-700">
          {AUTH_LABELS[discovery.auth.kind]}
        </span>
      </div>

      {registrationCopy ? <p className="mt-3 text-[12px] leading-5 text-gray-600">{registrationCopy}</p> : null}

      {supportedInputs.length > 0 ? (
        <div className="mt-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-gray-400">OpenWork can collect</p>
          <ul className="mt-1.5 space-y-1 text-[12px] text-gray-600">
            {visibleSupportedInputs.map((input) => <li key={input.id}>• {input.label}{input.secret ? " (stored securely)" : ""}</li>)}
            {supportedInputs.length > visibleSupportedInputs.length ? <li>• {supportedInputs.length - visibleSupportedInputs.length} more required value(s)</li> : null}
          </ul>
        </div>
      ) : null}

      {unsupportedInputs.length > 0 ? (
        <div className="mt-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-amber-700">Not supported by Den yet</p>
          <ul className="mt-1.5 space-y-1 text-[12px] text-amber-800">
            {visibleUnsupportedInputs.map((input) => (
              <li key={input.id}>• {input.label}{input.variable ? ` (${input.variable})` : ""} — {input.placement.replaceAll("_", " ")}</li>
            ))}
            {unsupportedInputs.length > visibleUnsupportedInputs.length ? <li>• {unsupportedInputs.length - visibleUnsupportedInputs.length} more unsupported requirement(s)</li> : null}
          </ul>
        </div>
      ) : null}

      {discovery.oauth && discovery.oauth.scopes.length > 0 ? (
        <div className="mt-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-gray-400">{scopeHeading}</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {visibleScopes.map((scope) => (
              <span key={scope} className="rounded-full border border-gray-200 bg-white px-2 py-1 font-mono text-[10px] text-gray-600">{scope}</span>
            ))}
            {discovery.oauth.scopes.length > visibleScopes.length ? (
              <span className="rounded-full border border-gray-200 bg-white px-2 py-1 text-[10px] text-gray-600">+{discovery.oauth.scopes.length - visibleScopes.length} more</span>
            ) : null}
          </div>
        </div>
      ) : null}

      {discovery.warnings.length > 0 ? (
        <ul className="mt-3 space-y-1 text-[12px] leading-5 text-amber-800">
          {visibleWarnings.map((warning) => <li key={warning}>• {warning}</li>)}
          {discovery.warnings.length > visibleWarnings.length ? <li>• {discovery.warnings.length - visibleWarnings.length} more warning(s)</li> : null}
        </ul>
      ) : null}

      {discovery.oauth?.documentationUrl ? (
        <a
          href={discovery.oauth.documentationUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-3 inline-block text-[12px] font-medium text-gray-700 underline decoration-gray-300 underline-offset-4"
        >
          {discoveryDocumentationLabel(discovery.oauth.documentationUrl)}
        </a>
      ) : null}
    </div>
  );
}
