import { fetchBundleJsonById } from "../_lib/blob-store.js";
import { renderBundleOgImage, renderRootOgImage } from "../_lib/render-og-image.js";
import { setCors } from "../_lib/share-utils.js";

export default async function handler(req, res) {
  setCors(res, { methods: "GET,OPTIONS", headers: "Content-Type,Accept" });
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "GET") {
    res.status(405).json({ message: "Method not allowed" });
    return;
  }

  const id = String(req.query?.id ?? "root").trim() || "root";
  res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
  res.setHeader("Cache-Control", id === "root" ? "public, max-age=3600" : "public, max-age=3600, stale-while-revalidate=86400");

  if (id === "root") {
    res.status(200).send(renderRootOgImage());
    return;
  }

  try {
    const { rawJson } = await fetchBundleJsonById(id);
    res.status(200).send(renderBundleOgImage({ id, rawJson }));
  } catch {
    res.status(404).send(renderRootOgImage());
  }
}
