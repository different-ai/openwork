import os from "node:os";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { head, put } from "@vercel/blob";
import { ulid } from "ulid";

import type { FetchBundleResult, StoreBundleResult } from "./types.ts";

function resolveLocalBlobDir(): string | null {
  const explicitDir = String(process.env.LOCAL_BLOB_DIR ?? "").trim();
  if (explicitDir) {
    return explicitDir;
  }

  if (String(process.env.BLOB_READ_WRITE_TOKEN ?? "").trim()) {
    return null;
  }

  const isDevLike =
    String(process.env.OPENWORK_DEV_MODE ?? "") === "1" ||
    String(process.env.NODE_ENV ?? "").trim() !== "production";

  if (!isDevLike) {
    return null;
  }

  return path.join(os.tmpdir(), "openwork-share-blobs");
}

function resolveBundlePathname(id: string): string {
  return `bundles/${id}.json`;
}

async function storeBundleJsonLocally(rawJson: string): Promise<StoreBundleResult> {
  const id = ulid();
  const pathname = resolveBundlePathname(id);
  const localBlobDir = resolveLocalBlobDir();

  if (!localBlobDir) {
    throw new Error("Local blob storage is not configured");
  }

  const targetPath = path.join(localBlobDir, pathname);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, Buffer.from(String(rawJson), "utf8"));

  return { id, pathname };
}

async function fetchBundleJsonLocally(id: string): Promise<FetchBundleResult> {
  const pathname = resolveBundlePathname(id);
  const localBlobDir = resolveLocalBlobDir();

  if (!localBlobDir) {
    throw new Error("Local blob storage is not configured");
  }

  const targetPath = path.join(localBlobDir, pathname);
  const rawBuffer = await readFile(targetPath);
  return {
    blob: {
      url: `file://${targetPath}`,
      contentType: "application/json",
    },
    rawBuffer,
    rawJson: rawBuffer.toString("utf8"),
  };
}

export async function storeBundleJson(rawJson: string): Promise<StoreBundleResult> {
  if (resolveLocalBlobDir()) {
    return storeBundleJsonLocally(rawJson);
  }

  const id = ulid();
  const pathname = resolveBundlePathname(id);
  const buffer = Buffer.from(String(rawJson), "utf8");

  await put(pathname, buffer, {
    access: "public",
    contentType: "application/json",
    addRandomSuffix: false,
  });

  return { id, pathname };
}

export async function fetchBundleJsonById(id: string): Promise<FetchBundleResult> {
  if (resolveLocalBlobDir()) {
    return fetchBundleJsonLocally(id);
  }

  const pathname = resolveBundlePathname(id);
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
