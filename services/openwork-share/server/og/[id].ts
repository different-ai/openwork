import type { IncomingMessage, ServerResponse } from "node:http";

import { fetchBundleJsonById } from "../_lib/blob-store.ts";
import { parseOgImageVariant } from "../_lib/og-image-variants.ts";
import { renderBundleOgImage, renderRootOgImage } from "../_lib/render-og-image.ts";
import { setCors } from "../_lib/share-utils.ts";

interface LegacyApiRequest extends IncomingMessage {
  method?: string;
  query?: Record<string, string | string[] | undefined>;
}

interface LegacyApiResponse extends ServerResponse {
  status(code: number): LegacyApiResponse;
  json(body: unknown): void;
  send(body: string): void;
}

export default async function handler(req: LegacyApiRequest, res: LegacyApiResponse): Promise<void> {
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
  const variant = parseOgImageVariant(req.query?.variant);
  res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
  res.setHeader("Cache-Control", id === "root" ? "public, max-age=3600" : "public, max-age=3600, stale-while-revalidate=86400");

  if (id === "root") {
    res.status(200).send(renderRootOgImage(variant));
    return;
  }

  try {
    const { rawJson } = await fetchBundleJsonById(id);
    res.status(200).send(renderBundleOgImage({ id, rawJson, variant }));
  } catch {
    res.status(404).send(renderRootOgImage(variant));
  }
}
