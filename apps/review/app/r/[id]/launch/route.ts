// Explicit extension: node --test loads this route without Next's resolver.
import { after } from "next/server.js";
import { readReview } from "@openwork/review/storage";
import { ensureSnapshot } from "@openwork/freestyle/builder";
import { buildProgress } from "@openwork/freestyle/progress";
import { findSnapshot, launchPreview } from "@openwork/freestyle";
import { launchHandlers } from "../../../../lib/launch.ts";

export const runtime = "nodejs";
// A first build of a commit runs after the response, within this budget.
export const maxDuration = 800;
export const dynamic = "force-dynamic";

const handlers = launchHandlers({
  readReview,
  hasSnapshot: async (gitSha, world) => Boolean(await findSnapshot(gitSha, undefined, world)),
  launchPreview: (input) => launchPreview(input),
  buildSnapshot: (gitSha, world) => ensureSnapshot(gitSha, undefined, (message) => console.log(message), world, {
    // The builder VM is deleted after a failure; keep the end of its log. Guests
    // never receive credentials, so the log holds no secrets.
    diagnostic: async (stage, log) => console.error("Freestyle preview builder log", { gitSha, world, stage, tail: log.split("\n").slice(-60).join("\n") }),
  }),
  buildProgress: (gitSha, world) => buildProgress(gitSha, world),
  schedule: (task) => after(task),
  connected: () => Boolean(process.env.FREESTYLE_API_KEY?.trim()),
});

export const POST = handlers.POST;
export const GET = handlers.GET;
