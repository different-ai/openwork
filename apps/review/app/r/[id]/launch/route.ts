import { readReview } from "@openwork/review/storage";
import { ensureSnapshot } from "@openwork/freestyle/builder";
import { launchPreview, previewWorld, PreviewLaunchError } from "@openwork/freestyle";

export const runtime = "nodejs";
export const maxDuration = 800;
export const dynamic = "force-dynamic";

const headers = { "cache-control": "private, no-store" };

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  // Vercel Authentication remains the hosted identity boundary. Require a same-origin
  // browser action so a third-party page cannot spend sandbox quota through that session.
  const url = new URL(request.url);
  // Next's local server may normalize request.url to localhost even when the
  // browser requested 127.0.0.1. Host is the actual request authority.
  const authority = request.headers.get("host") ?? url.host;
  const protocol = request.headers.get("x-forwarded-proto") ?? url.protocol.slice(0, -1);
  if (!["http", "https"].includes(protocol) || request.headers.get("origin") !== `${protocol}://${authority}`) {
    return Response.json({ error: "Launch the sandbox from its review page." }, { status: 403, headers });
  }
  if (!process.env.FREESTYLE_API_KEY?.trim()) {
    return Response.json({ error: "Freestyle is not connected. The review app owner can configure it." }, { status: 503, headers });
  }
  const { id } = await params;
  const report = await readReview(id);
  if (!report) return Response.json({ error: "Review not found." }, { status: 404, headers });
  let world;
  try {
    const body: unknown = await request.text().then((text) => text ? JSON.parse(text) : {});
    world = previewWorld(typeof body === "object" && body !== null && "world" in body ? body.world : "app-web");
  } catch { return Response.json({ error: "Choose OpenWork web, Desktop only, or an ACME full-stack preview." }, { status: 400, headers }); }
  try {
    // The immutable stored report, never request input, chooses the source commit.
    await ensureSnapshot(report.gitSha, undefined, undefined, world);
    const preview = await launchPreview({ gitSha: report.gitSha, reportId: id, world });
    return Response.json(preview, { status: 201, headers });
  } catch (error) {
    // Do not serialize provider responses, logs, environment, or access links.
    console.error("Freestyle review launch failed", {
      reportId: id, world, error: error instanceof Error ? error.name : "UnknownError",
      ...(error instanceof PreviewLaunchError ? { stage: error.stage, vmId: error.vmId,
        // Only these locally constructed errors have messages safe for logs.
        reason: error.cause instanceof Error && /^(?:Public sandbox readiness failed \(HTTP |Freestyle guest command failed \()/.test(error.cause.message) ? error.cause.message : undefined,
      } : {}),
    });
    return Response.json({ error: "The sandbox could not launch. Try again; if it continues, ask the review app owner to check Freestyle." }, { status: 502, headers });
  }
}
