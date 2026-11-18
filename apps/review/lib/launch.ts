import { isEvidenceProvider, type EvidenceProviderId } from "@openwork/evidence-provider";
import { previewWorld, type PreviewWorld, type ReviewPreviewProvider } from "@openwork/evidence-provider/review";
import type { PreviewProviderOption } from "./preview-options.ts";

export interface LaunchDependencies {
  readReview(id: string): Promise<{ gitSha: string } | null>;
  provider(id?: EvidenceProviderId): ReviewPreviewProvider;
  /** Fresh server-side provider configuration and capabilities on every request/allocation. */
  options: () => Promise<readonly PreviewProviderOption[]>;
  schedule(task: () => Promise<void>): void;
}

const headers = { "cache-control": "private, no-store" };
type Context = { params: Promise<{ id: string }> };

function sameOrigin(request: Request): boolean {
  const url = new URL(request.url);
  const authority = request.headers.get("host") ?? url.host;
  const protocol = request.headers.get("x-forwarded-proto") ?? url.protocol.slice(0, -1);
  return ["http", "https"].includes(protocol) && request.headers.get("origin") === `${protocol}://${authority}`;
}

function requestedProvider(value: unknown): EvidenceProviderId | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isEvidenceProvider(value)) throw new Error("Unsupported sandbox provider");
  return value;
}

export function launchHandlers(deps: LaunchDependencies) {
  async function resolveProvider(requested?: EvidenceProviderId, world?: PreviewWorld): Promise<ReviewPreviewProvider | Response> {
    try {
      const choices = await deps.options();
      const choice = choices && (requested ? choices.find((option) => option.id === requested)
        : choices.find((option) => option.connected) ?? choices[0]);
      if (choices && !choice?.connected) return Response.json({ error: choice?.reason ?? "Sandbox launches are unavailable. The review app owner can configure a provider." }, { status: 503, headers });
      if (choice && world && !choice.worlds.includes(world)) return Response.json({ error: `${choice.label} does not support this preview world. Choose an available world.` }, { status: 400, headers });
      const provider = deps.provider(choice?.id ?? requested);
      if ((requested && provider.id !== requested) || !provider.configured() || !provider.supportsPreviews) {
        return Response.json({ error: `${provider.label} is not connected. The review app owner can configure it.` }, { status: 503, headers });
      }
      return provider;
    } catch {
      return Response.json({ error: "Sandbox launches could not be authorized. Reload or ask the review app owner to check configuration." }, { status: 503, headers });
    }
  }

  async function POST(request: Request, { params }: Context): Promise<Response> {
    // Vercel Authentication is unchanged. Cross-site requests cannot spend sandbox quota.
    if (!sameOrigin(request)) return Response.json({ error: "Launch the sandbox from its review page." }, { status: 403, headers });
    let world: PreviewWorld;
    let requested: EvidenceProviderId | undefined;
    try {
      const body: unknown = await request.text().then((text) => text ? JSON.parse(text) : {});
      world = previewWorld(typeof body === "object" && body !== null && "world" in body ? body.world : "app-web");
      requested = requestedProvider(typeof body === "object" && body !== null && "provider" in body ? body.provider : undefined);
    } catch { return Response.json({ error: "Choose an available sandbox provider and preview world." }, { status: 400, headers }); }
    const { id } = await params;
    const report = await deps.readReview(id);
    if (!report) return Response.json({ error: "Review not found." }, { status: 404, headers });
    if (!/^[a-f0-9]{40}$/.test(report.gitSha)) return Response.json({ error: "This report has no launchable source commit." }, { status: 409, headers });
    let provider = await resolveProvider(requested, world);
    if (provider instanceof Response) return provider;
    const providerId = provider.id;
    // Neither the source revision nor the report association is accepted from browser input.
    const gitSha = report.gitSha;
    try {
      if (!await provider.hasSnapshot(gitSha, world)) {
        deps.schedule(async () => {
          const current = await resolveProvider(providerId, world);
          if (current instanceof Response) return; // provider configuration was removed: do not allocate a builder
          const started = Date.now();
          try {
            await current.buildSnapshot(gitSha, world);
            console.log(`${current.label} preview built`, { reportId: id, world, durationMs: Date.now() - started });
          } catch (error) {
            console.error("Review preview build failed", { reportId: id, world, provider: providerId, error: error instanceof Error ? error.name : "UnknownError" });
          }
        });
        return Response.json({ state: "building", provider: providerId }, { status: 202, headers });
      }
      // Recheck configuration immediately before spend; existing access expires independently.
      provider = await resolveProvider(providerId, world);
      if (provider instanceof Response) return provider;
      const preview = await provider.launchPreview({ gitSha, reportId: id, world });
      if (preview.gitSha !== gitSha || preview.world !== world) throw new Error("Preview source mismatch");
      return Response.json({ ...preview, provider: providerId }, { status: 201, headers });
    } catch (error) {
      console.error("Review preview launch failed", { reportId: id, world, provider: providerId, error: error instanceof Error ? error.name : "UnknownError",
        ...(provider instanceof Response ? {} : provider.launchFailureDetails(error)) });
      return Response.json({ error: "The sandbox could not launch. Try again; if it continues, ask the review app owner to check the provider." }, { status: 502, headers });
    }
  }

  async function GET(request: Request, { params }: Context): Promise<Response> {
    let world: PreviewWorld;
    let requested: EvidenceProviderId | undefined;
    try {
      const url = new URL(request.url);
      world = previewWorld(url.searchParams.get("world") ?? "app-web");
      requested = requestedProvider(url.searchParams.get("provider"));
    } catch { return Response.json({ error: "Unknown sandbox provider or preview world." }, { status: 400, headers }); }
    const provider = await resolveProvider(requested, world);
    if (provider instanceof Response) return provider;
    const { id } = await params;
    const report = await deps.readReview(id);
    if (!report) return Response.json({ error: "Review not found." }, { status: 404, headers });
    try {
      if (await provider.hasSnapshot(report.gitSha, world)) return Response.json({ ready: true, building: false, provider: provider.id }, { status: 200, headers });
      const progress = await provider.buildProgress(report.gitSha, world);
      return Response.json({ ready: false, building: progress.building, progress, provider: provider.id }, { status: 200, headers });
    } catch { return Response.json({ error: "The sandbox provider could not be reached. Try again." }, { status: 502, headers }); }
  }

  return { POST, GET };
}
