import type { PreviewWorld } from "@openwork/evidence-provider/review";

/** Cheap capability metadata: report rendering must not load sandbox builders. */
export const DAYTONA_PREVIEW_WORLDS: readonly PreviewWorld[] = ["app-web"];

/** The server has a Daytona credential. Kept apart from the client so pages can check it cheaply. */
export function daytonaConfigured(): boolean {
  return Boolean(process.env.DAYTONA_API_KEY?.trim());
}
