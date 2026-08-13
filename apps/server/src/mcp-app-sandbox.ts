const MAX_CSP_QUERY_BYTES = 8 * 1024;

export type McpAppSandboxCsp = {
  connectDomains: string[];
  resourceDomains: string[];
  frameDomains: string[];
  baseUriDomains: string[];
};

function sourceList(values: string[], fallback: string): string {
  return values.length ? values.join(" ") : fallback;
}

function safeOrigin(value: unknown): value is string {
  if (typeof value !== "string"
    || /\s/u.test(value)
    || value.includes(";")
    || value.includes("'")
    || value.includes(String.fromCharCode(34))) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.origin === value;
  } catch {
    return false;
  }
}

export function parseMcpAppSandboxCsp(value: string | null): McpAppSandboxCsp {
  if (!value || value.length > MAX_CSP_QUERY_BYTES) {
    return { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] };
  }
  try {
    const parsed = JSON.parse(value) as Partial<Record<keyof McpAppSandboxCsp, unknown>>;
    const domains = (key: keyof McpAppSandboxCsp) => Array.isArray(parsed[key])
      ? parsed[key].filter(safeOrigin).slice(0, 16)
      : [];
    return {
      connectDomains: domains("connectDomains"),
      resourceDomains: domains("resourceDomains"),
      frameDomains: domains("frameDomains"),
      baseUriDomains: domains("baseUriDomains"),
    };
  } catch {
    return { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] };
  }
}

export function buildMcpAppSandboxCsp(csp: McpAppSandboxCsp): string {
  const resources = csp.resourceDomains.join(" ");
  const withResources = (source: string) => resources ? `${source} ${resources}` : source;
  return [
    "default-src 'none'",
    `script-src ${withResources("'self' 'unsafe-inline'")}`,
    `style-src ${withResources("'self' 'unsafe-inline'")}`,
    `connect-src ${sourceList(csp.connectDomains, "'none'")}`,
    `img-src ${withResources("'self' data: blob:")}`,
    `font-src ${withResources("'self' data:")}`,
    `media-src ${withResources("'self' blob:")}`,
    `frame-src ${sourceList(["'self'", ...csp.frameDomains], "'self'")}`,
    `base-uri ${sourceList(csp.baseUriDomains, "'self'")}`,
    `worker-src ${withResources("'self' blob:")}`,
    "object-src 'none'",
    "form-action 'none'",
  ].join("; ");
}

export const MCP_APP_SANDBOX_PROXY_SCRIPT = String.raw`
(() => {
  if (window.self === window.top) throw new Error("Invalid MCP App sandbox embedding context.");
  const declaredHostOrigin = new URL(window.location.href).searchParams.get("hostOrigin");
  const referrerOrigin = document.referrer ? new URL(document.referrer).origin : null;
  if (declaredHostOrigin && referrerOrigin && declaredHostOrigin !== referrerOrigin) throw new Error("MCP App sandbox host origin mismatch.");
  const hostOrigin = referrerOrigin || declaredHostOrigin;
  if (!hostOrigin) throw new Error("MCP App sandbox host origin is unavailable.");
  const hostTargetOrigin = hostOrigin === "null" ? "*" : hostOrigin;
  const ownOrigin = window.location.origin;
  const notifyHost = (method, params = {}) => window.parent.postMessage({ jsonrpc: "2.0", method, params }, hostTargetOrigin);
  const inner = document.createElement("iframe");
  inner.title = "MCP App view";
  inner.style.cssText = "display:block;width:100%;height:100%;border:0;background:transparent";
  inner.setAttribute("sandbox", "allow-scripts allow-same-origin");
  let resourceAssigned = false;
  inner.addEventListener("load", () => {
    if (!resourceAssigned) return;
    let readyState = null;
    let hasHtmlRoot = null;
    let scriptCount = null;
    try {
      readyState = inner.contentDocument?.readyState || null;
      hasHtmlRoot = Boolean(inner.contentDocument?.documentElement);
      scriptCount = inner.contentDocument?.scripts.length ?? null;
    } catch {}
    notifyHost("ui/notifications/sandbox-resource-loaded", { readyState, hasHtmlRoot, scriptCount });
  });
  inner.addEventListener("error", () => {
    if (resourceAssigned) notifyHost("ui/notifications/sandbox-diagnostic", { code: "MCP_APP_SANDBOX_DOCUMENT_ERROR", message: "The sandbox iframe reported a document load error." });
  });
  document.body.appendChild(inner);
  window.addEventListener("message", (event) => {
    if (event.source === window.parent) {
      if (event.origin !== hostOrigin) return;
      if (event.data?.method === "ui/notifications/sandbox-resource-ready") {
        const html = event.data?.params?.html;
        const sandbox = event.data?.params?.sandbox;
        if (typeof sandbox === "string" && /^(?:allow-scripts|allow-same-origin|\s)+$/.test(sandbox)) inner.setAttribute("sandbox", sandbox);
        if (typeof html !== "string") {
          notifyHost("ui/notifications/sandbox-diagnostic", { code: "MCP_APP_SANDBOX_RESOURCE_INVALID", message: "The sandbox received an invalid HTML resource payload." });
          return;
        }
        try {
          resourceAssigned = true;
          inner.srcdoc = html;
          notifyHost("ui/notifications/sandbox-resource-accepted");
        } catch {
          notifyHost("ui/notifications/sandbox-diagnostic", { code: "MCP_APP_SANDBOX_RESOURCE_ASSIGNMENT_FAILED", message: "The sandbox could not assign the HTML resource to its isolated document." });
        }
        return;
      }
      inner.contentWindow?.postMessage(event.data, "*");
      return;
    }
    if (event.source === inner.contentWindow && event.origin === ownOrigin) {
      window.parent.postMessage(event.data, hostTargetOrigin);
    }
  });
  notifyHost("ui/notifications/sandbox-proxy-ready");
})();
`;

export const MCP_APP_SANDBOX_PROXY_HTML = "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><link rel=\"stylesheet\" href=\"/mcp-apps/sandbox.css\"><title>MCP App sandbox</title></head><body><script src=\"/mcp-apps/sandbox.js\"></script></body></html>";
export const MCP_APP_SANDBOX_PROXY_CSS = "html,body{width:100%;height:100%;margin:0;overflow:hidden;background:transparent}";
