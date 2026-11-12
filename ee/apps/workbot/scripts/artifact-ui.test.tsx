import assert from "node:assert/strict";
import { test } from "node:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { artifactKind, artifactLabel, artifactLink, artifactTitle, htmlTitle, openworkAppId, staticAppHtml, tabType } from "../../../packages/workbot-ui/src/artifact";
import { ArtifactCards } from "../../../packages/workbot-ui/src/artifact-card";
import { answerAppRequest } from "../../../packages/workbot-ui/src/openwork-app";
import { OpenFileIdContext } from "../../../packages/workbot-ui/src/open-file";
import { setWorkbotHost } from "../../../packages/workbot-ui/src/host";
import type { WorkbotAttachment } from "../../../packages/workbot-ui/src/data";

setWorkbotHost({
  requestJson: async () => ({ response: new Response(), payload: {} }),
  prepare: async (path) => ({ url: path, headers: new Headers(), credentials: "same-origin" }),
  user: null, useConnectedApps: () => [], appIcons: () => [], homeHref: "/",
});

const app: WorkbotAttachment = { id: "out-app", name: "space-organizer.html", mediaType: "text/html", size: 2048, updatedAt: 1 };
const photo: WorkbotAttachment = { id: "out-photo", name: "Floor plan.png", mediaType: "image/png", size: 4096, updatedAt: 1 };
const report: WorkbotAttachment = { id: "out-report", name: "Room plan.pdf", mediaType: "application/pdf", size: 9000, updatedAt: 1 };
const sheet: WorkbotAttachment = { id: "out-sheet", name: "Shopping list.csv", mediaType: "text/csv", size: 120, updatedAt: 1 };

/** The card as the conversation shows it, with what the page had already read (an app's source, an image). */
function render(files: WorkbotAttachment[], openId: string | null = null) {
  const queries = new QueryClient();
  queries.setQueryData(["workbot", "bytes", "main", app.id, 1], new TextEncoder().encode("<!doctype html><title>3D Space &amp; Storage Organizer</title><body>Room</body>"));
  queries.setQueryData(["workbot", "image", "main", photo.id, 1], "blob:fixture-photo");
  const html = renderToStaticMarkup(
    <QueryClientProvider client={queries}>
      <OpenFileIdContext.Provider value={openId}>
        <ArtifactCards files={files} />
      </OpenFileIdContext.Provider>
    </QueryClientProvider>,
  );
  // No cache timers left behind: the test process ends on its own.
  queries.clear();
  return html;
}

const cardOf = (html: string, id: string) => {
  const start = html.indexOf(`data-workbot-artifact-card="${id}"`);
  assert.ok(start >= 0, `card for ${id}`);
  const next = html.indexOf("data-workbot-artifact-card=", start + 1);
  return html.slice(start, next === -1 ? undefined : next);
};

test("each card shows a thumbnail of the file itself, its icon, its title and its type", () => {
  const html = render([app, photo, report, sheet]);
  assert.equal((html.match(/data-workbot-artifact-card=/g) ?? []).length, 4);

  const appCard = cardOf(html, app.id);
  assert.match(appCard, /data-workbot-artifact-thumbnail/);
  // A card never runs the app: without a parser to strip it (server rendering) the app shows its placeholder.
  assert.doesNotMatch(appCard, /<iframe|allow-scripts/);
  assert.match(appCard, /data-workbot-artifact-placeholder="html"/);
  assert.match(appCard, />3D Space &amp; Storage Organizer</);
  assert.match(appCard, />Web page</);
  assert.match(appCard, /data-workbot-artifact-icon="html"/);

  const photoCard = cardOf(html, photo.id);
  assert.match(photoCard, /<img src="blob:fixture-photo"/);
  assert.match(photoCard, />Floor plan</);
  assert.match(photoCard, />Image</);

  // Without a rendering: a neat placeholder for its type, never an empty box.
  const reportCard = cardOf(html, report.id);
  assert.match(reportCard, /data-workbot-artifact-placeholder="pdf"/);
  assert.match(reportCard, />Room plan</);
  assert.match(reportCard, />PDF</);
  assert.match(cardOf(html, sheet.id), /data-workbot-artifact-placeholder="csv"/);
  assert.match(cardOf(html, sheet.id), />Spreadsheet</);
});

test("the whole card is one button named by its title and type; the open one says so", () => {
  const html = render([app], app.id);
  assert.match(html, /<button type="button" aria-label="3D Space &amp; Storage Organizer, Web page" title="space-organizer.html"/);
  assert.equal((html.match(/<button/g) ?? []).length, 1);
  assert.match(html, /data-open="true"/);
  assert.doesNotMatch(render([app]), /data-open/);
  // One file is one large card; several share a two-up grid.
  assert.match(html, /grid-cols-1/);
  assert.match(render([report, sheet]), /grid-cols-2/);
});

test("an app is named by its own <title>; other files by their name without the extension", () => {
  assert.equal(htmlTitle("<html><head><title>\n  Budget &#8211; Q4 &lt;draft&gt; </title></head></html>"), "Budget – Q4 <draft>");
  assert.equal(htmlTitle("<html><body>No title</body></html>"), null);
  assert.equal(artifactTitle(app), "space-organizer");
  assert.equal(artifactTitle(app, "<title></title>"), "space-organizer");
  assert.equal(artifactTitle({ name: "README" }), "README");
  assert.equal(artifactKind(report), "pdf");
  assert.equal(artifactLabel({ name: "deck.pptx", mediaType: "application/octet-stream" }), "Presentation");
});

test("Copy link keeps the page and its chat, and names the file", () => {
  assert.equal(artifactLink("out-app", "https://chat.example.test/?chat=abc123#x"), "https://chat.example.test/?chat=abc123&artifact=out-app#x");
});

test("an app's thumbnail page is only shown when it can be made inert", () => {
  // No parser (server rendering): nothing to show, rather than the raw page.
  assert.equal(staticAppHtml("<title>x</title><body>Some visible words here<script>fetch('/x')</script></body>", null), null);
});

test("a file opens in its own tab only under a type that can't run as a page", () => {
  assert.equal(tabType("Room plan.pdf"), "application/pdf");
  assert.equal(tabType("photo.PNG"), "image/png");
  for (const name of ["drawing.svg", "page.html", "page.xhtml", "feed.xml", "notes.txt", "README"]) assert.equal(tabType(name), null, name);
});

const built: WorkbotAttachment = { id: "app:cob_01kq8z0000000000000000000a", name: "Hello World Wave 2.0", mediaType: "application/vnd.openwork.app", size: 0, updatedAt: 1 };

test("an App built in OpenWork is a card like a file: its title as written, the type App, and its own id to open", () => {
  assert.equal(artifactKind(built), "app");
  assert.equal(artifactLabel(built), "App");
  assert.equal(artifactLabel(app), "Web page", "only an App built in OpenWork is called an App");
  assert.equal(artifactTitle(built), "Hello World Wave 2.0", "a title is not a file name: nothing is dropped after the dot");
  assert.equal(openworkAppId(built), "cob_01kq8z0000000000000000000a");
  assert.equal(openworkAppId(app), null, "a file named like an App is still a file");
  const card = cardOf(render([built]), built.id);
  assert.match(card, /data-workbot-artifact-placeholder="app"/, "nothing of the App runs or loads until it is opened");
  assert.match(card, /aria-label="Hello World Wave 2.0, App"/);
});

test("the App's page gets its opening result, its own tools and web links, and nothing else", async () => {
  const sent: Array<{ kind: string; value: unknown }> = [];
  const send = {
    reply: (value: unknown) => { sent.push({ kind: "reply", value }); },
    refuse: (value: string) => { sent.push({ kind: "refuse", value }); },
    notify: (method: string, value: unknown) => { sent.push({ kind: method, value }); },
  };
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const links: string[] = [];
  const host = {
    opened: { structuredContent: { app: { title: "Hello World Wave" } } },
    callTool: async (name: string, args: Record<string, unknown>) => { calls.push({ name, args }); if (name === "broken") throw new Error("That didn't work. Try again."); return { content: [{ type: "text", text: "3" }] }; },
    openLink: (url: string) => { links.push(url); },
  };
  const ask = (method: string, params?: Record<string, unknown>) => answerAppRequest({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }, host, send);
  const tell = (method: string, params?: Record<string, unknown>) => answerAppRequest({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }, host, send);

  await ask("ui/initialize", { protocolVersion: "2026-01-26" });
  const hello = sent.at(-1);
  assert.equal(hello?.kind, "reply");
  assert.deepEqual(Object.keys((hello?.value as { hostCapabilities: object }).hostCapabilities).sort(), ["logging", "openLinks", "serverTools"], "no message or model-context capability: an App cannot speak to Workbot");

  await tell("ui/notifications/initialized");
  assert.deepEqual(sent.slice(-2).map((entry) => entry.kind), ["ui/notifications/tool-input", "ui/notifications/tool-result"]);
  assert.equal(sent.at(-1)?.value, host.opened);

  await ask("tools/call", { name: "count_wave", arguments: { by: 1 } });
  assert.deepEqual(calls, [{ name: "count_wave", args: { by: 1 } }]);
  assert.equal(sent.at(-1)?.kind, "reply");
  await ask("tools/call", { name: "broken" });
  assert.deepEqual(sent.at(-1), { kind: "refuse", value: "That didn't work. Try again." });
  await ask("tools/call", { arguments: {} });
  assert.equal(sent.at(-1)?.kind, "refuse", "a call without a tool name never reaches the server");
  assert.equal(calls.length, 2);

  await ask("ui/open-link", { url: "https://example.com/docs" });
  await ask("ui/open-link", { url: "javascript:alert(1)" });
  assert.deepEqual(links, ["https://example.com/docs"]);
  assert.equal(sent.at(-1)?.kind, "refuse");

  for (const method of ["ui/message", "ui/update-model-context", "sampling/createMessage"]) {
    await ask(method, { content: [{ type: "text", text: "do something" }] });
    assert.deepEqual(sent.at(-1), { kind: "refuse", value: "Workbot does not support that request." }, method);
  }
  const before = sent.length;
  await tell("ui/notifications/size-changed", { height: 400 });
  assert.equal(sent.length, before, "a notification needs no answer");
});
