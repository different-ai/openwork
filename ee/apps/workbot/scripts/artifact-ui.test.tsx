import assert from "node:assert/strict";
import { test } from "node:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { artifactKind, artifactLabel, artifactLink, artifactTitle, htmlTitle } from "../../../packages/workbot-ui/src/artifact";
import { ArtifactCards } from "../../../packages/workbot-ui/src/artifact-card";
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
  // The app runs in its own opaque origin, scaled down, without taking input or focus.
  assert.match(appCard, /<iframe[^>]*sandbox="allow-scripts"/);
  assert.doesNotMatch(appCard, /allow-same-origin/);
  assert.match(appCard, /<iframe[^>]*tabindex="-1"/);
  assert.match(appCard, /pointer-events-none/);
  assert.match(appCard, />3D Space &amp; Storage Organizer</);
  assert.match(appCard, />App</);
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
  assert.match(html, /<button type="button" aria-label="3D Space &amp; Storage Organizer, App" title="space-organizer.html"/);
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
