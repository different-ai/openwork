import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Place, Seed } from "@openwork/env";
import { startWorkshopFeedback, waitForWorkshopFeedbackForm } from "./workshop-feedback.ts";

/** Mechanism regression only: no seeded feedback, model response or paid inference. */
export async function workshopFeedbackUi(seed: Seed, { place }: { place: Place }) {
  if (place.kind !== "local") throw new Error("Owned feedback regression requires local headless Chrome.");
  const resources = new AsyncDisposableStack();
  const root = await realpath(await mkdtemp(join(tmpdir(), "openwork-feedback-ui-")));
  resources.defer(() => rm(root, { recursive: true, force: true }));
  try {
    const feedback = await startWorkshopFeedback(resources, root);
    const den = await seed.den({ provision: false, web: false });
    const web = await seed.web({ den, headless: true });
    return { web, url: feedback.feedbackUrl, read: feedback.read, waitForForm: () => waitForWorkshopFeedbackForm(web), async [Symbol.asyncDispose]() { await resources.disposeAsync(); } };
  } catch (error) { await resources.disposeAsync(); throw error; }
}
