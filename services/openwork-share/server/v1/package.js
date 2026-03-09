import { storeBundleJson } from "../_lib/blob-store.js";
import { packageOpenworkFiles } from "../_lib/package-openwork-files.js";
import { buildBundleUrls, getEnv, readBody, setCors } from "../_lib/share-utils.js";

function formatPublishError(error) {
  const message = error instanceof Error ? error.message : "Failed to package files";
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
    res.status(413).json({ message: "Package request exceeds upload limit", maxBytes });
    return;
  }

  let body;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    res.status(422).json({ message: "Invalid JSON" });
    return;
  }

  try {
    const packaged = packageOpenworkFiles(body);
    if (body?.preview) {
      res.status(200).json(packaged);
      return;
    }

    const { id } = await storeBundleJson(JSON.stringify(packaged.bundle));
    const urls = buildBundleUrls(req, id);
    res.status(200).json({
      ...packaged,
      url: urls.shareUrl,
      id,
    });
  } catch (error) {
    res.status(422).json({ message: formatPublishError(error) });
  }
}
