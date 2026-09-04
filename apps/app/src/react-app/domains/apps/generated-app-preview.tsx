import { useEffect, useRef, useState } from "react";
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { WorkflowArtifactPayload } from "@openwork/types/workflows";

/** Generated views have no server tools or network access. Their only input is a retained workflow result. */
export function GeneratedAppPreview({ html, payload, title }: { html: string; payload: WorkflowArtifactPayload; title: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(360);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const iframe = frame.current;
    if (!iframe?.contentWindow) return;
    let disposed = false;
    setError(null);
    const bridge = new AppBridge(null, { name: "OpenWork", version: "1.0.0" }, {}, {
      hostContext: { theme: document.documentElement.classList.contains("dark") ? "dark" : "light", displayMode: "inline" },
    });
    const timer = window.setTimeout(() => { if (!disposed) setError("This preview could not start. Reopen the app to try again."); }, 10_000);
    bridge.oninitialized = () => {
      window.clearTimeout(timer);
      void bridge.sendToolResult({ content: [], structuredContent: payload }).catch(() => {
        if (!disposed) setError("This preview could not load its results.");
      });
    };
    bridge.onsizechange = ({ height: next }) => {
      if (typeof next === "number" && Number.isFinite(next)) setHeight(Math.max(200, Math.min(800, next)));
    };
    void bridge.connect(new PostMessageTransport(iframe.contentWindow, iframe.contentWindow)).then(() => {
      if (!disposed) iframe.srcdoc = html;
    }).catch(() => { if (!disposed) setError("This preview could not start."); });
    return () => { disposed = true; window.clearTimeout(timer); void bridge.close(); };
  }, [html, payload]);
  return <div className="overflow-hidden rounded-xl border bg-background">
    {error ? <p role="alert" className="p-4 text-sm text-destructive">{error}</p> : null}
    <iframe ref={frame} title={`${title} preview`} sandbox="allow-scripts" referrerPolicy="no-referrer" className="block w-full border-0" style={{ height }} />
  </div>;
}
