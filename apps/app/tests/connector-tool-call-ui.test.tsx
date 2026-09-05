import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DynamicToolUIPart } from "ai";

import { CapabilityCallLine } from "../src/components/chat/capability-call-line";
import {
  buildConnectorToolIdentities,
  resolveConnectorToolIdentity,
} from "../src/react-app/domains/connections/connector-tool-identity";

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
