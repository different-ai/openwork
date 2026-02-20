import { head } from "@vercel/blob";
import { renderBundlePage, wantsDownload, wantsJsonResponse } from "./render-bundle-page.js";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Accept");
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "GET") {
    res.status(405).json({ message: "Method not allowed" });
    return;
  }

  const id = String(req.query?.id ?? "").trim();
  if (!id) {
    res.status(400).json({ message: "id is required" });
    return;
  }

  const pathname = `bundles/${id}.json`;

  let blob;
  try {
    blob = await head(pathname);
  } catch {
    res.status(404).json({ message: "Not found" });
    return;
  }

  // Proxy through this service so CORS is controlled here.
  const response = await fetch(blob.url, { method: "GET" });
  if (!response.ok) {
    res.status(502).json({ message: "Upstream blob fetch failed" });
    return;
  }

  const rawBuffer = Buffer.from(await response.arrayBuffer());
  const rawJson = rawBuffer.toString("utf8");
  const serveJson = wantsJsonResponse(req);

  res.setHeader("Vary", "Accept");
  res.setHeader("Cache-Control", "public, max-age=3600");

  if (serveJson) {
    res.setHeader("Content-Type", blob.contentType || response.headers.get("content-type") || "application/json");
    if (wantsDownload(req)) {
      res.setHeader("Content-Disposition", `attachment; filename="openwork-bundle-${id}.json"`);
    }
    res.status(200).send(rawBuffer);
    return;
  }

  const html = renderBundlePage({ id, rawJson, req });
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(200).send(html);
}
