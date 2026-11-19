import type { McpAuthorizationDebugDetails } from "../../(den)/dashboard/_components/mcp-authorization-url";

export function detailRows(details: McpAuthorizationDebugDetails): { label: string; value: string }[] {
  const rows: { label: string; value: string | number | boolean | undefined }[] = [
    {
      label: "HTTP status",
      value: details.httpStatus === "unavailable"
        ? "Unavailable — the browser could not read the response"
        : details.httpStatus,
    },
    { label: "Error code", value: details.errorCode },
    { label: "Diagnostic code", value: details.diagnosticCode },
    { label: "Diagnostic reference", value: details.diagnosticReference },
    { label: "Redirect URI", value: details.redirectUri },
    { label: "Client metadata URL", value: details.clientMetadataUrl },
    { label: "Handshake phase", value: details.phase },
    { label: "Highest step passed", value: details.highestPassed },
    { label: "Category", value: details.category },
    { label: "Retryable", value: details.retryable },
    { label: "Action owner", value: details.actionOwner },
    { label: "Recommended action", value: details.operatorAction },
    { label: "Provider status", value: details.providerStatus },
    { label: "Provider request ID", value: details.providerRequestId },
    { label: "Provider code", value: details.providerCode },
  ];
  return rows.flatMap((row) => row.value === undefined
    ? []
    : [{ label: row.label, value: String(row.value) }]);
}

export function fallbackCopy(value: string): boolean {
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.className = "fixed left-0 top-0 opacity-0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  return copied;
}
