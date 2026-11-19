import { useEffect, useRef } from "react";
import type { OpenworkMcpAppResource, OpenworkServerClient } from "@/app/lib/openwork-server";

const NO_APP: OpenworkMcpAppResource = {
  serverName: "", toolName: "", resourceUri: "", html: "", prefersBorder: false,
  csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
};
const EMPTY_DOCUMENT = "<!doctype html><html><head></head><body></body></html>";

/**
 * Sandboxed Apps run in their own browser process, which closes with the last
 * document in it, so the next App starts that process again. One empty document
 * keeps it open and an App starts in less than half the time. It holds no App,
 * data or lease, and nothing it could leak: only this constant ever loads here.
 */
export function McpAppWarmSandbox({ client }: { client: OpenworkServerClient }) {
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const iframe = frame.current;
    if (!iframe) return;
    const sandbox = client.mcpAppSandbox(NO_APP, window.location.origin);
    if (sandbox.expectedOrigin === window.location.origin) return;
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframe.contentWindow || event.origin !== sandbox.expectedOrigin
        || event.data?.method !== "ui/notifications/sandbox-proxy-ready") return;
      window.removeEventListener("message", onMessage);
      iframe.contentWindow?.postMessage(
        { jsonrpc: "2.0", method: "ui/notifications/sandbox-resource-ready", params: { html: EMPTY_DOCUMENT, csp: NO_APP.csp, sandbox: "allow-scripts" } },
        sandbox.expectedOrigin === "null" ? "*" : sandbox.expectedOrigin,
      );
    };
    window.addEventListener("message", onMessage);
    iframe.setAttribute("sandbox", sandbox.sandbox);
    iframe.src = sandbox.url;
    return () => {
      window.removeEventListener("message", onMessage);
      iframe.removeAttribute("src");
    };
  }, [client]);
  return <iframe ref={frame} title="App sandbox" hidden tabIndex={-1} aria-hidden="true" sandbox="allow-scripts" referrerPolicy="no-referrer" data-mcp-app-warm-sandbox />;
}
