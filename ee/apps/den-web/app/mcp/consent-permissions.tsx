export function McpConsentPermissions({ scope }: { scope: string }) {
  const scopes = new Set(scope.split(/\s+/).filter(Boolean));
  const canRead = scopes.has("mcp:read");
  const canAct = scopes.has("mcp:write");
  const permissions = [
    ...(scopes.has("openid") || scopes.has("profile") || scopes.has("email")
      ? ["Access the basic profile information requested by this client."] : []),
    ...(canRead ? ["Read information and discover available tools."] : []),
    ...(canAct ? ["Use connected tools and take actions that may create, change, or delete data."] : []),
    ...(scopes.has("offline_access") ? ["Keep this connection available between visits."] : []),
  ];

  return (
    <section aria-label="Requested access" className="grid gap-3 rounded-2xl border border-current/15 p-4 text-sm">
      <h3 className="font-semibold">Requested access</h3>
      {permissions.length > 0 ? (
        <ul className="list-disc space-y-2 pl-5">
          {permissions.map((permission) => <li key={permission}>{permission}</li>)}
        </ul>
      ) : <p>This client is requesting the permissions listed in Connection details.</p>}
      {canRead && !canAct ? <p>This client cannot run external tools or make changes.</p> : null}
      <p>Choosing Authorize grants the access shown here for this connection. Your organization's rules and existing service permissions still apply.</p>
      <details className="text-xs">
        <summary className="cursor-pointer">Connection details</summary>
        <p className="mt-2 break-words font-mono">{scope || "No permissions requested"}</p>
      </details>
    </section>
  );
}
