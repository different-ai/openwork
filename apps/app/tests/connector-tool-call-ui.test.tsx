import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DynamicToolUIPart } from "ai";

import { CodeModeTool } from "../src/components/chat/code-mode-tool";
import { CapabilityCallLine } from "../src/components/chat/capability-call-line";
import {
  buildConnectorToolIdentities,
  resolveConnectorToolIdentity,
} from "../src/react-app/domains/connections/connector-tool-identity";

test("renders probe branding and accessible human labels in every state", () => {
  const base = {
    type: "dynamic-tool",
    toolName: "openwork-cloud_execute_capability",
    toolCallId: "probe-ui",
    input: { name: "mcp:emc_probe:*" },
  } satisfies Partial<DynamicToolUIPart>;
  const parts: DynamicToolUIPart[] = [
    { ...base, state: "input-available" },
    { ...base, state: "output-available", output: {} },
    { ...base, state: "output-error", errorText: "Probe failed" },
  ];
  const connector = {
    id: "connection:emc_probe", connectionId: "emc_probe", name: "Notion",
    iconUrl: "/ext-notion.svg", serviceUrl: null, toolNamespace: null,
  };
  for (const part of parts) {
    const label = part.state === "input-available" ? "Checking Notion connection…"
      : part.state === "output-error" ? "Couldn&#x27;t check Notion connection" : "Checked Notion connection";
    const html = renderToStaticMarkup(<CapabilityCallLine part={part} connector={connector} />);
    expect(html).toContain('data-connector-name="Notion"');
    expect(html).toContain("/ext-notion.svg");
    expect(html).toContain(label);
    expect(html).toContain(`aria-label="${label}.`);
    expect(html).not.toContain("Used *");
    expect(html).not.toContain("mcp:emc_probe:*");
    expect(html).not.toContain("Waiting for your action");
  }
  const html = renderToStaticMarkup(<CapabilityCallLine part={parts[0]!} statusUnknown />);
  expect(html).toContain("status unavailable");
  expect(html).not.toContain("animate-spin");
});

test("valid probe payload names do not brand unknown connections", () => {
  const part: DynamicToolUIPart = {
    type: "dynamic-tool", toolName: "openwork-cloud_execute_capability", toolCallId: "unknown-probe",
    state: "output-available", input: { name: "mcp:emc_unknown:*" },
    output: { connectionStatus: {
      schemaVersion: "1", connectionId: "emc_unknown", connectionName: "Notion",
      state: "connected", actor: null, message: "Connected", action: null,
    } },
  };
  const inventory = buildConnectorToolIdentities({ mcpServers: [], orgConnections: [] });
  const connector = resolveConnectorToolIdentity(part, inventory);
  expect(connector).toBeNull();
  const html = renderToStaticMarkup(<CapabilityCallLine part={part} connector={connector} />);
  expect(html).toContain("Checked connection");
  expect(html).not.toContain("Notion");
  expect(html).not.toContain("ext-notion.svg");
  expect(html).not.toContain("emc_unknown");
  const known = resolveConnectorToolIdentity(part, [{
    id: "connection:emc_unknown", connectionId: "emc_unknown", name: "Notion",
    iconUrl: "/ext-notion.svg", serviceUrl: null, toolNamespace: null,
  }]);
  const knownHtml = renderToStaticMarkup(<CapabilityCallLine part={part} connector={known} />);
  expect(knownHtml).toContain("Checked Notion connection");
  expect(knownHtml).toContain('data-connector-name="Notion"');
  expect(knownHtml).toContain("/ext-notion.svg");
});

test("unfinished code mode calls do not resume animating after interruption", () => {
  const part: DynamicToolUIPart = {
    type: "dynamic-tool", toolName: "openwork-cloud_execute_capability_script", toolCallId: "script",
    state: "input-available", input: {},
  };
  const call: DynamicToolUIPart = {
    type: "dynamic-tool", toolName: "openwork-cloud_execute_capability", toolCallId: "nested",
    state: "input-available", input: { name: "mcp:emc_probe:*" },
  };
  for (const lifecycle of [null, "interrupted"] satisfies Array<null | "interrupted">) {
    const html = renderToStaticMarkup(<CodeModeTool part={part} calls={[call]} lifecycle={lifecycle} connectors={[]} />);
    expect(html).toContain("Status unavailable");
    expect(html).toContain("Checking connection");
    expect(html).not.toContain("animate-spin");
    expect(html).not.toContain("Task interrupted");
    expect(html).not.toContain("Completed");
  }
});

test("code-mode mutations summarize the outcome, not the last lookup, and fold when finished", () => {
  const part: DynamicToolUIPart = { type: "dynamic-tool", toolName: "execute", toolCallId: "script-write", state: "output-available", input: { code: "return await tools.linear.create_note({})" }, output: "Saved" };
  const calls: DynamicToolUIPart[] = [
    { type: "dynamic-tool", toolName: "linear_create_note", toolCallId: "create", state: "output-available", input: {}, output: undefined },
    { type: "dynamic-tool", toolName: "linear_list_teams", toolCallId: "read", state: "output-available", input: {}, output: undefined },
  ];
  const html = renderToStaticMarkup(<CodeModeTool part={part} calls={calls} lifecycle={null} connectors={[]} />);
  expect(html).toContain("Created a note in Linear");
  expect(html).toContain("Show steps");
  expect(html).not.toContain("List teams. Show");
  expect(html).not.toContain("Tool activity");
  expect(html).not.toContain("text-destructive");
});

test("code-mode failures remain neutral and do not hide the failed call", () => {
  const part: DynamicToolUIPart = { type: "dynamic-tool", toolName: "execute", toolCallId: "script-retry", state: "input-available", input: { code: "retry" } };
  const calls: DynamicToolUIPart[] = [
    { type: "dynamic-tool", toolName: "linear_get_note", toolCallId: "first", state: "output-error", input: {}, errorText: "Missing" },
    { type: "dynamic-tool", toolName: "linear_list_teams", toolCallId: "second", state: "input-available", input: {} },
  ];
  const html = renderToStaticMarkup(<CodeModeTool part={part} calls={calls} lifecycle="running" connectors={[]} />);
  expect(html).toContain("1 failed call");
  expect(html).toContain("Couldn&#x27;t");
  expect(html).toContain("ow-text-shimmer");
  expect(html).not.toContain("text-destructive");
  expect(html).not.toContain("Completed with errors");
});

test("renders a connector logo beside a human-readable completed tool call", () => {
  const part: DynamicToolUIPart = {
    type: "dynamic-tool",
    toolName: "openwork-cloud_execute_capability",
    toolCallId: "call-google-calendar",
    state: "output-available",
    input: { name: "getCapabilitiesGoogleWorkspaceCalendarEvents", body: {} },
    output: { events: [] },
  };
  const identity = resolveConnectorToolIdentity(
    part,
    buildConnectorToolIdentities({ mcpServers: [], orgConnections: [] }),
  );
  const html = renderToStaticMarkup(<CapabilityCallLine part={part} connector={identity} />);

  expect(html).toContain('data-connector-name="Google Workspace"');
  expect(html).toContain("ext-google-workspace.svg");
  expect(html).toContain("Fetched Google Workspace Calendar Events");
});
