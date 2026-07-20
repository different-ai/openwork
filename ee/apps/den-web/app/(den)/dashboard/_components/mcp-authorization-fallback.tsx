"use client";

import { DenBrowserHandoffFallback } from "../../_components/browser-handoff-fallback";
import { safeMcpAuthorizationUrl } from "./mcp-authorization-url";

export function McpAuthorizationFallback({
  url,
  connectionName,
}: {
  url: string;
  connectionName: string;
}) {
  return (
    <div data-testid="mcp-authorization-fallback" className="mx-6 mb-4">
      <DenBrowserHandoffFallback
        url={url}
        title={`Finish connecting ${connectionName}`}
        description="Keep this page open while OpenWork waits. If the sign-in window did not appear, use the full link below."
        sanitizeUrl={safeMcpAuthorizationUrl}
      />
    </div>
  );
}
