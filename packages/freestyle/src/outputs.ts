export interface PreviewOutput {
  value: string;
  secret?: boolean;
  group?: string;
  note?: string;
}
export type PreviewOutputs = Record<string, PreviewOutput>;

export function parsePreviewOutputs(input: unknown): PreviewOutputs {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("Invalid world outputs");
  const result: PreviewOutputs = {};
  for (const [key, entry] of Object.entries(input)) {
    if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(key) || typeof entry !== "object" || entry === null
      || !("value" in entry) || typeof entry.value !== "string") throw new Error("Invalid world output");
    const output: PreviewOutput = { value: entry.value };
    if ("secret" in entry) { if (typeof entry.secret !== "boolean") throw new Error("Invalid secret flag"); output.secret = entry.secret; }
    if ("group" in entry) { if (typeof entry.group !== "string") throw new Error("Invalid output group"); output.group = entry.group; }
    if ("note" in entry) { if (typeof entry.note !== "string") throw new Error("Invalid output note"); output.note = entry.note; }
    if (output.group === "Services" && !/^https:\/\/(?:ow|den|api|engine|gateway|desktop)-[a-f0-9]{32}\.(?:style\.dev|preview\.openwork\.software)\/__openwork_launch\?token=[A-Za-z0-9_-]+$/.test(output.value)) {
      throw new Error("Invalid private service link");
    }
    result[key] = output;
  }
  return result;
}
