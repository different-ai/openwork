import { SetupCanList, SetupTechnicalDetails } from "../(den)/_components/setup-frame-parts";
import type { McpRedirectDescription } from "./client-identity-model";

/** Plain sentences for what an OAuth scope string lets an app do. */
export function mcpPermissionLines(scope: string): string[] {
  const scopes = new Set(scope.split(/\s+/).filter(Boolean));
  return [
    ...(scopes.has("openid") || scopes.has("profile") || scopes.has("email") ? ["See your name and email"] : []),
    ...(scopes.has("mcp:read") ? ["Find and read what is in this workspace"] : []),
    ...(scopes.has("mcp:write") ? ["Use your connected tools, including actions that create, change, or delete data"] : []),
    ...(scopes.has("offline_access") ? ["Stay connected until you remove it"] : []),
  ];
}

/** "Claude Code can" and the plain list of what it gets. */
export function McpConsentPermissions({ scope, actor = "This app" }: { scope: string; actor?: string }) {
  return <SetupCanList actor={actor} items={mcpPermissionLines(scope)} />;
}

/** The raw scope string and app id, behind one collapsed row. */
export function McpTechnicalDetails({ scope, clientId, redirect }: { scope: string; clientId: string | null; redirect?: McpRedirectDescription | null }) {
  return (
    <SetupTechnicalDetails>
      <span>Permissions: {scope || "none requested"}</span>
      {clientId ? <span>App ID: {clientId}</span> : null}
      {redirect ? <span>Full return address: <span dir="ltr" data-testid="mcp-redirect-url">{redirect.url}</span></span> : null}
    </SetupTechnicalDetails>
  );
}
