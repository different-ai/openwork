import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { NOW, services } from "../diagnostics/diagnostics-test-fixtures";
import type { ServicesViewState } from "./service-readiness-data";
import { ServicesView } from "./services-view";

function render(state: ServicesViewState): string {
  return renderToStaticMarkup(<ServicesView
    state={state} cooldown={false} checkNow={() => undefined} refresh={() => undefined} now={NOW} testId="admin-services-page"
  />);
}

function text(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
}

test("Admin › Services lists server facts and five timed services with the shared rows", () => {
  const html = render({ status: "ready", snapshot: services(), pending: false });
  const body = text(html);
  assert.match(html, /data-testid="admin-services-page"/);
  assert.equal([...html.matchAll(/data-testid="service-status-/g)].length, 5);
  assert.match(body, /OpenWork server 0\.19\.2/);
  assert.match(body, /Up 3 h, ready in 4\.1 s/);
  assert.match(body, /3 ms/);
  assert.match(body, /220 ms/);
  assert.match(body, /Email SMTP/);
  assert.match(body, /Resumable answers: not set up/);
  assert.match(body, /Checked 2 min ago/);
  assert.match(html, /data-testid="service-check-now"/);
  assert.match(html, /<details id="diagnostics-installation-headlessRunner" data-testid="service-details-headlessRunner"/);
  assert.match(html, /data-testid="service-details-toggle-headlessRunner"/);
  assert.doesNotMatch(body, /Slack|Resumable answers Ready|Model completions and message delivery are not tested|Off · platform admin|Feature rollouts/);
});

test("the first load is a skeleton of the same rows, and errors keep the last result", () => {
  const loading = render({ status: "checking", snapshot: null, pending: true });
  assert.doesNotMatch(loading, /service-status-/);
  assert.doesNotMatch(text(loading), /Loading/);
  const failed = render({ status: "error", snapshot: services(), pending: false, message: "Couldn't verify services." });
  assert.match(failed, /services-check-error/);
  assert.match(failed, /service-status-database/);
});
