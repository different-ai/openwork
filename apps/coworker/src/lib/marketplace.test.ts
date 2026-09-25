import assert from "node:assert/strict";
import { test } from "node:test";
import { FEATURED_COWORKERS, featuredCoworker, routineInstructions } from "./featured-coworkers.ts";
import { connector, connectorState, type ConnectorCatalog, type MarketplaceConnector } from "./marketplace.ts";

const app = (id: string) => connector(id) as MarketplaceConnector;

test("app rows follow the member's OpenWork connections", () => {
  const catalog: ConnectorCatalog = {
    signedIn: true,
    presets: [{ presetId: "slack", displayName: "Slack", url: "https://mcp.slack.com/mcp" }],
    connections: [
      { id: "google-workspace", name: "Google Workspace", url: "", connected: true, connectedForMe: false, nativeProviderKey: "google-workspace" },
      { id: "conn_slack", name: "Team Slack", url: "https://MCP.slack.com/mcp/", connected: true, connectedForMe: true },
    ],
  };
  assert.deepEqual(connectorState(app("gmail"), catalog), { state: "connect", connectionId: "google-workspace" });
  assert.deepEqual(connectorState(app("google-drive"), catalog), { state: "connect", connectionId: "google-workspace" });
  assert.deepEqual(connectorState(app("slack"), catalog), { state: "connected", connectionId: "conn_slack" });
  assert.deepEqual(connectorState(app("notion"), catalog), { state: "setup" });
  assert.deepEqual(connectorState(app("web"), catalog), { state: "built-in" });
  assert.deepEqual(connectorState(app("slack"), { ...catalog, signedIn: false }), { state: "signin" });
});

test("featured coworkers name only known apps and installable playbooks", () => {
  const playbooks = new Set<string>();
  for (const featured of FEATURED_COWORKERS) {
    for (const id of featured.integrations) assert.ok(connector(id), `${featured.id} works with an unknown app: ${id}`);
    for (const skill of featured.skills) {
      assert.match(skill.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      assert.ok(!playbooks.has(skill.name), `two coworkers install ${skill.name}`);
      playbooks.add(skill.name);
    }
  }
});

test("a routine carries its playbook's steps when the organization kept the playbook out", () => {
  const signal = featuredCoworker("signal")!;
  const digest = signal.routines[0]!;
  const playbook = signal.skills[0]!;
  assert.equal(routineInstructions(digest, signal.skills, new Set([playbook.name])), digest.instructions);
  const inline = routineInstructions(digest, signal.skills, new Set());
  assert.doesNotMatch(inline, /signal-topic-digest/);
  assert.ok(inline.startsWith("Follow these steps and post the digest in the discussion."));
  assert.ok(inline.includes(playbook.body));
});
