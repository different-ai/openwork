import { storeBundleJson } from "../_lib/blob-store.js";
import { buildBundleUrls, getEnv, readBody, setCors, validateBundlePayload } from "../_lib/share-utils.js";

function formatPublishError(error) {
  const message = error instanceof Error ? error.message : "Blob put failed";
  if (message.includes("BLOB_READ_WRITE_TOKEN") || message.includes("No token found")) {
    return "Publishing requires BLOB_READ_WRITE_TOKEN in the server environment.";
  }
  return message;
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ message: "Method not allowed" });
    return;
  }

  const maxBytes = Number.parseInt(getEnv("MAX_BYTES", "5242880"), 10);

  const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
  if (!contentType.includes("application/json")) {
    res.status(415).json({ message: "Expected application/json" });
    return;
  }

  const raw = await readBody(req);
  if (!raw || raw.length === 0) {
    res.status(400).json({ message: "Body is required" });
    return;
  }
  if (raw.length > maxBytes) {
    res.status(413).json({ message: "Bundle exceeds upload limit", maxBytes });
    return;
  }

  const rawJson = raw.toString("utf8");
  const validation = validateBundlePayload(rawJson);
  if (!validation.ok) {
    res.status(422).json({ message: validation.message });
    return;
  }

  try {
    const { id } = await storeBundleJson(rawJson);
    const urls = buildBundleUrls(req, id);
    res.setHeader("Content-Type", "application/json");
      res.status(200).send(JSON.stringify({ url: urls.shareUrl }));
  } catch (e) {
    res.status(500).json({ message: formatPublishError(e) });
  }
}
