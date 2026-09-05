import {
  EXTENSION_ID,
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from "./mcp-app-v2.js"
import type { McpUiResourceMeta } from "@modelcontextprotocol/ext-apps"
import type { McpServer } from "@modelcontextprotocol/server"
import {
  workflowArtifactPayloadSchema,
  workflowArtifactSchemaVersion,
  type ArtifactFreshness,
  type WorkflowArtifactPayload,
} from "@openwork/types/workflows"
import { z } from "zod"

export { workflowArtifactPayloadSchema } from "@openwork/types/workflows"

export const WORKFLOW_ARTIFACT_APP_RESOURCE_URI = "ui://openwork/workflow-artifact/v1/view.html"
export const WORKFLOW_ARTIFACT_APP_TOOL_NAME = "render_workflow_artifact"
export const LEGACY_WORKFLOW_ARTIFACT_TOOL_NAME = "render_dynamic_artifact"
export const WORKFLOW_ARTIFACT_APP_SCHEMA_VERSION = workflowArtifactSchemaVersion

const idSchema = z.string().trim().min(1).max(160)

export type WorkflowArtifactLoadResult =
  | { ok: true; payload: WorkflowArtifactPayload; markdown: string }
  | { ok: false; error: string; message: string }

export const workflowArtifactAppServerCapabilities = {
  extensions: {
    [EXTENSION_ID]: {
      mimeTypes: [RESOURCE_MIME_TYPE],
    },
  },
}

const workflowArtifactAppResourceMeta: { ui: McpUiResourceMeta } = {
  ui: {
    csp: {
      connectDomains: [],
      resourceDomains: [],
      frameDomains: [],
      baseUriDomains: [],
    },
    prefersBorder: true,
  },
}

function formatFreshness(freshness: ArtifactFreshness): string {
  switch (freshness.state) {
    case "fresh":
      return "fresh"
    case "stale":
      return `stale (${Math.round(freshness.ageMs / 60_000)} minutes old)`
    case "needs_attention":
      return `needs attention: ${freshness.reason}`
    case "never_run":
      return "never run"
  }
  return "unknown"
}

export function workflowArtifactTextFallback(input: {
  payload: WorkflowArtifactPayload
  markdown: string
}): string {
  const { artifact } = input.payload
  return [
    `# ${artifact.title}`,
    artifact.description,
    `Freshness: ${formatFreshness(artifact.freshness)}`,
    `Generated: ${artifact.generatedAt}`,
    `Source: ${artifact.source}`,
    `Workflow version: ${artifact.configObjectVersionId}`,
    `Receipt: ${artifact.receiptId}`,
    "",
    input.markdown,
  ].filter((line): line is string => line !== null).join("\n")
}

export const WORKFLOW_ARTIFACT_APP_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>OpenWork Workflow Artifact</title>
  <style>
    :root {
      color-scheme: light dark;
      --ow-bg: var(--color-background-primary, #ffffff);
      --ow-bg-subtle: var(--color-background-secondary, #f5f5f4);
      --ow-text: var(--color-text-primary, #1c1917);
      --ow-muted: var(--color-text-secondary, #78716c);
      --ow-border: var(--color-border-secondary, #e7e5e4);
      --ow-accent: var(--color-text-info, #2563eb);
      --ow-success: var(--color-text-success, #15803d);
      --ow-warning: var(--color-text-warning, #b45309);
      --ow-danger: var(--color-text-danger, #b91c1c);
      font-family: var(--font-sans, ui-sans-serif, system-ui, sans-serif);
      background: transparent;
      color: var(--ow-text);
    }
    * { box-sizing: border-box; }
    body { margin: 0; min-width: 0; background: transparent; }
    button { font: inherit; }
    .shell { display: grid; gap: 14px; padding: 18px; background: var(--ow-bg); }
    .header { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; }
    .eyebrow { margin: 0 0 5px; color: var(--ow-muted); font-size: 11px; font-weight: 700; letter-spacing: .09em; text-transform: uppercase; }
    h1 { margin: 0; font-size: var(--font-heading-sm-size, 20px); line-height: 1.2; letter-spacing: -.02em; }
    .description { margin: 6px 0 0; max-width: 72ch; color: var(--ow-muted); font-size: var(--font-text-sm-size, 13px); line-height: 1.45; }
    .badge { flex: none; border: 1px solid var(--ow-border); border-radius: 999px; padding: 5px 9px; color: var(--ow-muted); font-size: 11px; font-weight: 700; }
    .badge[data-state="fresh"] { color: var(--ow-success); }
    .badge[data-state="stale"] { color: var(--ow-warning); }
    .badge[data-state="needs_attention"] { color: var(--ow-danger); }
    .tabs { display: flex; gap: 4px; width: fit-content; padding: 3px; border: 1px solid var(--ow-border); border-radius: 10px; background: var(--ow-bg-subtle); }
    .tab { border: 0; border-radius: 7px; padding: 6px 10px; background: transparent; color: var(--ow-muted); cursor: pointer; font-size: 12px; font-weight: 650; }
    .tab[aria-selected="true"] { background: var(--ow-bg); color: var(--ow-text); box-shadow: 0 1px 2px rgb(0 0 0 / .08); }
    .panel { min-width: 0; }
    .status { display: grid; min-height: 150px; place-items: center; border: 1px dashed var(--ow-border); border-radius: 12px; color: var(--ow-muted); font-size: 13px; text-align: center; }
    .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 9px; }
    .metric { min-width: 0; padding: 12px; border: 1px solid var(--ow-border); border-radius: 11px; background: var(--ow-bg-subtle); }
    .metric dt { overflow: hidden; margin: 0 0 6px; color: var(--ow-muted); font-size: 11px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
    .metric dd { overflow-wrap: anywhere; margin: 0; font-size: 15px; font-weight: 700; line-height: 1.3; }
    .table-wrap { max-width: 100%; overflow: auto; border: 1px solid var(--ow-border); border-radius: 11px; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td { max-width: 320px; padding: 9px 10px; border-bottom: 1px solid var(--ow-border); overflow: hidden; text-align: left; text-overflow: ellipsis; white-space: nowrap; }
    th { position: sticky; top: 0; background: var(--ow-bg-subtle); color: var(--ow-muted); font-size: 11px; }
    tbody tr:last-child td { border-bottom: 0; }
    .more { margin: 9px 2px 0; color: var(--ow-muted); font-size: 11px; }
    pre { max-height: 420px; overflow: auto; margin: 0; padding: 13px; border: 1px solid var(--ow-border); border-radius: 11px; background: var(--ow-bg-subtle); color: var(--ow-text); font-family: var(--font-mono, ui-monospace, monospace); font-size: 11px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
    .lineage { display: grid; grid-template-columns: minmax(130px, .35fr) minmax(0, 1fr); margin: 0; border: 1px solid var(--ow-border); border-radius: 11px; overflow: hidden; }
    .lineage dt, .lineage dd { min-width: 0; margin: 0; padding: 9px 11px; border-bottom: 1px solid var(--ow-border); font-size: 12px; }
    .lineage dt { background: var(--ow-bg-subtle); color: var(--ow-muted); font-weight: 650; }
    .lineage dd { overflow-wrap: anywhere; font-family: var(--font-mono, ui-monospace, monospace); }
    .lineage dt:last-of-type, .lineage dd:last-of-type { border-bottom: 0; }
    @media (max-width: 520px) {
      .shell { padding: 14px; }
      .header { display: grid; }
      .badge { justify-self: start; }
      .lineage { grid-template-columns: 1fr; }
      .lineage dt { border-bottom: 0; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <header class="header">
      <div>
        <p class="eyebrow">Workflow Artifact</p>
        <h1 id="title">Preparing artifact…</h1>
        <p class="description" id="description"></p>
      </div>
      <span class="badge" id="freshness">Connecting</span>
    </header>
    <nav class="tabs" aria-label="Artifact views">
      <button class="tab" type="button" data-tab="preview" aria-selected="true">Preview</button>
      <button class="tab" type="button" data-tab="data" aria-selected="false">Data</button>
      <button class="tab" type="button" data-tab="lineage" aria-selected="false">Lineage</button>
    </nav>
    <section class="panel" id="panel"><div class="status">Waiting for the artifact result…</div></section>
  </main>
  <script>
    (function () {
      'use strict';
      var INIT_ID = 'openwork-workflow-artifact:init';
      var activeTab = 'preview';
      var payload = null;
      var panel = document.getElementById('panel');
      var title = document.getElementById('title');
      var description = document.getElementById('description');
      var freshness = document.getElementById('freshness');

      function isRecord(value) {
        return value !== null && typeof value === 'object' && !Array.isArray(value);
      }

      function post(message) {
        window.parent.postMessage(message, '*');
      }

      function clear(node) {
        while (node.firstChild) node.removeChild(node.firstChild);
      }

      function text(value) {
        if (value === null) return 'null';
        if (value === undefined) return '';
        if (typeof value === 'string') return value;
        if (typeof value === 'number' || typeof value === 'boolean') return String(value);
        try { return JSON.stringify(value); } catch (_) { return '[unavailable]'; }
      }

      function scalar(value) {
        return value === null || ['string', 'number', 'boolean'].indexOf(typeof value) !== -1;
      }

      function raw(value) {
        var pre = document.createElement('pre');
        var output;
        try { output = JSON.stringify(value, null, 2); } catch (_) { output = '[Unable to serialize artifact data]'; }
        if (output.length > 120000) output = output.slice(0, 120000) + '\n… output truncated in this view';
        pre.textContent = output;
        return pre;
      }

      function renderRecord(record) {
        var keys = Object.keys(record).sort();
        if (!keys.length || !keys.every(function (key) { return scalar(record[key]); })) return raw(record);
        var list = document.createElement('dl');
        list.className = 'metrics';
        keys.slice(0, 20).forEach(function (key) {
          var item = document.createElement('div');
          item.className = 'metric';
          var term = document.createElement('dt');
          term.textContent = key;
          var detail = document.createElement('dd');
          detail.textContent = text(record[key]);
          item.appendChild(term);
          item.appendChild(detail);
          list.appendChild(item);
        });
        return list;
      }

      function renderTable(rows) {
        var columns = [];
        rows.slice(0, 100).forEach(function (row) {
          if (!isRecord(row)) return;
          Object.keys(row).sort().forEach(function (key) {
            if (columns.indexOf(key) === -1 && columns.length < 12) columns.push(key);
          });
        });
        if (!columns.length) return raw(rows);
        var wrap = document.createElement('div');
        wrap.className = 'table-wrap';
        var table = document.createElement('table');
        var thead = document.createElement('thead');
        var header = document.createElement('tr');
        columns.forEach(function (column) {
          var cell = document.createElement('th');
          cell.scope = 'col';
          cell.textContent = column;
          header.appendChild(cell);
        });
        thead.appendChild(header);
        table.appendChild(thead);
        var tbody = document.createElement('tbody');
        rows.slice(0, 100).forEach(function (row) {
          var tr = document.createElement('tr');
          columns.forEach(function (column) {
            var td = document.createElement('td');
            td.textContent = isRecord(row) ? text(row[column]) : text(row);
            tr.appendChild(td);
          });
          tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        wrap.appendChild(table);
        if (rows.length > 100) {
          var more = document.createElement('p');
          more.className = 'more';
          more.textContent = '+ ' + (rows.length - 100) + ' more rows in Data';
          var group = document.createElement('div');
          group.appendChild(wrap);
          group.appendChild(more);
          return group;
        }
        return wrap;
      }

      function preview(value) {
        if (Array.isArray(value)) return renderTable(value);
        if (isRecord(value)) return renderRecord(value);
        var list = document.createElement('dl');
        list.className = 'metrics';
        var item = document.createElement('div');
        item.className = 'metric';
        var term = document.createElement('dt');
        term.textContent = 'Result';
        var detail = document.createElement('dd');
        detail.textContent = text(value);
        item.appendChild(term);
        item.appendChild(detail);
        list.appendChild(item);
        return list;
      }

      function lineage(artifact) {
        var values = [
          ['Generated', artifact.generatedAt],
          ['Source', artifact.source],
          ['Workflow', artifact.configObjectId],
          ['Workflow version', artifact.configObjectVersionId],
          ['Receipt', artifact.receiptId],
          ['Automation run', artifact.automationRunId || '—'],
          ['Result digest', artifact.resultDigest],
          ['Renderer', artifact.rendererVersion]
        ];
        var list = document.createElement('dl');
        list.className = 'lineage';
        values.forEach(function (entry) {
          var term = document.createElement('dt');
          term.textContent = entry[0];
          var detail = document.createElement('dd');
          detail.textContent = entry[1];
          list.appendChild(term);
          list.appendChild(detail);
        });
        return list;
      }

      function freshnessLabel(value) {
        if (!value || !value.state) return 'Unknown';
        if (value.state === 'fresh') return 'Fresh';
        if (value.state === 'stale') return 'Stale';
        if (value.state === 'needs_attention') return 'Needs attention';
        return 'Never run';
      }

      function render() {
        if (!payload) return;
        title.textContent = payload.artifact.title;
        description.textContent = payload.artifact.description || '';
        freshness.textContent = freshnessLabel(payload.artifact.freshness);
        freshness.setAttribute('data-state', payload.artifact.freshness.state);
        clear(panel);
        if (activeTab === 'data') panel.appendChild(raw(payload.data));
        else if (activeTab === 'lineage') panel.appendChild(lineage(payload.artifact));
        else panel.appendChild(preview(payload.data));
        window.requestAnimationFrame(function () {
          post({
            jsonrpc: '2.0',
            method: 'ui/notifications/size-changed',
            params: {
              width: Math.ceil(document.documentElement.scrollWidth),
              height: Math.ceil(document.documentElement.scrollHeight)
            }
          });
        });
      }

      function showError(message) {
        clear(panel);
        var status = document.createElement('div');
        status.className = 'status';
        status.textContent = message;
        panel.appendChild(status);
        freshness.textContent = 'Unavailable';
        freshness.setAttribute('data-state', 'needs_attention');
      }

      function applyHostContext(context) {
        if (!context || !isRecord(context)) return;
        if (context.theme === 'light' || context.theme === 'dark') {
          document.documentElement.setAttribute('data-theme', context.theme);
          document.documentElement.style.colorScheme = context.theme;
        }
        var variables = context.styles && context.styles.variables;
        if (isRecord(variables)) {
          Object.keys(variables).forEach(function (key) {
            if (key.indexOf('--') === 0 && typeof variables[key] === 'string') {
              document.documentElement.style.setProperty(key, variables[key]);
            }
          });
        }
      }

      function onMessage(event) {
        if (event.source !== window.parent) return;
        var message = event.data;
        if (!isRecord(message) || message.jsonrpc !== '2.0') return;
        if (message.id === INIT_ID && isRecord(message.result)) {
          applyHostContext(message.result.hostContext);
          post({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
          return;
        }
        if (message.method === 'ui/notifications/host-context-changed') {
          applyHostContext(message.params);
          return;
        }
        if (message.method === 'ui/notifications/tool-input') {
          freshness.textContent = 'Loading';
          return;
        }
        if (message.method === 'ui/notifications/tool-cancelled') {
          showError(message.params && message.params.reason ? message.params.reason : 'Artifact rendering was cancelled.');
          return;
        }
        if (message.method === 'ui/notifications/tool-result') {
          if (message.params && message.params.isError) {
            showError('The artifact could not be loaded. See the text result for details.');
            return;
          }
          var structured = message.params && message.params.structuredContent;
          if (!isRecord(structured) || structured.schemaVersion !== '1' || !isRecord(structured.artifact)) {
            showError('This result does not match the Workflow Artifact data contract.');
            return;
          }
          payload = structured;
          render();
          return;
        }
        if (message.method === 'ui/resource-teardown' && message.id !== undefined) {
          post({ jsonrpc: '2.0', id: message.id, result: {} });
        }
      }

      Array.prototype.forEach.call(document.querySelectorAll('[data-tab]'), function (button) {
        button.addEventListener('click', function () {
          activeTab = button.getAttribute('data-tab') || 'preview';
          Array.prototype.forEach.call(document.querySelectorAll('[data-tab]'), function (candidate) {
            candidate.setAttribute('aria-selected', String(candidate === button));
          });
          render();
        });
      });

      window.addEventListener('message', onMessage);
      post({
        jsonrpc: '2.0',
        id: INIT_ID,
        method: 'ui/initialize',
        params: {
          appInfo: { name: 'OpenWork Workflow Artifact', version: '1.0.0' },
          appCapabilities: {},
          protocolVersion: '2026-01-26'
        }
      });
    }());
  </script>
</body>
</html>`

export function registerAgentWorkflowArtifactApp(input: {
  server: McpServer
  selectApp?: (request: { configObjectId: string; receiptId: string }) => Promise<{
    artifactViewId: string; viewRevisionId: string; resourceUri: string; toolName: string
  } | null>
  load: (request: {
    configObjectId: string
    receiptId?: string
    maxAgeMs?: number
  }) => Promise<WorkflowArtifactLoadResult>
}) {
  registerAgentWorkflowArtifactResource(input.server)
  const renderWorkflowArtifact = async ({ configObjectId, receiptId, maxAgeMs }: {
    configObjectId: string
    receiptId?: string
    maxAgeMs?: number
  }) => {
    const loaded = await input.load({ configObjectId, receiptId, maxAgeMs })
    const result = workflowArtifactToolResult(loaded)
    if (!loaded.ok || !input.selectApp) return result
    const selected = await input.selectApp({ configObjectId, receiptId: loaded.payload.artifact.receiptId })
    if (!selected) return result
    return {
      ...result,
      _meta: {
        ...result._meta,
        artifactViewId: selected.artifactViewId,
        viewRevisionId: selected.viewRevisionId,
        "openwork/mcpApp": {
          toolName: selected.toolName,
          resourceUri: selected.resourceUri,
          arguments: { receiptId: loaded.payload.artifact.receiptId },
        },
      },
    }
  }

  registerAppTool(
    input.server,
    WORKFLOW_ARTIFACT_APP_TOOL_NAME,
    {
      title: "Render Workflow Artifact",
      description: [
        "Read an authorized immutable result from a Workflow and present it as a Workflow Artifact.",
        "Use the latest successful snapshot by default, or pass receiptId to pin an exact snapshot.",
        "This tool never runs or refreshes a Workflow; Automations and explicit Workflow runs own data refresh.",
        "Clients without MCP Apps support receive the same artifact as Markdown text.",
      ].join(" "),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: z.object({
        configObjectId: idSchema.describe("The Workflow configObjectId."),
        receiptId: idSchema.optional().describe("Optional exact immutable artifact receipt. Defaults to the latest successful snapshot."),
        maxAgeMs: z.number().int().min(60_000).max(30 * 24 * 60 * 60_000).optional().describe("Freshness threshold used for the rendered status. Defaults to 24 hours."),
      }),
      outputSchema: workflowArtifactPayloadSchema,
      _meta: {
        ui: {
          resourceUri: WORKFLOW_ARTIFACT_APP_RESOURCE_URI,
          visibility: ["model", "app"],
        },
      },
    },
    renderWorkflowArtifact,
  )

  registerAppTool(
    input.server,
    LEGACY_WORKFLOW_ARTIFACT_TOOL_NAME,
    {
      title: "Render Workflow Artifact (Deprecated Alias)",
      description: "Deprecated: use render_workflow_artifact. This alias delegates to the canonical Workflow Artifact renderer and will be removed after one release.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: z.object({
        configObjectId: idSchema.describe("The Workflow configObjectId."),
        receiptId: idSchema.optional().describe("Optional exact immutable artifact receipt. Defaults to the latest successful snapshot."),
        maxAgeMs: z.number().int().min(60_000).max(30 * 24 * 60 * 60_000).optional().describe("Freshness threshold used for the rendered status. Defaults to 24 hours."),
      }),
      outputSchema: workflowArtifactPayloadSchema,
      _meta: {
        ui: {
          resourceUri: WORKFLOW_ARTIFACT_APP_RESOURCE_URI,
          visibility: ["model", "app"],
        },
      },
    },
    renderWorkflowArtifact,
  )
}

export function registerAgentWorkflowArtifactResource(server: McpServer) {
  registerAppResource(
    server,
    "OpenWork Workflow Artifact",
    WORKFLOW_ARTIFACT_APP_RESOURCE_URI,
    {
      description: "A data-first Preview, Data, and Lineage view for an immutable Workflow result.",
      _meta: workflowArtifactAppResourceMeta,
    },
    async () => ({
      contents: [{
        uri: WORKFLOW_ARTIFACT_APP_RESOURCE_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: WORKFLOW_ARTIFACT_APP_HTML,
        _meta: workflowArtifactAppResourceMeta,
      }],
    }),
  )
}

function workflowArtifactToolResult(loaded: WorkflowArtifactLoadResult) {
  if (!loaded.ok) {
    return {
      isError: true,
      content: [{
        type: "text" as const,
        text: JSON.stringify({ error: loaded.error, message: loaded.message }),
      }],
    }
  }
  return {
    content: [{ type: "text" as const, text: workflowArtifactTextFallback(loaded) }],
    structuredContent: loaded.payload,
    _meta: {
      schemaVersion: loaded.payload.schemaVersion,
      receiptId: loaded.payload.artifact.receiptId,
      resultDigest: loaded.payload.artifact.resultDigest,
    },
  }
}
