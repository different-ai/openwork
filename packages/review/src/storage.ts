import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { get, put } from "@vercel/blob";
import { assetNameSchema, reportIdSchema, reviewSchema } from "./schema.ts";
import type { ReviewReport } from "./schema.ts";

export interface ReviewAsset {
  name: string;
  body: Uint8Array;
}

export async function uploadReview(
  report: ReviewReport,
  assets: ReviewAsset[],
  options: { localDir?: string } = {},
): Promise<string> {
  reviewSchema.parse(report);
  const names = new Set(
    assets.map((asset) => assetNameSchema.parse(asset.name)),
  );
  if (names.size !== assets.length || names.has("report.json"))
    throw new Error("Duplicate or reserved review asset name.");
  const referenced = [
    ...report.sources,
    ...report.evidence.filter((item) => item.kind === "image"),
  ];
  if (referenced.some((item) => !names.has(item.asset)))
    throw new Error("A referenced review asset is missing.");
  const id = randomUUID().replaceAll("-", "");
  const localDir = options.localDir ?? process.env.OPENWORK_REVIEW_LOCAL_DIR;
  const signal = AbortSignal.timeout(60_000);
  if (localDir) await mkdir(join(localDir, id), { recursive: false });
  async function write(name: string, body: Uint8Array | string) {
    if (localDir) {
      await writeFile(join(localDir, id, name), body, { flag: "wx" });
    } else {
      await put(
        `reviews/${id}/${name}`,
        typeof body === "string" ? body : Buffer.from(body),
        {
          access: "private",
          addRandomSuffix: false,
          allowOverwrite: false,
          contentType: name.endsWith(".png") ? "image/png" : "application/json",
          abortSignal: signal,
        },
      );
    }
  }
  // Bound concurrency and commit the manifest last. A failed upload never gets a report URL.
  for (let index = 0; index < assets.length; index += 4) {
    await Promise.all(
      assets
        .slice(index, index + 4)
        .map((asset) => write(asset.name, asset.body)),
    );
  }
  await write("report.json", JSON.stringify(report));
  return id;
}

export async function readReviewAsset(
  id: string,
  name: string,
): Promise<Response | null> {
  if (
    !reportIdSchema.safeParse(id).success ||
    !assetNameSchema.safeParse(name).success
  )
    return null;
  const localDir = process.env.OPENWORK_REVIEW_LOCAL_DIR;
  const contentType = name.endsWith(".png") ? "image/png" : "application/json";
  if (localDir) {
    try {
      return new Response(await readFile(join(localDir, id, name)), {
        headers: { "content-type": contentType },
      });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return null;
      throw error;
    }
  }
  const result = await get(`reviews/${id}/${name}`, {
    access: "private",
    abortSignal: AbortSignal.timeout(15_000),
  });
  if (result?.statusCode !== 200) return null;
  return new Response(result.stream, {
    headers: { "content-type": contentType },
  });
}

export async function readReview(id: string): Promise<ReviewReport | null> {
  const response = await readReviewAsset(id, "report.json");
  if (!response) return null;
  return reviewSchema.parse(await response.json());
}
