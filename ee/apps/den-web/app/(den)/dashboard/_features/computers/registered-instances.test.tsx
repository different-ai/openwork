import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { OrganizationRegisteredInstance } from "@openwork/types/den/remote-devices";
import { RegisteredInstances, registeredInstanceStatus } from "./registered-instances";

const instance: OrganizationRegisteredInstance = {
  id: "worker_1", name: "Shared research", owner: null, destination: "cloud", status: "healthy",
  lastSeenAt: null, lastActiveAt: null, version: null, provider: "cloud", region: "test-region", createdAt: "2026-11-10T12:00:00Z",
};

test("registered instances display stored lifecycle, unknown owner and heartbeat honestly", () => {
  const html = renderToStaticMarkup(<RegisteredInstances instances={[instance]} total={1} page={1} pageSize={50} busy={false} onPage={() => {}} now={Date.parse("2026-11-10T12:01:00Z")} />);
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  assert.match(text, /OpenWork instances/);
  assert.match(text, /Owner.*Type.*Reported status.*Last contact.*Version.*Provider.*Region/);
  assert.match(text, /Shared research Not reported Cloud instance Healthy Never reported Not reported cloud test-region/);
  assert.doesNotMatch(text, /Online|Shared with the organization|Provision a/);
  assert.doesNotMatch(html, /\/admin|https?:\/\/|token|endpoint|workspacePath/);
});

test("instances paginate independently from computers and disabled boundaries stay disabled", () => {
  const html = renderToStaticMarkup(<RegisteredInstances instances={[{ ...instance, destination: "local", status: "stopped" }]} total={120} page={1} pageSize={50} busy={false} onPage={() => {}} now={0} />);
  assert.match(html, /aria-label="OpenWork instance pages"/);
  assert.match(html, /Page 1 of 3/);
  assert.match(html, /<button[^>]*disabled=""[^>]*><div[^>]*>Previous instances/);
  assert.match(html, /Local instance/);
  assert.equal(registeredInstanceStatus({ status: "provisioning" }), "Provisioning");
  assert.equal(registeredInstanceStatus({ status: "failed" }), "Failed");
});
