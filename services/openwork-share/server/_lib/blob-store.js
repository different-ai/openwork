import { head, put } from "@vercel/blob";
import { ulid } from "ulid";

export async function storeBundleJson(rawJson) {
  const id = ulid();
  const pathname = `bundles/${id}.json`;
  const buffer = Buffer.from(String(rawJson), "utf8");

  await put(pathname, buffer, {
    access: "public",
    contentType: "application/json",
    addRandomSuffix: false,
  });

  return { id, pathname };
}

export async function fetchBundleJsonById(id) {
  const pathname = `bundles/${id}.json`;
  const blob = await head(pathname);
  const response = await fetch(blob.url, { method: "GET" });

  if (!response.ok) {
    throw new Error("Upstream blob fetch failed");
  }

  const rawBuffer = Buffer.from(await response.arrayBuffer());
  return {
    blob,
    rawBuffer,
    rawJson: rawBuffer.toString("utf8"),
  };
}
