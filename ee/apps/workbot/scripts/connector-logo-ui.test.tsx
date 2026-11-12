import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ConnectorLine } from "../../../packages/workbot-ui/src/connector-line";
import { connectorSummary } from "../../../packages/workbot-ui/src/connector-activity";
import { setWorkbotHost } from "../../../packages/workbot-ui/src/host";
import type { WorkbotTurn } from "../../../packages/workbot-ui/src/data";

setWorkbotHost({
  requestJson: async () => ({ response: new Response(), payload: {} }),
  prepare: async (path) => ({ url: path, headers: new Headers(), credentials: "same-origin" }),
  user: null, useConnectedApps: () => [], appIcons: () => [], homeHref: "/",
});
const turn: WorkbotTurn = {
  id: "logos", text: "Check my apps", sentAt: 100, finishedAt: null, status: "working",
  attachments: [], outputs: [], reaction: null, modelSteps: 1, error: null, retryable: false,
  tasks: [], greeting: false, suggestions: [], navigation: [],
  parts: [{ kind: "steps", steps: ["Exa", "Exa", "Google Drive", "Linear", "Slack", "GitHub", "PlanetScale", "Research"].map((app, index) => ({
    app, label: `Checking ${app}`, icon: "app", status: index === 7 ? "running" : "done", startedAt: 110, finishedAt: index === 7 ? null : 120, updates: [], detail: "Read notes",
  })) }],
};
function render(status: WorkbotTurn["status"]) {
  const summary = connectorSummary({ ...turn, status }, null);
  assert.ok(summary);
  return renderToStaticMarkup(<ConnectorLine summary={summary} />);
}

test("connectors are a round overlapping group, deduplicated, first-use order, five logos and +N; no visible status sentence", () => {
  const html = render("working");
  assert.equal((html.match(/data-workbot-connector-logo=/g) ?? []).length, 5);
  assert.equal((html.match(/data-workbot-connector-logo="Exa"/g) ?? []).length, 1);
  assert.ok(html.indexOf('data-workbot-connector-logo="Exa"') < html.indexOf('data-workbot-connector-logo="Google Drive"'));
  assert.match(html, /data-workbot-connector-more="true">\+2/);
  assert.match(html, /rounded-full/);
  assert.match(html, /-space-x-\[7px\]/);
  assert.match(html, /aria-label="Used Exa, Google Drive, Linear, Slack, GitHub, PlanetScale and Research"/);
  assert.doesNotMatch(html.replace(/<[^>]*>/g, ""), /Searching|Checking|Used|searches|actions/);
});

test("the live group has one soft ring (including overflow); the same static logos survive completion and reload", () => {
  const live = render("working");
  assert.equal((live.match(/workbot-connector-pulse/g) ?? []).length, 1);
  const done = render("done");
  assert.doesNotMatch(done, /workbot-connector-pulse/);
  assert.equal((done.match(/data-workbot-connector-logo=/g) ?? []).length, 5);
  // Ignore generated accessibility ids: a fresh render, like a reload, builds the same group from persisted steps.
  assert.equal(done.replace(/id="[^"]*"/g, ""), render("done").replace(/id="[^"]*"/g, ""));
});

test("a missing real logo uses a neat letter inside the circle, not a plug or raw tool name", () => {
  const html = render("done");
  assert.match(html, /data-workbot-app-letter="true">E/);
  assert.match(html, /data-workbot-app-letter="true">G/);
  assert.doesNotMatch(html, /lucide-plug|mcp:|emc_|execute_capability/);
});

test("OpenWork's own features are one OpenWork mark in the same round group, pulsing only while one runs", () => {
  const step = (app: string | null, label: string, running: boolean, extra: Record<string, unknown> = {}) =>
    ({ app, label, icon: "app" as const, status: running ? "running" as const : "done" as const, startedAt: 110, finishedAt: running ? null : 120, updates: [], ...extra });
  const openwork = { site: "openworklabs.com", openwork: true as const };
  const mixed = (running: boolean): WorkbotTurn => ({ ...turn, status: running ? "working" : "done", parts: [{ kind: "steps", steps: [
    step("Exa", "Searching Exa", false, { site: "exa.ai" }),
    step("OpenWork", "Starting a remote task", false, { ...openwork, remote: true, detail: "Remote task" }),
    step("Google Drive", "Searching Google Drive", false),
    step("OpenWork", "Reading a skill", false, { ...openwork, detail: "Weekly digest" }),
    step("Linear", "Checking Linear", false, { site: "linear.app" }),
    step("OpenWork", "Starting a background task", running, { ...openwork, detail: "Draft the digest" }),
  ] }] });
  const html = (running: boolean) => { const summary = connectorSummary(mixed(running), null); assert.ok(summary); return renderToStaticMarkup(<ConnectorLine summary={summary} />); };
  const done = html(false);
  assert.deepEqual([...done.matchAll(/data-workbot-connector-logo="([^"]+)"/g)].map((match) => match[1]), ["Exa", "OpenWork", "Google Drive", "Linear"]);
  assert.equal((done.match(/data-workbot-openwork-mark/g) ?? []).length, 1, "one OpenWork mark, never a monitor icon or letter");
  assert.doesNotMatch(done, /lucide-monitor/);
  assert.match(done, /aria-label="Used Exa, OpenWork, Google Drive and Linear"/);
  assert.doesNotMatch(done, /workbot-connector-pulse/);
  const live = html(true);
  assert.match(live, /data-workbot-connector-logo="OpenWork" data-active="true"/);
  assert.equal((live.match(/workbot-connector-pulse/g) ?? []).length, 1);
});
