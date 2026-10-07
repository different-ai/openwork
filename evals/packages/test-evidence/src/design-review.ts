import { agentDesignNotes, renderDesignReview, reviewTestRunDesign, type DesignReviewFile } from "@openwork/design-review";
import { defaultVisionAsk, visionModel } from "./validate.ts";

export { agentDesignNotes, renderDesignReview };

/**
 * The design review with this machine's model key (OPENAI_API_KEY, then
 * ANTHROPIC_API_KEY): measured layout rules plus the rubric critique, or the
 * measured rules alone when no key is set or `vision` is false.
 */
export async function reviewDesign(testRunDir: string, options: { vision?: boolean; bypassCache?: boolean } = {}): Promise<DesignReviewFile> {
  const ask = options.vision === false ? null : defaultVisionAsk();
  return reviewTestRunDesign(testRunDir, {
    vision: ask ? { ask, model: visionModel() } : null,
    bypassCache: options.bypassCache,
  });
}
