import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerResponse } from "node:http";
import { createServer } from "vite";
import type { Place, Seed } from "@openwork/env";
import { chrome } from "@openwork/hosts";
import { allocateFreePorts } from "@openwork/cdp";
import { buildZip, utf8Bytes } from "../../packages/workbook/src/index.ts";

/** Shipped Workbot attachment previews with deterministic original files, no model or Office service. */
export async function workbotPreview(_seed: Seed, { place }: { place: Place }) {
  const resources = new AsyncDisposableStack();
  const downloads = await mkdtemp(join(tmpdir(), "workbot-preview-proof-"));
  resources.defer(() => rm(downloads, { recursive: true, force: true }));
  const originalText = utf8Bytes("Preview content. ".repeat(125_001) + "ORIGINAL-END");
  const csv = utf8Bytes("Name,Value\n" + Array.from({ length: 1005 }, (_, index) => `Row ${index + 1},${index}`).join("\n"));
  const slides = await buildZip([{ name: "ppt/slides/slide1.xml", data: utf8Bytes(`<p:sld xmlns:p="p" xmlns:a="a"><a:t>Quarterly review</a:t>${Array.from({ length: 12 }, (_, index) => `<a:p><a:t>Point ${index + 1}</a:t></a:p>`).join("")}</p:sld>`) }]);
  const files = [
    { id: "notes", name: "Notes.txt", mediaType: "text/plain", bytes: originalText },
    { id: "table", name: "Table.csv", mediaType: "text/csv", bytes: csv },
    { id: "slides", name: "Review.pptx", mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", bytes: slides },
  ];
  let denyDownload = false;
  const streams = new Set<ServerResponse>();
  try {
    const [port] = await allocateFreePorts(1);
    const vite = await createServer({
      configFile: fileURLToPath(new URL("../../ee/apps/workbot/vite.config.ts", import.meta.url)),
      server: { host: "127.0.0.1", port, strictPort: true },
      plugins: [{ name: "workbot-preview-fixture", configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const url = new URL(req.url ?? "/", "http://fixture");
          if (!url.pathname.startsWith("/v1/workbot")) return next();
          const json = (body: unknown, status = 200) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };
          if (url.pathname === "/v1/workbot/me") return json({ name: "Alex", email: "alex@example.test", userId: "user_example", organizationId: "org_example", organizationName: "Example", enabled: true, calendar: false, documents: false, workspaceAssistant: false, sideChats: false, denUrl: "https://example.test" });
          if (url.pathname === "/v1/workbot/events") { res.statusCode = 200; res.setHeader("content-type", "text/event-stream"); res.write("event: ready\ndata: {}\n\n"); streams.add(res); res.on("close", () => streams.delete(res)); return; }
          if (url.pathname === "/v1/workbot") return json({ available: true, name: "Workbot", organizationName: "Example", status: "idle", turns: [{ id: "example", text: "Prepare the files", status: "done", sentAt: Date.now() - 5000, finishedAt: Date.now() - 1000, attachments: [], outputs: files.map(file => ({ id: file.id, name: file.name, mediaType: file.mediaType, size: file.bytes.byteLength })), parts: [{ kind: "text", text: "Here are the files.", step: 0 }], modelSteps: 1, error: null }], hasEarlier: false, filesEnabled: false });
          if (url.pathname.endsWith("/preview")) return json({ error: "not_found" }, 404);
          const file = files.find(file => url.pathname === `/v1/workbot/files/${file.id}`);
          if (file) {
            if (denyDownload) return json({ error: "file_unavailable" }, 503);
            res.setHeader("content-type", file.mediaType); res.setHeader("content-disposition", `attachment; filename="${file.name}"`); res.end(file.bytes); return;
          }
          return json({ error: "not_found" }, 404);
        });
      } }],
    });
    resources.defer(async () => { for (const stream of streams) stream.end(); await vite.close(); });
    await vite.listen();
    const url = vite.resolvedUrls?.local[0];
    if (!url) throw new Error("Workbot preview proof did not start");
    const web = resources.use(await chrome({ host: place.host(), name: "workbot-preview", startUrl: url, headless: true }));
    console.error(`[workbot-preview] web=${url} chromePid=${web.handle.pid ?? "remote"} cdp=${web.handle.cdpUrl}`);
    await web.client.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads, eventsEnabled: true });
    return {
      web, url,
      denyDownload() { denyDownload = true; }, restoreDownload() { denyDownload = false; },
      async originalDownloaded() { try { const bytes = await readFile(join(downloads, "Notes.txt")); return { length: bytes.byteLength, complete: bytes.equals(originalText), suffix: bytes.subarray(-12).toString() }; } catch { return null; } },
      async [Symbol.asyncDispose]() { await resources.disposeAsync(); },
    };
  } catch (error) { await resources.disposeAsync(); throw error; }
}
