import { readReview } from "@openwork/review/storage";
import { CheckpointCapacity, CheckpointUnavailable, forkEvidenceCheckpoint } from "@openwork/freestyle/checkpoints";

export const runtime = "nodejs";
export const maxDuration = 120;
export const dynamic = "force-dynamic";
const headers = { "cache-control": "private, no-store" };

export async function POST(request: Request, { params }: { params: Promise<{ id: string; evidenceId: string }> }) {
  const url = new URL(request.url);
  const authority = request.headers.get("host") ?? url.host;
  const protocol = request.headers.get("x-forwarded-proto") ?? url.protocol.slice(0, -1);
  if (!["http", "https"].includes(protocol) || request.headers.get("origin") !== `${protocol}://${authority}`)
    return Response.json({ error: "Open this checkpoint from its evidence page." }, { status: 403, headers });
  const { id, evidenceId } = await params;
  const report = await readReview(id);
  const image = report?.evidence.find((entry) => entry.id === evidenceId && entry.kind === "image");
  if (!report || !image || image.kind !== "image" || !image.checkpoint)
    return Response.json({ error: "No checkpoint was saved for this image." }, { status: 404, headers });
  if (Date.parse(image.checkpoint.expiresAt) <= Date.now())
    return Response.json({ error: "This checkpoint has expired. The screenshot is still available." }, { status: 410, headers });
  if (!process.env.FREESTYLE_API_KEY?.trim())
    return Response.json({ error: "Checkpoint access is not configured. Contact the review app owner." }, { status: 503, headers });
  let requestId: string;
  try {
    const text = await request.text();
    if (text.length > 200) throw new Error("Oversized request");
    const body: unknown = JSON.parse(text);
    if (typeof body !== "object" || body === null || !("requestId" in body) || typeof body.requestId !== "string"
      || !/^[a-f0-9-]{36}$/.test(body.requestId) || Object.keys(body).length !== 1) throw new Error("Invalid request");
    requestId = body.requestId;
  } catch { return Response.json({ error: "Reload this page and try again." }, { status: 400, headers }); }
  try {
    const fork = await forkEvidenceCheckpoint(image.checkpoint, id, requestId);
    // CDP cookie and provider identifiers are deliberately not returned to UI.
    return Response.json({ url: fork.url, expiresAt: fork.expiresAt }, { status: 201, headers });
  } catch (error) {
    if (error instanceof CheckpointUnavailable) return Response.json({ error: "This checkpoint is no longer available. The screenshot is still available." }, { status: 410, headers });
    if (error instanceof CheckpointCapacity) return Response.json({ error: "Three copies are already open. Try again after one expires." }, { status: 429, headers });
    console.error("Evidence checkpoint launch failed", { reportId: id, evidenceId });
    return Response.json({ error: "The checkpoint could not open. Try again." }, { status: 502, headers });
  }
}
