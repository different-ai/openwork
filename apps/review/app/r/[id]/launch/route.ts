// Explicit extension: node --test loads this route without Next's resolver.
import { after } from "next/server.js";
import { readReview } from "@openwork/review/storage";
import { launchHandlers } from "../../../../lib/launch.ts";
import { selectedReviewProvider } from "../../../../lib/providers.ts";
import { previewProviderOptions } from "../../../../lib/provider-status.ts";

export const runtime = "nodejs";
// A first build of a commit runs after the response, within this budget.
export const maxDuration = 800;
export const dynamic = "force-dynamic";

const handlers = launchHandlers({
  readReview,
  provider: selectedReviewProvider,
  options: previewProviderOptions,
  schedule: (task) => after(task),
});

export const POST = handlers.POST;
export const GET = handlers.GET;
