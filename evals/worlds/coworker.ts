/**
 * Arrangement for the Open Coworker journeys.
 *
 * The specs observe the packaged app through `coworker()`. What they need
 * built beforehand — a standard MCP App page compiled the way OpenWork
 * Connect compiles one — is arranged here, so a spec never imports product
 * source and the boundary between witness and product stays visible.
 */
import type { GeneratedArtifactViewBuildInput } from "../../ee/apps/den-api/src/generated-artifact-view-builder.js";

export type StandardAppSource = GeneratedArtifactViewBuildInput;

/** The HTML of one standard MCP App view, compiled by the builder OpenWork Connect ships. */
export async function buildStandardAppHtml(source: StandardAppSource): Promise<string> {
  const builder = await import("../../ee/apps/den-api/src/generated-artifact-view-builder.js");
  const built = await builder.buildGeneratedArtifactViewInWorker(source);
  if (!built.ok) throw new Error(`Standard MCP App build failed: ${JSON.stringify(built.diagnostics)}`);
  return built.html;
}
