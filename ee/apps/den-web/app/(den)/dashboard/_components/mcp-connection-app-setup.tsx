"use client";

import { useState } from "react";
import { DenButton } from "../../_components/ui/button";
import { isNativeProviderConnectionId, type ExternalMcpConnection } from "./mcp-connections-data";

export function connectionMcpSetupUrl(publicApiUrl: string, connectionId: string): string | null {
  if (!publicApiUrl.trim() || !connectionId.trim()) return null;
  try {
    const url = new URL(publicApiUrl.trim());
    if (url.protocol !== "https:"
      || url.username || url.password || url.search || url.hash
      || /\/api\/den(?:\/|$)/.test(url.pathname)) return null;
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/mcp/agent/connections/${encodeURIComponent(connectionId)}`;
    return url.toString();
  } catch {
    return null;
  }
}

export function McpConnectionAppSetup({ connection, publicApiUrl, enabled, className = "", label = "Use in another app" }: {
  connection: Pick<ExternalMcpConnection, "id" | "exposeDirectly" | "nativeProviderKey">;
  publicApiUrl: string;
  enabled: boolean;
  className?: string;
  label?: string;
}) {
  const [copyResult, setCopyResult] = useState<{ url: string; status: "copying" | "copied" | "error" } | null>(null);
  const url = connectionMcpSetupUrl(publicApiUrl, connection.id);
  const status = copyResult?.url === url ? copyResult?.status : undefined;

  if (!enabled || !connection.exposeDirectly || isNativeProviderConnectionId(connection.id, connection.nativeProviderKey)) return null;

  async function copyUrl() {
    if (!url) return;
    setCopyResult({ url, status: "copying" });
    try {
      await navigator.clipboard.writeText(url);
      setCopyResult({ url, status: "copied" });
    } catch {
      setCopyResult({ url, status: "error" });
    }
  }

  return (
    <details className={`rounded-xl border border-gray-100 bg-gray-50 p-3 ${className}`}>
      <summary className="cursor-pointer text-[12px] font-medium text-gray-700">{label}</summary>
      <div className="mt-3 space-y-2 text-[12px] leading-5 text-gray-600">
        <div className="flex items-center gap-2 rounded-xl border border-gray-200 bg-white p-2">
          <p className="min-w-0 flex-1 break-all font-mono text-[11px] text-gray-800">
            {url || "Public MCP URL unavailable. Try reloading this page."}
          </p>
          <DenButton type="button" variant="secondary" size="sm" disabled={!url || status === "copying"} onClick={() => void copyUrl()}>
            {status === "copied" ? "Copied" : "Copy"}
          </DenButton>
        </div>
        {status === "copied" ? <p role="status">MCP URL copied.</p> : null}
        {status === "error" ? <p role="alert" className="text-red-600">Could not copy the URL. Select and copy it manually.</p> : null}
        {url ? (
          <>
            <ol className="list-decimal space-y-1 pl-4">
              <li>Add a remote HTTP MCP server in your app.</li>
              <li>Paste this MCP URL.</li>
              <li>Choose OAuth and sign in to your OpenWork organization.</li>
            </ol>
            <p>You may still need to connect your provider account in OpenWork. Existing access grants and tool policies still apply.</p>
          </>
        ) : null}
      </div>
    </details>
  );
}
