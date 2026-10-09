import { evaluate, type Surface } from "@openwork/cdp";
import { captureFrame, currentTestEvidence, validate } from "@openwork/test-evidence";
import { expectVisualEvidence } from "@openwork/test-evidence/vitest";

const framesByRun = new Map<string, Map<string, { expectations: string[]; validation: Awaited<ReturnType<typeof validate>> }>>();

/** Preserve original pixels and capture-time URL for separately composed evidence.
 * Duplicate pixels share their original ambient validation, never a forged image.
 * No recorder is created or passed by the caller.
 */
export async function captureBrowserEvidence(surface: Surface, input: {
  caption: string;
  expectations: string[];
  redactUrl: (url: string) => string;
}) {
  const observedUrl = input.redactUrl(await evaluate(surface.client, () => location.href));
  const artifact = await captureFrame(surface);
  if (input.redactUrl(await evaluate(surface.client, () => location.href)) !== observedUrl) {
    throw new Error("URL changed during screenshot capture; refusing an inaccurate annotation.");
  }
  const ambient = currentTestEvidence();
  if (!ambient) throw new Error("Browser evidence requires an ambient testkit run.");
  let frames = framesByRun.get(ambient.dir);
  if (!frames) { frames = new Map(); framesByRun.set(ambient.dir, frames); }
  let recorded = frames.get(artifact.hash);
  if (recorded && JSON.stringify(recorded.expectations) !== JSON.stringify(input.expectations)) {
    throw new Error("Identical screenshot pixels must use identical visual expectations; refusing to reuse a different claim.");
  }
  if (!recorded) {
    ambient.recordScreenshot(artifact, { caption: input.caption });
    recorded = { expectations: input.expectations, validation: await validate(artifact, input.expectations) };
    frames.set(artifact.hash, recorded);
  }
  expectVisualEvidence(recorded.validation);
  return { artifact, observedUrl, sourceTestRunDir: ambient.dir, expectations: recorded.expectations };
}
