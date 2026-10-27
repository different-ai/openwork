import assert from "node:assert/strict";
import { test } from "node:test";
import { mapRuntimeMcpToV2 } from "../src/engine-v2-preview.js";

const remote = {
  type: "remote",
  url: "https://connect.example.test/mcp/agent",
  headers: { Authorization: "Bearer synthetic-test-token" },
  oauth: false,
};

test("managed openwork-cloud opts into V2 protocol auto without leaking unsupported config", () => {
  assert.deepEqual(mapRuntimeMcpToV2({
    ...remote,
    protocol: "unsupported-runtime-value",
    clientInfo: { name: "not-a-config-field" },
    codemode: false,
    timeout: 12_000,
  }, "openwork-cloud"), {
    ...remote,
    headers: { ...remote.headers, "x-openwork-mcp-client-capabilities": "native-skills-v1" },
    protocol: "auto",
    codemode: false,
    timeout: { startup: 12_000, catalog: 12_000, execution: 12_000 },
  });
});

test("managed openwork-cloud tells Den it lists skills natively, keeping other capabilities", () => {
  const mapped = mapRuntimeMcpToV2({ ...remote, headers: { ...remote.headers, "X-OpenWork-MCP-Client-Capabilities": "other-v1" } }, "openwork-cloud");
  assert.deepEqual(mapped?.headers, { ...remote.headers, "X-OpenWork-MCP-Client-Capabilities": "other-v1,native-skills-v1" });
  const again = mapRuntimeMcpToV2({ ...remote, headers: mapped?.headers }, "openwork-cloud");
  assert.deepEqual(again?.headers, mapped?.headers, "the capability is added once");
});

test("generic remote MCPs keep the legacy default even with the same URL or runtime protocol fields", () => {
  for (const name of [undefined, "third-party", "openwork-cloud-copy"]) {
    assert.deepEqual(mapRuntimeMcpToV2({ ...remote, protocol: "auto", clientInfo: { name: "ignored" } }, name), remote);
  }
});

test("local and disabled MCPs do not acquire a modern protocol", () => {
  assert.deepEqual(mapRuntimeMcpToV2({ type: "local", command: ["example-mcp"], protocol: "auto" }, "openwork-cloud"), {
    type: "local", command: ["example-mcp"], environment: {},
  });
  assert.equal(mapRuntimeMcpToV2({ ...remote, enabled: false }, "openwork-cloud"), undefined);
  assert.equal(mapRuntimeMcpToV2({ ...remote, disabled: true }, "openwork-cloud"), undefined);
  assert.equal(mapRuntimeMcpToV2({ ...remote, url: "file:///invalid" }, "openwork-cloud"), undefined);
});

test("reconciliation fingerprint includes the managed protocol upgrade, not unsupported runtime fields", () => {
  // The reconciler fingerprints the mapped config, not the persisted V1 input.
  const fingerprint = (value: unknown, name?: string) => JSON.stringify(mapRuntimeMcpToV2(value, name));
  const previous = fingerprint(remote);
  const managed = fingerprint(remote, "openwork-cloud");
  assert.notEqual(managed, previous, "the protocol upgrade replaces an existing legacy registration");
  assert.equal(fingerprint(remote, "third-party"), previous, "generic registrations are not restarted");
  assert.equal(fingerprint({ ...remote, protocol: "legacy", unsupported: true }, "openwork-cloud"), managed,
    "ignored source fields cannot cause perpetual managed re-registration");
  assert.notEqual(fingerprint({ ...remote, headers: { Authorization: "Bearer rotated-test-token" } }, "openwork-cloud"), managed,
    "credential changes still replace the managed registration");
});
