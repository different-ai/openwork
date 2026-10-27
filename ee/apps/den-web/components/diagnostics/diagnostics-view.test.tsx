import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { OrgDiagnostics } from "@openwork/types/den/diagnostics";
import { DiagnosticsView, type DiagnosticsViewProps } from "./diagnostics-view";
import { lockedReport, NOW, report } from "./diagnostics-test-fixtures";

function render(value: OrgDiagnostics | null, overrides: Partial<DiagnosticsViewProps> = {}): string {
  return renderToStaticMarkup(<DiagnosticsView
    report={value} loading={false} loadFailure={null} checkFailed={false} checking={false} cooldownSeconds={null}
    copied={false} now={NOW} orgSlug="workspace"
    onCheckNow={() => undefined} onCopyReport={() => undefined} onRetry={() => undefined}
    renderNetworkCheck={() => createElement("div", { "data-testid": "network-check-mounted" })}
    {...overrides}
  />);
}

function text(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
}

test("a self-hosted installation administrator sees every section in order, with services and durations", () => {
  const html = render(report());
  const body = text(html);
  assert.match(body, /Diagnostics/);
  assert.match(body, /Copy report/);
  assert.match(body, /Check now/);
  assert.match(body, /3 need attention/);
  assert.match(body, /Checked 2 min ago/);
  const order = ["Desktop app", "AI providers", "Connectors", "Installation", "Advanced"].map((title) => body.indexOf(` ${title} `));
  assert.ok(order.every((index, position) => index > 0 && (position === 0 || index > order[position - 1])), `sections out of order: ${order.join(",")}`);
  assert.match(body, /Self-hosted/);
  assert.match(body, /OpenWork server/);
  assert.match(body, /0\.19\.2/);
  assert.match(body, /Up 3 h, ready in 4\.1 s/);
  assert.match(body, /41 ms/);
  assert.match(body, /Email SMTP/);
  for (const id of ["database", "gateway", "headlessRunner", "workbot", "email"]) assert.match(html, new RegExp(`data-testid="service-status-${id}"`));
  assert.match(html, /data-testid="service-state-email"[^>]*>.*?Ready/);
  assert.match(html, /data-testid="service-state-headlessRunner"[^>]*>.*?Not set up/);
  assert.match(html, /data-testid="service-state-workbot"[^>]*>.*?Unreachable/);
  assert.match(body, /DEN_HEADLESS_RUNNER_URL/);
  assert.match(body, /Resumable answers: not set up/);
  // No explanatory middle-dot meta, and no status page link that does not exist.
  assert.doesNotMatch(body, /·|Status page|Model completions and message delivery are not tested/);
});

test("attention rows are tinted by severity, errors first, and link to their rows", () => {
  const html = render(report());
  const attention = html.slice(html.indexOf('data-testid="diagnostics-attention"'), html.indexOf("</ul>", html.indexOf('data-testid="diagnostics-attention"')));
  const items = [...attention.matchAll(/data-severity="(error|warning)"/g)].map((match) => match[1]);
  assert.deepEqual(items, ["error", "warning", "warning"]);
  assert.match(text(attention), /LiteLLM rejected the API key Update key/);
  assert.match(text(attention), /3 desktop startups couldn't reach OpenWork: certificate not trusted See details/);
  assert.match(text(attention), /Amazon Bedrock doesn't serve claude-opus-5 Fix models/);
  for (const href of ["#diagnostics-providers-gateway-litellm-default", "#diagnostics-desktop-signed_in", "#diagnostics-providers-gateway-bedrock-default"]) {
    assert.match(attention, new RegExp(`href="${href}"`));
    assert.match(html, new RegExp(`<details id="${href.slice(1)}"`));
  }
  assert.match(attention, /bg-red-50/);
  assert.match(attention, /bg-amber-50/);
});

test("rows carry one state badge and at most one action that goes to the fix", () => {
  const html = render(report());
  const body = text(html);
  assert.match(body, /Start to connected 142 startups/);
  assert.match(body, /1\.8 s typical, 4\.2 s slowest/);
  assert.match(body, /Failed to connect 3 people/);
  assert.match(body, /Add your company's root certificate to these devices' system trust store/);
  assert.match(body, /0\.19\.2 on 138 startups, 0\.18\.7 on 4 startups/);
  assert.match(body, /Window open 600 ms/);
  assert.match(body, /Signed in to OpenWork 500 ms/);
  assert.match(body, /3 of 3 models, 180 ms/);
  assert.match(body, /2 of 3 models, 340 ms/);
  assert.match(body, /Last worked 2 days ago/);
  assert.match(body, /Key rejected/);
  assert.match(body, /Managed by OpenWork/);
  assert.match(html, /href="\/dashboard\/ai-gateway\?tab=ai-providers"[^>]*>Update key</);
  assert.match(html, />Fix models</);
  assert.match(body, /Last event 4 min ago/);
  assert.match(body, /Gmail, Calendar/);
  assert.match(body, /Turned off in Google Cloud Sheets/);
  assert.match(body, /Network check From the OpenWork server/);
  assert.doesNotMatch(body, /→/);
});

test("the network check mounts only after its row is opened", () => {
  assert.doesNotMatch(render(report()), /network-check-mounted/);
});

test("OpenWork Cloud shows a managed installation row with no status page", () => {
  const body = text(render(report({ deployment: "cloud", installation: { access: "managed" } })));
  assert.match(body, /Installation Managed by OpenWork/);
  assert.doesNotMatch(body, /Status page|OpenWork server 0\.19|DEN_/);
});

test("a self-hosted organization admin who is not an installation admin sees who to ask", () => {
  const html = render(report({ installation: { access: "locked", reason: "installation_admin_required" } }));
  const body = text(html);
  assert.match(body, /Installation admins only/);
  assert.match(body, /Ask whoever set up OpenWork for your organization/);
  assert.doesNotMatch(html, /service-status-/);
});

test("locked sections stay on the page, name the permission and use neutral ink", () => {
  const html = render(lockedReport());
  const body = text(html);
  assert.match(body, /Requires permission to view desktop policies/);
  assert.match(body, /Requires permission to view Gateway providers/);
  assert.match(body, /Requires permission to view all connections/);
  assert.match(body, /Requires permission to view network diagnostics/);
  assert.match(body, /Ask an organization owner or admin/);
  assert.match(body, /Not checked yet/);
  for (const id of ["desktop", "providers", "connectors", "network"]) assert.match(html, new RegExp(`data-testid="diagnostics-${id}-locked"`));
  assert.doesNotMatch(html, /bg-red-50|text-red-600/);
});

test("empty sections invite the next step", () => {
  const body = text(render(report({
    attention: [],
    providers: { access: "granted", checkedAt: null, checking: false, items: [] },
    connectors: { access: "granted", checkedAt: null, items: [] },
    desktop: { access: "granted", windowHours: 24, startups: 0, connected: 0, failed: 0, people: 0, typicalMs: null, slowestMs: null, steps: [], failures: [], versions: [] },
  })));
  assert.match(body, /No AI providers set up Add a provider/);
  assert.match(body, /No connectors set up Add a connector/);
  assert.match(body, /No startups reported/);
  assert.match(body, /Everything is working/);
});

test("loading keeps the page layout with skeleton rows, never loading text", () => {
  const html = render(null, { loading: true });
  assert.match(html, /data-testid="diagnostics-loading"/);
  assert.doesNotMatch(text(html), /Loading/);
  assert.match(html, /Check now/);
});

test("failures give direction and keep the last report", () => {
  assert.match(text(render(null, { loadFailure: "error" })), /Couldn't load diagnostics.*Try again/);
  assert.match(text(render(null, { loadFailure: "forbidden" })), /Ask an organization owner or admin/);
  const kept = text(render(report(), { loadFailure: "error", checkFailed: true }));
  assert.match(kept, /Couldn't load diagnostics/);
  assert.match(kept, /Couldn't start a check/);
  assert.match(kept, /LiteLLM rejected the API key/);
  assert.match(text(render(report(), { checking: true })), /Checking/);
  assert.match(render(report(), { cooldownSeconds: 17 }), /title="Check now is available again in 17 s"/);
  assert.match(text(render(report(), { copied: true })), /Copied/);
});
