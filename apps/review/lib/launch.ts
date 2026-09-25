import { previewWorld, PreviewLaunchError, type PreviewSession, type PreviewWorld } from "@openwork/freestyle";

export interface LaunchDependencies {
  readReview(id: string): Promise<{ gitSha: string } | null>;
  /** Resolves when this commit already has a snapshot for the world. */
  hasSnapshot(gitSha: string, world: PreviewWorld): Promise<boolean>;
  launchPreview(input: { gitSha: string; reportId: string; world: PreviewWorld }): Promise<PreviewSession>;
  buildSnapshot(gitSha: string, world: PreviewWorld): Promise<unknown>;
  /** True while a builder VM for this commit/world is alive. */
  isBuilding(gitSha: string, world: PreviewWorld): Promise<boolean>;
  /** Runs work after the response has been sent (Next's `after`). */
  schedule(task: () => Promise<void>): void;
  connected(): boolean;
}

const headers = { "cache-control": "private, no-store" };
type Context = { params: Promise<{ id: string }> };

function sameOrigin(request: Request): boolean {
  const url = new URL(request.url);
  // Next's local server may normalize request.url to localhost even when the
  // browser requested 127.0.0.1. Host is the actual request authority.
  const authority = request.headers.get("host") ?? url.host;
  const protocol = request.headers.get("x-forwarded-proto") ?? url.protocol.slice(0, -1);
  return ["http", "https"].includes(protocol) && request.headers.get("origin") === `${protocol}://${authority}`;
}

/**
 * A launch never builds inside the request. A missing snapshot is built after the
 * response (bounded by the function's maxDuration) while the page polls GET; the
 * reviewer launches once it is ready. Builders share a provider-side lock, so a
 * second reviewer clicking during a build waits for the same snapshot.
 */
export function launchHandlers(deps: LaunchDependencies) {
  async function POST(request: Request, { params }: Context): Promise<Response> {
    // Vercel Authentication remains the hosted identity boundary. Require a same-origin
    // browser action so a third-party page cannot spend sandbox quota through that session.
    if (!sameOrigin(request)) return Response.json({ error: "Launch the sandbox from its review page." }, { status: 403, headers });
    if (!deps.connected()) return Response.json({ error: "Freestyle is not connected. The review app owner can configure it." }, { status: 503, headers });
    const { id } = await params;
    const report = await deps.readReview(id);
    if (!report) return Response.json({ error: "Review not found." }, { status: 404, headers });
    let world: PreviewWorld;
    try {
      const body: unknown = await request.text().then((text) => text ? JSON.parse(text) : {});
      world = previewWorld(typeof body === "object" && body !== null && "world" in body ? body.world : "app-web");
    } catch { return Response.json({ error: "Choose OpenWork web, Desktop only, or an ACME full-stack preview." }, { status: 400, headers }); }
    // The immutable stored report, never request input, chooses the source commit.
    const gitSha = report.gitSha;
    try {
      if (!await deps.hasSnapshot(gitSha, world)) {
        deps.schedule(async () => {
          const started = Date.now();
          try {
            await deps.buildSnapshot(gitSha, world);
            console.log("Freestyle preview built", { reportId: id, world, durationMs: Date.now() - started });
          } catch (error) {
            // Build errors come from the source-tree reader, the builder and the provider;
            // none carries an access link. Redact token-like values anyway.
            const reason = error instanceof Error ? error.message.replace(/(token|key|secret)=[^&\s]+/gi, "$1=[redacted]").slice(0, 300) : undefined;
            console.error("Freestyle preview build failed", { reportId: id, world, durationMs: Date.now() - started, error: error instanceof Error ? error.name : "UnknownError", reason });
          }
        });
        return Response.json({ state: "building" }, { status: 202, headers });
      }
      const started = Date.now();
      const preview = await deps.launchPreview({ gitSha, reportId: id, world });
      console.log("Freestyle review launch", { reportId: id, world, vmId: preview.id, durationMs: Date.now() - started });
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

  /** Read-only readiness for the page to poll while a first build runs. */
  async function GET(request: Request, { params }: Context): Promise<Response> {
    if (!deps.connected()) return Response.json({ error: "Freestyle is not connected." }, { status: 503, headers });
    const { id } = await params;
    const report = await deps.readReview(id);
    if (!report) return Response.json({ error: "Review not found." }, { status: 404, headers });
    let world: PreviewWorld;
    try { world = previewWorld(new URL(request.url).searchParams.get("world") ?? "app-web"); }
    catch { return Response.json({ error: "Unknown preview world." }, { status: 400, headers }); }
    try {
      const ready = await deps.hasSnapshot(report.gitSha, world);
      return Response.json({ ready, building: ready ? false : await deps.isBuilding(report.gitSha, world) }, { status: 200, headers });
    }
    catch { return Response.json({ error: "Freestyle could not be reached." }, { status: 502, headers }); }
  }

  return { POST, GET };
}
