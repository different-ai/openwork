# MCP Apps inline host

OpenWork Desktop can render the standard MCP Apps UI attached to a completed
MCP tool call. The normal text result remains visible and usable if the view is
absent, unsupported, or fails to initialize.

## Runtime flow

1. OpenCode calls the configured MCP tool once.
2. OpenWork's bundled engine plugin preserves that call's standard `content`,
   `structuredContent`, and result `_meta` fields in the completed tool part.
3. The desktop asks its local OpenWork server to find the original projected
   tool on the configured MCP server.
4. The server advertises the `io.modelcontextprotocol/ui` extension, reads the
   tool's `_meta.ui.resourceUri`, and resolves the `ui://` resource through
   `resources/read`.
5. The conversation mounts the returned `text/html;profile=mcp-app` resource in
   an opaque sandboxed iframe and delivers the original tool input and result
   over the official MCP Apps bridge.

The host never replays the originating tool call to reconstruct structured
data. MCP tools that return only standard text content can still attach a view.

## Security boundary

- Resource markup runs in an opaque `sandbox="allow-scripts"` iframe with no
  referrer, forms, popups, same-origin access, top navigation, downloads, or
  device permissions.
- The host injects a deny-by-default CSP before resource markup. It accepts at
  most 16 fixed HTTPS origins per declared source list, with loopback HTTP
  allowed for local development.
- Remote MCP connections must use HTTPS, except for loopback HTTP. Configured
  MCP headers and credentials remain in the local server and are never exposed
  to the iframe.
- Resource HTML is limited to 512 KiB, proxied tool results to 1 MiB, and tool
  discovery to 2,048 tools across at most 32 pages.
- A view may call only tools from its originating configured MCP server. The
  target must be visible to apps, explicitly `readOnlyHint: true`, not
  destructive, and allowed by the workspace's MCP tool policy.
- Dedicated sandbox origins, camera, microphone, geolocation, clipboard
  access, sampling, host messaging, external link opening, downloads, and
  write-capable tool calls are not granted by this host slice.

## Current compatibility

The resource resolver currently supports configured remote Streamable HTTP MCP
servers, with SSE fallback for legacy remote servers. It does not yet resolve
resources directly from command/stdio MCP entries. OpenWork-managed OAuth
connections also require a follow-up adapter so resource discovery can reuse
their encrypted server-side credential path; ordinary remote connections with
configured server-side headers work today.

## Verification

Focused server tests cover extension negotiation, projected tool naming,
resource resolution, tool visibility, read-only same-server mediation, and
write rejection. App tests cover result preservation, session mapping, CSP
construction, and safe HTML injection. The Testkit scenario
`mcp-app-inline-host.e2e.test.ts` drives a deterministic OpenCode tool call,
resolves the declared `ui://` resource, mounts the sandboxed view, and captures
the visible inline card and fallback transcript.
