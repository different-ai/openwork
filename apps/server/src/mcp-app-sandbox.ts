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
  // OpenWork delivery diagnostics are deliberately outside JSON-RPC so the
  // stable MCP Apps transport never mistakes them for protocol messages.
  const notifyHost = (method, params = {}) => window.parent.postMessage({ method, params }, hostTargetOrigin);
  function interactionBootstrap() {
    const call = Function.prototype.call.bind(Function.prototype.call);
    const listen = EventTarget.prototype.addEventListener;
    const readData = Object.getOwnPropertyDescriptor(MessageEvent.prototype, "data").get;
    const post = MessagePort.prototype.postMessage;
    const start = MessagePort.prototype.start;
    const now = performance.now.bind(performance);
    const timeOrigin = performance.timeOrigin;
    const focused = document.hasFocus.bind(document);
    const sendReady = window.parent.postMessage.bind(window.parent);
    const channel = new MessageChannel();
    const port = channel.port1;
    let lastClickAt = -Infinity;
    let active = true;
    call(listen, window, "click", (event) => {
      if (event.isTrusted && active) lastClickAt = timeOrigin + now();
    }, true);
    call(listen, window, "pagehide", (event) => {
      if (!event.isTrusted) return;
      active = false;
      lastClickAt = -Infinity;
    }, true);
    call(listen, port, "message", (event) => {
      if (!event.isTrusted) return;
      const data = call(readData, event);
      const elapsed = timeOrigin + now() - lastClickAt;
      const requestedElapsed = data.requestedAt - lastClickAt;
      const approved = active && focused() && elapsed >= 0 && elapsed <= 1500
        && requestedElapsed >= 0 && requestedElapsed <= 1500;
      lastClickAt = -Infinity;
      call(post, port, { id: data.id, approved });
    });
    call(start, port);
    sendReady({ method: "openwork/interaction-ready" }, "*", [channel.port2]);
  }
  const bootstrap = "<script>(" + interactionBootstrap.toString() + ")();<\/script>";
  let resourceAssigned = false;
  let generation = 0;
  let proofPort = null;
  let handshakeReceived = false;
  let nextProofId = 0;
  const pending = new Map();
  const resetProof = () => {
    generation++;
    if (proofPort) proofPort.close();
    proofPort = null;
    handshakeReceived = false;
    for (const cancel of pending.values()) cancel(false, false);
    pending.clear();
  };
  const createInner = () => {
    const frame = document.createElement("iframe");
    frame.title = "MCP App view";
    frame.style.cssText = "display:block;width:100%;height:100%;border:0;background:transparent";
    frame.setAttribute("sandbox", "allow-scripts");
    frame.addEventListener("load", () => {
      if (!resourceAssigned || frame !== inner) return;
      notifyHost("ui/notifications/sandbox-resource-loaded", { readyState: null, hasHtmlRoot: null, scriptCount: null });
    });
    frame.addEventListener("error", () => {
      if (resourceAssigned && frame === inner) notifyHost("ui/notifications/sandbox-diagnostic", { code: "MCP_APP_SANDBOX_DOCUMENT_ERROR", message: "The sandbox iframe reported a document load error." });
    });
    return frame;
  };
  let inner = createInner();
  const forwardToolCall = (data) => {
    const requestedAt = performance.timeOrigin + performance.now();
    const assignedGeneration = generation;
    const params = data.params && typeof data.params === "object" ? data.params : {};
    const meta = params._meta && typeof params._meta === "object" ? params._meta : {};
    const request = { ...data, params: { ...params, _meta: { ...meta, "openwork/userInteraction": false } } };
    const id = ++nextProofId;
    const finish = (approved, forward = true) => {
      if (!pending.delete(id)) return;
      clearTimeout(timer);
      if (!forward || assignedGeneration !== generation) return;
      request.params._meta["openwork/userInteraction"] = approved === true;
      window.parent.postMessage(request, hostTargetOrigin);
    };
    const timer = setTimeout(() => finish(false), 1000);
    pending.set(id, finish);
    if (!proofPort) {
      finish(false);
      return;
    }
    try {
      proofPort.postMessage({ id, requestedAt });
    } catch {
      finish(false);
    }
  };
  document.body.appendChild(inner);
  window.addEventListener("message", (event) => {
    if (event.source === window.parent) {
      if (event.origin !== hostOrigin) return;
      if (event.data?.method === "ui/notifications/sandbox-resource-ready") {
        const html = event.data?.params?.html;
        if (typeof html !== "string") {
          notifyHost("ui/notifications/sandbox-diagnostic", { code: "MCP_APP_SANDBOX_RESOURCE_INVALID", message: "The sandbox received an invalid HTML resource payload." });
          return;
        }
        try {
          resourceAssigned = false;
          resetProof();
          const previous = inner;
          inner = createInner();
          const doctype = html.match(/^\s*<!doctype\s+html\s*>/i)?.[0] || "";
          inner.srcdoc = doctype + bootstrap + html.slice(doctype.length);
          document.body.replaceChild(inner, previous);
          resourceAssigned = true;
          notifyHost("ui/notifications/sandbox-resource-accepted");
        } catch {
          notifyHost("ui/notifications/sandbox-diagnostic", { code: "MCP_APP_SANDBOX_RESOURCE_ASSIGNMENT_FAILED", message: "The sandbox could not assign the HTML resource to its isolated document." });
        }
        return;
      }
      inner.contentWindow?.postMessage(event.data, "*");
      return;
    }
    if (resourceAssigned && event.isTrusted && event.source === inner.contentWindow && event.origin === "null") {
      if (event.data?.method === "openwork/interaction-ready") {
        if (handshakeReceived) return;
        handshakeReceived = true;
        if (event.ports.length !== 1) return;
        proofPort = event.ports[0];
        const assignedGeneration = generation;
        proofPort.addEventListener("message", (reply) => {
          if (!reply.isTrusted || assignedGeneration !== generation) return;
          pending.get(reply.data?.id)?.(reply.data?.approved === true);
        });
        proofPort.start();
        return;
      }
      if (event.data?.method === "tools/call") {
        forwardToolCall(event.data);
        return;
      }
      window.parent.postMessage(event.data, hostTargetOrigin);
    }
  });
  window.parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready", params: {} }, hostTargetOrigin);
})();
`;

export const MCP_APP_SANDBOX_PROXY_CSS = "html,body{width:100%;height:100%;margin:0;overflow:hidden;background:transparent}";
// Readiness must not wait on extra network requests. In particular, a stylesheet
// before a classic script blocks its execution even when the script is downloaded.
// These are trusted host constants; provider HTML is delivered separately.
export const MCP_APP_SANDBOX_PROXY_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${MCP_APP_SANDBOX_PROXY_CSS}</style><title>MCP App sandbox</title></head><body><script>${MCP_APP_SANDBOX_PROXY_SCRIPT}</script></body></html>`;
