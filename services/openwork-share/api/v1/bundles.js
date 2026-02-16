import { put } from "@vercel/blob";
import { ulid } from "ulid";

function getEnv(name, fallback = "") {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizeBaseUrl(input) {
  const trimmed = String(input ?? "").trim();
  return trimmed.replace(/\/+$/, "");
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type,Accept,X-OpenWork-Bundle-Type,X-OpenWork-Schema-Version,X-OpenWork-Name",
  );
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
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
  const baseUrl = normalizeBaseUrl(getEnv("PUBLIC_BASE_URL", "https://share.openwork.software"));

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

  // Validate JSON at least parses.
  try {
    JSON.parse(raw.toString("utf8"));
  } catch {
    res.status(422).json({ message: "Invalid JSON" });
    return;
  }

  const id = ulid();
  const pathname = `bundles/${id}.json`;

  try {
    await put(pathname, raw, {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Blob put failed";
    res.status(500).json({ message });
    return;
  }

  res.setHeader("Content-Type", "application/json");
  res.status(200).send(JSON.stringify({ url: `${baseUrl}/b/${id}` }));
}
