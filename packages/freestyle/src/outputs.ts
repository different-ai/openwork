import type { PreviewOutput, PreviewOutputs } from "@openwork/evidence-provider/review";
import type { EvidenceProviderId } from "@openwork/evidence-provider";

export type { PreviewOutput, PreviewOutputs };

export function parsePreviewOutputs(input: unknown, provider: EvidenceProviderId = "freestyle"): PreviewOutputs {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("Invalid world outputs");
  const result: PreviewOutputs = {};
  for (const [key, entry] of Object.entries(input)) {
    if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(key) || typeof entry !== "object" || entry === null
      || !("value" in entry) || typeof entry.value !== "string") throw new Error("Invalid world output");
    const output: PreviewOutput = { value: entry.value };
    if ("secret" in entry) { if (typeof entry.secret !== "boolean") throw new Error("Invalid secret flag"); output.secret = entry.secret; }
    if ("group" in entry) { if (typeof entry.group !== "string") throw new Error("Invalid output group"); output.group = entry.group; }
    if ("note" in entry) { if (typeof entry.note !== "string") throw new Error("Invalid output note"); output.note = entry.note; }
    const privateService = provider === "daytona"
      ? /^https:\/\/8080-[a-z0-9]+\.daytonaproxy\d{2}\.(?:net|eu)\/__openwork_launch\?token=[A-Za-z0-9_-]+$/
      : /^https:\/\/(?:ow|den|api|engine|gateway|desktop|workbot)-[a-f0-9]{32}\.(?:style\.dev|preview\.openwork\.software)\/__openwork_launch\?token=[A-Za-z0-9_-]+$/;
    if (output.group === "Services" && !privateService.test(output.value)) {
      throw new Error("Invalid private service link");
    }
    result[key] = output;
  }
  return result;
}
