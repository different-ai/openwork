import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { OrganizationRegisteredInstance } from "@openwork/types/den/remote-devices";
import { RegisteredInstances, registeredInstanceLine, registeredInstanceStatus } from "./registered-instances";

const instance: OrganizationRegisteredInstance = {
  id: "worker_1", name: "Shared research", owner: null, destination: "cloud", status: "healthy",
  lastSeenAt: null, lastActiveAt: null, version: null, provider: "cloud", region: "test-region", createdAt: "2026-11-10T12:00:00Z",
};

test("registered instances display stored lifecycle, unknown owner and heartbeat honestly", () => {
  const html = renderToStaticMarkup(<RegisteredInstances instances={[instance]} total={1} page={1} pageSize={50} busy={false} onPage={() => {}} now={Date.parse("2026-11-10T12:01:00Z")} />);
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  assert.match(text, /OpenWork instances/);
  assert.match(text, /OpenWork instances 1 Instance Owner Reported status Last contact Version/);
  // What it is and where it runs under the name; then owner, stored status, heartbeat and version.
  assert.match(text, /Shared research Cloud instance, cloud, test-region Not reported Healthy Never reported Not reported/);
  assert.equal(registeredInstanceLine({ destination: "local", provider: null, region: null }), "Local instance");
  assert.match(html, /data-testid="registered-instances"/);
  assert.doesNotMatch(html, /<table|<td/);
  assert.doesNotMatch(text, /Online|Shared with the organization|Provision a/);
  assert.doesNotMatch(html.replace(/ xmlns="[^"]*"/g, ""), /\/admin|https?:\/\/|token|endpoint|workspacePath/);
});

test("instances paginate independently from computers and disabled boundaries stay disabled", () => {
  const html = renderToStaticMarkup(<RegisteredInstances instances={[{ ...instance, destination: "local", status: "stopped" }]} total={120} page={1} pageSize={50} busy={false} onPage={() => {}} now={0} />);
  assert.match(html, /aria-label="OpenWork instance pages"/);
  assert.match(html, /Page 1 of 3/);
  assert.match(html, /<button[^>]*disabled=""[^>]*><div[^>]*>Previous instances/);
  assert.match(html, /Local instance/);
  assert.match(html, /OpenWork instances<\/h2><p[^>]*>120</);
  assert.equal(registeredInstanceStatus({ status: "provisioning" }), "Provisioning");
  assert.equal(registeredInstanceStatus({ status: "failed" }), "Failed");
});

test("an organization with no instances has no section about them, unless a search is why", () => {
  const props = { instances: [], total: 0, page: 1, pageSize: 50, busy: false, onPage: () => {}, now: 0 };
  assert.equal(renderToStaticMarkup(<RegisteredInstances {...props} />), "");
  const searched = renderToStaticMarkup(<RegisteredInstances {...props} filtered />);
  assert.match(searched, /data-testid="registered-instances"/);
  assert.match(searched, /No OpenWork instances match this view\./);
});
