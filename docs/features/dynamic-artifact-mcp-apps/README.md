# Workflow Artifacts as MCP Apps

OpenWork exposes Workflow results as portable, standards-based
MCP Apps. A supporting MCP host can render an artifact inline; every other MCP
client still receives a useful Markdown result.

## Product flow

1. Code Mode produces data and a deterministic Markdown rendering.
2. The result can be saved as an immutable Workflow snapshot with a receipt,
   schema validation, result digest, and exact Workflow version.
3. A person or an Automation may run the Workflow again. Automations only
   refresh the data snapshot; they do not create or execute UI code.
4. The read-only `render_workflow_artifact` tool loads the latest successful
   snapshot, or an exact receipt when requested.
   `render_dynamic_artifact` remains as a deprecated alias for one release.
5. MCP Apps hosts resolve the linked `ui://` resource and inject the tool's
   structured result. Other hosts show the Markdown fallback.

This keeps execution, scheduling, data, and presentation separate:

```text
Workflow ──run──> immutable snapshot ──read──> MCP tool result
       ▲                        ▲                          ├─ Markdown fallback
       │                        │                          └─ ui:// MCP App
   explicit run           Automation refresh
```

The MCP App never runs a Workflow, mutates an artifact, or introduces another
scheduler. It only presents an already-authorized snapshot.

## MCP Apps conformance

The agent MCP server implements the `io.modelcontextprotocol/ui` extension and
the `2026-01-26` MCP Apps protocol:

- server capability: `extensions.io.modelcontextprotocol/ui.mimeTypes`
  contains `text/html;profile=mcp-app`;
- tool metadata: `_meta.ui.resourceUri` points to
  `ui://openwork/workflow-artifact/v1/view.html` (with the compatibility metadata
  emitted by the official MCP Apps server helpers);
- resource delivery: `resources/read` returns one self-contained HTML5 document
  with MIME type `text/html;profile=mcp-app`;
- view lifecycle: the document performs `ui/initialize`, sends
  `ui/notifications/initialized`, receives tool input/result/cancellation and
  host-context notifications, reports size changes, and acknowledges teardown;
- data delivery: the tool returns versioned `structuredContent`, lightweight
  lineage in result `_meta`, and a complete text fallback;
- security: the resource declares an empty network/frame/base-URI CSP, loads no
  external code, performs no network requests, and inserts artifact values with
  DOM text APIs rather than HTML interpolation.

The shared payload schema lives in `@openwork/types/workflows` so a host
can validate the data contract independently of this presentation resource.

## UI behavior

The self-contained view is intentionally data-first and framework-neutral. It
adapts the Preview tab to common result shapes:

- arrays of records become a bounded table;
- flat objects become metric cards;
- nested or irregular values fall back to formatted JSON;
- Data always exposes the full structured result, with a rendering-size guard;
- Lineage shows the immutable receipt, Workflow/version IDs, source, digest,
  renderer, and Automation run when present.

The view follows host theme/style context, uses responsive HTML, and caps large
tables and rendered JSON without changing the underlying tool result.

## Authorization and failure behavior

The renderer uses the same organization membership, team grants, and saved
Workflow authorization path as the existing artifact APIs. It does not accept a
plugin or result payload from the caller. The caller supplies only a saved
Workflow ID, an optional exact receipt, and an optional freshness threshold.

Only readable, successful, non-deleted snapshots can be rendered. Missing,
failed, deleted, or unauthorized results fail closed with a non-sensitive text
error. A stale snapshot remains renderable and is labeled stale; a failed
refresh leaves the last successful artifact available with a needs-attention
state.

## Next interoperable slice

The provider side is deliberately usable without an OpenWork-specific host.
The next slice is a generic MCP Apps host in the desktop conversation surface:
negotiate the UI extension with upstream MCP servers, preserve tool/resource
metadata and structured results through the runtime, sandbox `ui://` resources,
and bridge the standard JSON-RPC lifecycle. That host should consume the same
standard contract rather than adding a custom React artifact format.
