# Native MCP Apps

OpenWork supports MCP Apps delivered by standard MCP servers connected through
OpenWork Connect. A server advertises the stable
`io.modelcontextprotocol/ui` extension, a tool binds an exact UI resource with
`_meta.ui.resourceUri`, the host reads that resource with `resources/read`, and
tool inputs and results move over the standard MCP Apps bridge.

This unit of value does **not** include installing a standalone App from an
HTML URL. URL-imported MCP Apps are deferred future work with a separate
product, security, lifecycle, and rollout contract.

Workflows remain executable `workflow` config objects. A Workflow's generated
views can be MCP resources, but that does not turn Workflow execution into
resource loading or a standalone URL-App installation path.

## Standard MCP server path

Connect continues to own server configuration, authentication, access grants,
per-member credentials, and tool policy. The OpenWork Cloud control server
publishes a member-scoped resource at:

```text
openwork://connect/mcp-servers/index.json
```

The signed-in Desktop session mints a separate short-lived App-host credential
with a non-public `mcp:app-host` scope. Desktop stores that credential and the
endpoint descriptors only in private App-host state; neither is projected into
OpenCode. It reads the index with that credential and advertises the
`mcp-app-host-v1` client capability. Den returns a non-empty provider index only
when the server-verified scope, client capability, and both rollout gates are
present. A normal model or legacy MCP token cannot unlock the index by spoofing
an audience or capability header. Desktop never writes `openwork-connect-*`
entries to the OpenCode runtime or any model-visible MCP registry. A connection
is proxied at:

```text
/mcp/agent/connections/{connectionId}
```

Current Desktop clients never register these provider descriptors in OpenCode;
the model discovers and invokes ordinary provider operations only through the
central `openwork-cloud` `search_capabilities` and `execute_capability` tools.
For stale published clients that still retain an old per-connection entry, the
proxy exposes only a compatibility pair named `search_capabilities` and
`execute_capability`. It never returns the provider catalog, MCP App launch
tools or metadata, resources, or templates, and it rejects every direct
provider call. This keeps ordinary operations bounded while old entries are
removed during reconciliation.

Desktop's local App host authenticates with the private scoped credential. Only
that transport receives tools with a valid `_meta.ui.resourceUri` whose
provider-declared visibility includes `app`, plus app-visible `search_capabilities` and
`execute_capability` scoped to the originating server. A native MCP App can
therefore render and use authorized tools from its regular MCP server without
placing the provider catalog in the model request.

The app-host view preserves:

- the App tool's exact name, input/output schemas, annotations, and UI binding;
- concrete descriptors and `resources/read` content only for resources bound
  by exposed App tools;
- `content`, `structuredContent`, `_meta`, and `isError` from `tools/call`;
- the stable MCP Apps extension and `text/html;profile=mcp-app` resources;
- one server identity per Connect connection, preserving the same-server
  tool-call boundary.

OpenWork access grants, disabled-tool policy, and approval rules still apply at
the proxy boundary. The App-host credential authorizes only this bounded proxy
surface; it is not a provider credential and grants no direct cross-server
access.

## Rollout

Native MCP Apps are enabled for every deployment and organization. The former
deployment gate (`DEN_REMOTE_MCP_APPS_ENABLED`) and the per-organization
**Native MCP Apps (preview)** capability were removed once the feature
stabilized; stale stored organization overrides are ignored. App launch
metadata (`kind: mcp_app`, `mcpApp.resourceUri`, `openwork/mcpApp` meta) is an
opaque binding published on every bounded search/execute result; clients that
do not host Apps ignore it and keep the normal tool result. The private
App-host index and per-connection provider proxy remain gated on the
client-advertised App-host capability header, so older Desktop clients keep
their bounded search/execute surface. Reconciliation also removes and
disconnects stale
`openwork-connect-*` OpenCode entries while preserving user-authored MCPs and
all durable Connect records.

The provider proxy advertises `listChanged: false` because the current
enterprise connector opens bounded request sessions rather than a durable
downstream notification stream. Catalog refresh happens on Connect
reconciliation, Desktop startup, engine refresh, or an explicit Cloud MCP
refresh. Forwarding downstream list-change notifications remains follow-up
interoperability work.

## Deferred: standalone URL-imported Apps

Installing a self-contained HTML App from a URL is intentionally outside this
change. In the current product:

- Den Web has no Add MCP App button, URL form, installed-App detail page, or
  URL-App lifecycle entry point;
- the central MCP server does not register `import_remote_mcp_app` or any
  standalone-App launch tool;
- capability search returns no standalone URL-App matches;
- model and App-host catalogs contain no standalone URL-App tools;
- no `ui://openwork/library-apps/...` resources are registered;
- member server indexes and launch metadata contain no standalone URL Apps;
- REST calls under `/v1/remote-mcp-apps` are not registered and are therefore
  unavailable.

Existing database rows and cached revisions from earlier development remain
stored non-destructively. They are inactive and unreachable through the UI,
MCP catalogs, capability search, resources, launch metadata, and HTTP API. This
change performs no deletion and introduces no destructive migration.

The retained storage and validation implementation is not a supported runtime
surface. A future standalone URL-App unit of value must deliberately restore
its own API, UI, security review, lifecycle, testing, and rollout contract.

## Host security and compatibility

Desktop negotiates the stable extension, resolves the current tool definition,
reads the exact `ui://` resource even when it is absent from `resources/list`,
accepts text or base64 HTML, enforces MIME and size limits, validates CSP
origins, and loads the document through the isolated sandbox proxy. It sends
tool input and the preserved tool result after initialization, bounds size
changes, tears the bridge down on unmount, and contains resolution, handshake,
document, and runtime failures without hiding the normal tool result.

App-requested tools are resolved only on the originating regular MCP server
and must be visible to the app. When a tool carries `_meta.ui.resourceUri`,
Desktop also requires it to match the exact resource loaded in the calling
iframe. Workspace denies apply. Read-only capability search runs directly;
capability execution uses conservative mutation annotations and requires user
confirmation while provider authorization and audit still run server-side.
Cross-server iframe calls are not allowed.
