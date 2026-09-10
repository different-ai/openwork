import { readReview, readReviewAsset } from "@openwork/review/storage";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; name: string }> },
) {
  const { id, name } = await params;
  const report = await readReview(id);
  if (!report) return new Response("Report not found", { status: 404 });
  const allowed =
    name === "report.json" ||
    report.sources.some((source) => source.asset === name) ||
    report.evidence.some(
      (item) => item.kind === "image" && item.asset === name,
    );
  if (!allowed) return new Response("Evidence not found", { status: 404 });
  const response = await readReviewAsset(id, name);
  if (!response) return new Response("Evidence not found", { status: 404 });
  response.headers.set("cache-control", "private, no-store");
  response.headers.set("x-content-type-options", "nosniff");
  return response;
}
