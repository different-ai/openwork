import assert from "node:assert/strict";
import { test } from "node:test";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConnectorDiscoveryChecks, discoveryCheckDescription } from "./connector-discovery-checks";

function render(props: ComponentProps<typeof ConnectorDiscoveryChecks>) {
  return renderToStaticMarkup(<ConnectorDiscoveryChecks {...props} />);
}

test("the display trusts stage validation, not the HTTP status code", () => {
  assert.equal(discoveryCheckDescription({ id: "server", status: "passed", httpStatus: 401, code: "authentication_required" }, false), "Reached the server. Sign-in is required.");
  assert.match(discoveryCheckDescription({ id: "provider", status: "failed", httpStatus: 200, code: "issuer_mismatch" }, false), /inconsistent/);
  assert.equal(discoveryCheckDescription({ id: "provider", status: "skipped", code: "not_required" }, false), "Not needed");
  assert.equal(discoveryCheckDescription(undefined, true), "Waiting");
  assert.equal(discoveryCheckDescription(undefined, false), "No result reported");
});

test("a held check shows real 401 success and waits for later phases", () => {
  const html = render({
    checks: [{ id: "server", status: "passed", httpStatus: 401, code: "authentication_required" }, { id: "resource", status: "running" }],
    discovering: true, failed: false, onRetry() {},
  });
  assert.match(html, /data-testid="setup-check-server" data-status="done"/);
  assert.match(html, /aria-label="HTTP status 401"/);
  assert.match(html, /data-testid="setup-check-resource" data-status="running"/);
  assert.match(html, /data-testid="setup-check-provider" data-status="waiting"/);
  assert.match(html, /Checking the server/);
  assert.match(html, /<details[^>]*open=""/);
});

test("an issuer mismatch remains expanded and is never painted as a successful HTTP 200 check", () => {
  const html = render({
    checks: [{ id: "provider", status: "failed", httpStatus: 200, code: "issuer_mismatch" }],
    discovering: false, failed: false, onRetry() {},
  });
  assert.match(html, /data-testid="setup-check-provider" data-status="failed"/);
  assert.match(html, /Needs attention/);
  assert.match(html, /inconsistent/);
  assert.match(html, /<details[^>]*open=""/);
});

test("a completed anonymous discovery collapses without claiming all three phases passed", () => {
  const html = render({
    checks: [{ id: "server", status: "passed", httpStatus: 200 }, { id: "resource", status: "skipped", code: "not_required" }, { id: "provider", status: "skipped", code: "not_required" }],
    discovering: false, failed: false, onRetry() {},
  });
  assert.doesNotMatch(html, /<details[^>]*open=""/);
  assert.match(html, /data-testid="setup-check-provider" data-status="skipped"/);
  assert.match(html, /Not needed/);
  assert.match(html, /Detection complete/);
});

test("missing optional OAuth metadata is neutral for manual-credential servers, not falsely verified", () => {
  const html = render({
    checks: [{ id: "server", status: "passed", httpStatus: 401 }, { id: "resource", status: "failed", code: "unavailable" }, { id: "provider", status: "skipped", code: "unavailable" }],
    discovering: false, failed: false, manualCredentials: true, onRetry() {},
  });
  assert.match(html, /data-testid="setup-check-resource" data-status="skipped"/);
  assert.match(html, /Not published/);
  assert.doesNotMatch(html, /Needs attention/);
  assert.doesNotMatch(html, /data-testid="setup-check-resource" data-status="done"/);
});

test("manual credentials never hide issuer mismatch or failed reachability", () => {
  const html = render({
    checks: [{ id: "server", status: "failed", code: "unavailable" }, { id: "provider", status: "failed", code: "issuer_mismatch", httpStatus: 200 }],
    discovering: false, failed: false, manualCredentials: true, onRetry() {},
  });
  assert.match(html, /data-testid="setup-check-server" data-status="failed"/);
  assert.match(html, /data-testid="setup-check-provider" data-status="failed"/);
  assert.match(html, /Needs attention/);
});
