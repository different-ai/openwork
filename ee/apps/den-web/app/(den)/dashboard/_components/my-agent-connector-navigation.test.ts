import assert from "node:assert/strict";
import { test } from "node:test";
import { connectorReturnToAgent, fromMyAgent, myAgentGoogleHref } from "./my-agent-connector-navigation";

test("missing Google links to native setup with a My bot return destination", () => {
  assert.equal(myAgentGoogleHref(null), "/dashboard/library/connectors/new/google-workspace?from=my-agent");
});

test("an existing Google connection opens its real ID and keeps the return destination", () => {
  assert.equal(myAgentGoogleHref(null, "gws_123"), "/dashboard/library/connectors/gws_123?from=my-agent");
  assert.equal(fromMyAgent("/dashboard/example?connection=123"), "/dashboard/example?connection=123&from=my-agent");
});

test("only the fixed My bot source changes the back link", () => {
  assert.deepEqual(connectorReturnToAgent(null, "my-agent"), { href: "/dashboard/my-bot", label: "My bot" });
  for (const value of [null, "", "connectors", "https://example.test", "//example.test", "/dashboard/settings"]) {
    assert.equal(connectorReturnToAgent(null, value), null);
  }
});
