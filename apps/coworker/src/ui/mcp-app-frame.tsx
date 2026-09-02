import { useEffect, useRef, useState } from "react";
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { coworkerBridge } from "@/lib/bridge";
import {
  CoworkerMcpError,
  isRecord,
  type CoworkerMcpAppResource,
  type CoworkerMcpClient,
  type PreservedMcpAppResult,
} from "@/lib/mcp";
import { ErrorNote } from "@/ui/kit";

const MIN_HEIGHT = 160;
const MAX_HEIGHT = 680;
const DEFAULT_HEIGHT = 300;
const SANDBOX_READY_TIMEOUT_MS = 5_000;
const RESOURCE_ACCEPT_TIMEOUT_MS = 1_000;
const MAX_RESOURCE_SEND_ATTEMPTS = 2;
const INITIALIZE_TIMEOUT_MS = 10_000;

function cspSource(values: string[]): string {
  return values.length > 0 ? values.join(" ") : "'none'";
}

function buildCsp(app: CoworkerMcpAppResource): string {
  const resources = app.csp.resourceDomains.join(" ");
  const withResources = (base: string) => resources ? `${base} ${resources}` : base;
  return [
    "default-src 'none'",
    `script-src ${withResources("'unsafe-inline'")}`,
    `style-src ${withResources("'unsafe-inline'")}`,
    `img-src ${withResources("data: blob:")}`,
    `font-src ${withResources("data:")}`,
    `media-src ${withResources("blob:")}`,
    `connect-src ${cspSource(app.csp.connectDomains)}`,
    `frame-src ${cspSource(app.csp.frameDomains)}`,
    `base-uri ${cspSource(app.csp.baseUriDomains)}`,
    "object-src 'none'",
    "form-action 'none'",
  ].join("; ");
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

function secureHtml(app: CoworkerMcpAppResource): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(buildCsp(app))}">`;
  const html = /<html(?:\s[^>]*)?>/i.exec(app.html);
  if (html?.index !== undefined) {
    const prefix = app.html.slice(0, html.index).replace(/^\uFEFF/, "");
    if (!/^\s*(?:<!doctype\s+html\s*>)?\s*$/i.test(prefix)) {
      throw new Error("The MCP App contains markup before its HTML root.");
    }
    const htmlEnd = html.index + html[0].length;
    const head = /<head(?:\s[^>]*)?>/i.exec(app.html);
    if (head?.index !== undefined) {
      if (head.index < htmlEnd || app.html.slice(htmlEnd, head.index).trim()) {
        throw new Error("The MCP App contains markup before its policy-bearing head.");
      }
      const headEnd = head.index + head[0].length;
      return `${app.html.slice(0, headEnd)}${meta}${app.html.slice(headEnd)}`;
    }
    const body = /<body(?:\s[^>]*)?>/i.exec(app.html);
    if (body?.index !== undefined && (body.index < htmlEnd || app.html.slice(htmlEnd, body.index).trim())) {
      throw new Error("The MCP App contains markup before its policy-bearing head.");
    }
    return `${app.html.slice(0, htmlEnd)}<head>${meta}</head>${app.html.slice(htmlEnd)}`;
  }
  return `<!doctype html><html><head>${meta}</head><body>${app.html}</body></html>`;
}

function asToolResult(result: PreservedMcpAppResult): CallToolResult {
  // The server validates every block. The SDK's union is narrower than the
  // JSON-preserving transport type used by OpenWork, so this is the boundary.
  return result as CallToolResult;
}

export function McpAppFrame({
  client,
  app,
  toolName,
  input,
  result,
  onClose,
}: {
  client: CoworkerMcpClient;
  app: CoworkerMcpAppResource;
  toolName: string;
  input: Record<string, unknown>;
  result: PreservedMcpAppResult;
  onClose?: () => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const closeRef = useRef(onClose);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  closeRef.current = onClose;

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe?.contentWindow) return;
    setReady(false);
    let disposed = false;
    let failed = false;
    const sandbox = client.sandboxFor(app, window.location.origin);
    if (sandbox.expectedOrigin === window.location.origin) {
      setError("OpenWork could not isolate this interactive App from the host window.");
      return;
    }

    const bridge = new AppBridge(
      null,
      { name: "Open Coworker", version: "1.0.0" },
      { serverTools: {} },
      { hostContext: { theme: "dark", displayMode: "inline" } },
    );
    bridge.onopenlink = async ({ url }) => {
      try {
        const result = await coworkerBridge.openUntrustedExternal(url);
        if (!result.ok) return { isError: true };
        return {};
      } catch {
        return { isError: true };
      }
    };
    bridge.onsizechange = ({ height: requestedHeight }) => {
      if (requestedHeight === undefined || !Number.isFinite(requestedHeight)) return;
      setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(requestedHeight))));
    };
    bridge.onrequestteardown = () => closeRef.current?.();
    bridge.oncalltool = async ({ name, arguments: argumentsValue }) => {
      const request = {
        serverName: app.serverName,
        name,
        resourceUri: app.resourceUri,
        arguments: argumentsValue,
      };
      try {
        return asToolResult(await client.callAppTool(request));
      } catch (cause) {
        if (!(cause instanceof CoworkerMcpError) || cause.code !== "tool_requires_approval") throw cause;
        const approved = window.confirm(`Allow this App to use ${name} on ${app.serverName} once?`);
        if (!approved) throw new Error("You declined this App tool call.");
        return asToolResult(await client.callAppTool({ ...request, approved: true }));
      }
    };
    let resourceDeliveryTimer: number | undefined;
    let initializeTimer: number | undefined;
    let initialized = false;
    let resourceAccepted = false;
    let resourceSendAttempts = 0;
    const fail = (message: string) => {
      if (disposed || failed) return;
      failed = true;
      setError(message);
    };
    bridge.oninitialized = () => {
      initialized = true;
      setReady(true);
      if (resourceDeliveryTimer !== undefined) window.clearTimeout(resourceDeliveryTimer);
      if (initializeTimer !== undefined) window.clearTimeout(initializeTimer);
      void bridge.sendToolInput({ arguments: input })
        .then(() => bridge.sendToolResult(asToolResult(result)))
        .catch((cause) => {
          fail(cause instanceof Error ? cause.message : "The App result could not be displayed.");
        });
    };

    const sandboxReadyTimer = window.setTimeout(() => {
      fail("The secure App frame did not finish opening.");
    }, SANDBOX_READY_TIMEOUT_MS);

    const startInitializeTimer = () => {
      if (initialized || initializeTimer !== undefined) return;
      initializeTimer = window.setTimeout(() => {
        fail("The App loaded, but did not finish initializing.");
      }, INITIALIZE_TIMEOUT_MS);
    };

    const markResourceAccepted = () => {
      resourceAccepted = true;
      if (resourceDeliveryTimer !== undefined) window.clearTimeout(resourceDeliveryTimer);
      startInitializeTimer();
    };

    const handleSandboxMessage = (event: MessageEvent) => {
      if (event.source !== iframe.contentWindow
        || event.origin !== sandbox.expectedOrigin
        || !isRecord(event.data)) return;
      if (event.data.method === "ui/notifications/sandbox-resource-loaded"
        || event.data.method === "ui/notifications/sandbox-resource-accepted") {
        markResourceAccepted();
        return;
      }
      if (event.data.method === "ui/notifications/sandbox-diagnostic") {
        const params = isRecord(event.data.params) ? event.data.params : {};
        fail(typeof params.message === "string" ? params.message : "The secure frame could not load this App.");
      }
    };

    const handleReady = (event: MessageEvent) => {
      if (event.source !== iframe.contentWindow
        || event.origin !== sandbox.expectedOrigin
        || !isRecord(event.data)
        || event.data.method !== "ui/notifications/sandbox-proxy-ready") return;
      window.removeEventListener("message", handleReady);
      window.clearTimeout(sandboxReadyTimer);
      const transport = new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!);
      const deliverResource = async () => {
        resourceSendAttempts += 1;
        try {
          await bridge.sendSandboxResourceReady({
            html: secureHtml(app),
            csp: app.csp,
            sandbox: "allow-scripts allow-same-origin",
          });
          if (resourceAccepted || initialized) return;
          resourceDeliveryTimer = window.setTimeout(() => {
            if (resourceAccepted || initialized) return;
            if (resourceSendAttempts < MAX_RESOURCE_SEND_ATTEMPTS) {
              void deliverResource();
              return;
            }
            fail("The secure frame did not accept this App after two delivery attempts.");
          }, RESOURCE_ACCEPT_TIMEOUT_MS);
        } catch (cause) {
          fail(cause instanceof Error ? cause.message : "The App could not be delivered to its secure frame.");
        }
      };
      void bridge.connect(transport)
        .then(deliverResource)
        .catch((cause) => {
          fail(cause instanceof Error ? cause.message : "The App could not be opened.");
        });
    };

    window.addEventListener("message", handleSandboxMessage);
    window.addEventListener("message", handleReady);
    iframe.src = sandbox.url;
    return () => {
      disposed = true;
      window.clearTimeout(sandboxReadyTimer);
      if (resourceDeliveryTimer !== undefined) window.clearTimeout(resourceDeliveryTimer);
      if (initializeTimer !== undefined) window.clearTimeout(initializeTimer);
      window.removeEventListener("message", handleSandboxMessage);
      window.removeEventListener("message", handleReady);
      void Promise.race([
        bridge.teardownResource({}),
        new Promise<void>((resolve) => window.setTimeout(resolve, 400)),
      ]).catch(() => undefined).finally(() => bridge.close().catch(() => undefined));
    };
  }, [app, client, input, result, toolName]);

  if (error) return <ErrorNote>Interactive view unavailable. {error}</ErrorNote>;
  return (
    <div
      className={`overflow-hidden rounded-xl bg-ink ${app.prefersBorder ? "border border-line" : ""}`}
      data-mcp-app-resource={app.resourceUri}
      data-mcp-app-ready={ready ? "true" : "false"}
    >
      <iframe
        ref={iframeRef}
        title={`${toolName} interactive App`}
        sandbox="allow-scripts allow-same-origin"
        referrerPolicy="no-referrer"
        className="block w-full border-0 bg-transparent"
        style={{ height }}
      />
    </div>
  );
}
