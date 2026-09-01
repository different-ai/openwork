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
  closeRef.current = onClose;

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe?.contentWindow) return;
    let disposed = false;
    let connected = false;
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
        await coworkerBridge.openExternal(url);
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
    bridge.oninitialized = () => {
      void bridge.sendToolInput({ arguments: input })
        .then(() => bridge.sendToolResult(asToolResult(result)))
        .catch((cause) => {
          if (!disposed) setError(cause instanceof Error ? cause.message : "The App result could not be displayed.");
        });
    };

    const readyTimer = window.setTimeout(() => {
      if (!connected && !disposed) setError("This App did not finish opening.");
    }, 7_500);

    const handleReady = (event: MessageEvent) => {
      if (event.source !== iframe.contentWindow
        || event.origin !== sandbox.expectedOrigin
        || !isRecord(event.data)
        || event.data.method !== "ui/notifications/sandbox-proxy-ready") return;
      window.removeEventListener("message", handleReady);
      const transport = new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!);
      void bridge.connect(transport)
        .then(async () => {
          connected = true;
          window.clearTimeout(readyTimer);
          await bridge.sendSandboxResourceReady({
            html: secureHtml(app),
            csp: app.csp,
            sandbox: "allow-scripts allow-same-origin",
          });
        })
        .catch((cause) => {
          if (!disposed) setError(cause instanceof Error ? cause.message : "The App could not be opened.");
        });
    };

    window.addEventListener("message", handleReady);
    iframe.src = sandbox.url;
    return () => {
      disposed = true;
      window.clearTimeout(readyTimer);
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
