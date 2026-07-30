import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineFlow, type FlowContext, type FrameEvidenceInput, type FrameValidation } from "../runner/flow.ts";
import { loadVoiceoverParagraphs } from "../runner/voiceover.ts";

const FLOW_ID = "pretty-screenshot";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FLOW_CONTRACT_PATH = join(ROOT, "evals", "runner", "flow.ts");
const PRETTY_SOURCE_PATH = join(ROOT, "evals", "runner", "pretty.ts");
const PLAIN_FRAME = "plain-settings";
const PRETTY_FRAME = "pretty-frame";
const STABLE_APP_TEXT = "Settings";

const vo = await loadVoiceoverParagraphs(FLOW_ID);
if (!vo) throw new Error(`Missing approved voice-over script for ${FLOW_ID}.`);

function witness(ctx: FlowContext, condition: unknown, assertion: string, actual?: string): void {
  if (!condition) {
    ctx.recordEvidence({ type: "assertion", status: "failed", assertion, actual });
    ctx.assert(false, assertion + (actual ? ` (actual: ${actual})` : ""));
  }
  ctx.recordEvidence({ type: "assertion", status: "passed", assertion, actual });
}

function interfaceExcerpt(source: string, name: string): string {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line.includes(`export interface ${name}`));
  if (start < 0) return "";
  const selected: string[] = [];
  for (let index = start; index < lines.length; index += 1) {
    selected.push(`${index + 1}: ${lines[index]}`);
    if (index > start && lines[index].trim() === "}") break;
  }
  return selected.join("\n");
}

function matchingLines(source: string, pattern: RegExp): string[] {
  const matches: string[] = [];
  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (pattern.test(line)) matches.push(`${index + 1}: ${line}`);
  }
  return matches;
}

function frameByName(ctx: FlowContext, name: string): FrameEvidenceInput {
  const frame = ctx.evidenceFrames.find((item) => item.name === name);
  if (!frame) {
    witness(ctx, false, `Recorded frame evidence includes ${name}`, ctx.evidenceFrames.map((item) => item.name).join(", "));
    throw new Error(`Missing frame evidence: ${name}`);
  }
  return frame;
}

function validationByLabel(ctx: FlowContext, frame: FrameEvidenceInput, label: string): FrameValidation {
  const validation = frame.validations.find((item) => item.label === label);
  if (!validation) {
    witness(ctx, false, `Frame ${frame.name} includes validation ${JSON.stringify(label)}`, validationSummary(frame, [label]));
    throw new Error(`Missing validation: ${label}`);
  }
  return validation;
}

function validationSummary(frame: FrameEvidenceInput, labels: string[]): string {
  return labels
    .map((label) => {
      const validation = frame.validations.find((item) => item.label === label);
      const status = validation ? (validation.passed ? "passed" : "failed") : "missing";
      const detail = validation?.detail ? ` — ${validation.detail}` : "";
      return `${label}: ${status}${detail}`;
    })
    .join("\n");
}

function pngDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 24) return null;
  if (buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function parseInteger(value: string | undefined): number | null {
  if (typeof value !== "string") return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function prettyMetrics(ctx: FlowContext, frame: FrameEvidenceInput): { width: number; height: number; padding: number; radius: number } {
  const applied = validationByLabel(ctx, frame, "Pretty composite applied (mesh-gradient bg, rounded corners, shadow)");
  const detail = applied.detail ?? "";
  const match = detail.match(/^(\d+)x(\d+), pad (\d+)px, radius (\d+)px$/);
  witness(ctx, match !== null, "Pretty composite validation reports dimensions, padding, and radius", detail);
  if (!match) throw new Error(`Could not parse pretty composite detail: ${detail}`);
  const width = parseInteger(match[1]);
  const height = parseInteger(match[2]);
  const padding = parseInteger(match[3]);
  const radius = parseInteger(match[4]);
  witness(ctx, width !== null && height !== null && padding !== null && radius !== null, "Pretty composite metrics are numeric", detail);
  if (width === null || height === null || padding === null || radius === null) {
    throw new Error(`Pretty composite metrics were not numeric: ${detail}`);
  }
  return { width, height, padding, radius };
}

export default defineFlow({
  id: FLOW_ID,
  title: "Pretty screenshots: presentation-ready frames from the existing primitive",
  kind: "internal",
  requiresApp: true,
  steps: [
    {
      name: "One flag on the existing primitive",
      run: async (ctx) => {
        await ctx.prove("ScreenshotOptions exposes pretty without changing the screenshot pipeline contract", {
          voiceover: vo[0],
          action: async () => {
            await ctx.waitFor("Boolean(window.__openworkControl)", {
              timeoutMs: 30_000,
              label: "window.__openworkControl",
            });
            await ctx.waitFor("window.__openworkControl.listActions().some((action) => action.id === 'route.settings.general')", {
              label: "route.settings.general control action",
            });
            await ctx.control("route.settings.general");
          },
          assert: async () => {
            // Settings routes are workspace-scoped on onboarded profiles
            // (/workspace/<id>/settings/general), so match the suffix.
            await ctx.expectHashIncludes("/settings/general");
            await ctx.expectText(STABLE_APP_TEXT);
            const source = await readFile(FLOW_CONTRACT_PATH, "utf8");
            const excerpt = interfaceExcerpt(source, "ScreenshotOptions");
            witness(ctx, source.includes("pretty?: boolean | PrettyOptions;"), "ScreenshotOptions includes the pretty option", excerpt);
            witness(ctx, source.includes("export type { PrettyOptions }"), "flow.ts re-exports PrettyOptions for flow authors", excerpt);
            ctx.output("ScreenshotOptions contract", excerpt);
          },
          screenshot: {
            name: PLAIN_FRAME,
            requireText: [STABLE_APP_TEXT],
            hashIncludes: "/settings/general",
          },
        });
      },
    },
    {
      name: "Plain vs pretty, same running app",
      run: async (ctx) => {
        await ctx.prove("The same screenshot primitive can write a pretty frame from the current app state", {
          voiceover: vo[1],
          action: async () => {
            // Duplicate detection hashes the raw app capture, so this pretty frame
            // moves to a sibling settings tab instead of repeating pixel-identical
            // app pixels from frame 1 and tripping the anti-duplicate guard.
            await ctx.waitFor("window.__openworkControl.listActions().some((action) => action.id === 'route.settings.appearance')", {
              label: "route.settings.appearance control action",
            });
            await ctx.control("route.settings.appearance");
          },
          assert: async () => {
            await ctx.expectHashIncludes("/settings/appearance");
            await ctx.expectText(STABLE_APP_TEXT);
          },
          screenshot: {
            name: PRETTY_FRAME,
            pretty: true,
            requireText: [STABLE_APP_TEXT],
            hashIncludes: "/settings/appearance",
          },
        });
      },
    },
    {
      name: "Rounded corners plus corner pixels",
      run: async (ctx) => {
        await ctx.prove("Pretty frame evidence proves the gradient corners and rounded clip with pixel checks", {
          voiceover: vo[2],
          assert: () => {
            const frame = frameByName(ctx, PRETTY_FRAME);
            const labels = [
              "Pretty: canvas corners show the gradient background",
              "Pretty: rounded corners clip the capture",
            ];
            for (const label of labels) {
              const validation = validationByLabel(ctx, frame, label);
              witness(ctx, validation.passed, `${label} passed`, validationSummary(frame, [label]));
            }
            ctx.output("Pretty corner validations", validationSummary(frame, labels));
          },
        });
      },
    },
    {
      name: "Drop shadow and grown canvas dimensions",
      run: async (ctx) => {
        await ctx.prove("Pretty frame evidence proves the shadow and exact padding growth", {
          voiceover: vo[3],
          assert: async () => {
            const plainFrame = frameByName(ctx, PLAIN_FRAME);
            const prettyFrame = frameByName(ctx, PRETTY_FRAME);
            const shadow = validationByLabel(ctx, prettyFrame, "Pretty: drop shadow darkens below the card");
            witness(ctx, shadow.passed, "Pretty shadow validation passed", validationSummary(prettyFrame, [shadow.label]));

            const metrics = prettyMetrics(ctx, prettyFrame);
            const plainDims = pngDimensions(await readFile(join(ctx.outDir, plainFrame.file)));
            const prettyDims = pngDimensions(await readFile(join(ctx.outDir, prettyFrame.file)));
            witness(ctx, plainDims !== null, "Plain PNG dimensions parsed from IHDR", plainFrame.file);
            witness(ctx, prettyDims !== null, "Pretty PNG dimensions parsed from IHDR", prettyFrame.file);
            if (!plainDims || !prettyDims) throw new Error("Could not parse PNG dimensions for pretty screenshot proof.");
            const expectedWidth = plainDims.width + metrics.padding * 2;
            const expectedHeight = plainDims.height + metrics.padding * 2;
            witness(ctx, prettyDims.width === expectedWidth, "Pretty PNG width is raw width plus 2*pad", `${prettyDims.width} === ${expectedWidth}`);
            witness(ctx, prettyDims.height === expectedHeight, "Pretty PNG height is raw height plus 2*pad", `${prettyDims.height} === ${expectedHeight}`);
            witness(ctx, prettyDims.width === metrics.width && prettyDims.height === metrics.height, "Pretty validation detail matches the written PNG", `${prettyDims.width}x${prettyDims.height}`);
            ctx.output(
              "Pretty dimensions",
              `plain ${plainDims.width}x${plainDims.height}\npretty ${prettyDims.width}x${prettyDims.height}\npad ${metrics.padding}px\nradius ${metrics.radius}px`,
            );
          },
        });
      },
    },
    {
      name: "Cross-OS by construction",
      run: async (ctx) => {
        await ctx.prove("Pretty compositing is implemented in Chromium with no platform branches", {
          voiceover: vo[4],
          action: async () => {
            // Leave the app as we found it: this flow parked it on Settings for
            // the frames above; later flows (e.g. core-flow) expect the session
            // surface to be reachable again.
            await ctx.control("route.session");
          },
          assert: async () => {
            const source = await readFile(PRETTY_SOURCE_PATH, "utf8");
            const forbidden = matchingLines(source, /\bprocess\.platform\b|\bos\.platform\b|\bdarwin\b|\bwin32\b|\bx11grab\b|\bscreencapture\b/);
            const roundRectLines = matchingLines(source, /\broundRect\b/);
            const toDataUrlLines = matchingLines(source, /\btoDataURL\b/);
            witness(ctx, forbidden.length === 0, "pretty.ts contains no platform branching tokens", forbidden.join("\n") || "no matches");
            witness(ctx, roundRectLines.length > 0, "pretty.ts uses Canvas2D.roundRect", roundRectLines.join("\n"));
            witness(ctx, toDataUrlLines.length > 0, "pretty.ts exports the composite through canvas.toDataURL", toDataUrlLines.join("\n"));
            ctx.output("Forbidden platform-token grep", forbidden.join("\n") || "(no forbidden platform tokens)");
            ctx.output("Browser-side compositing mechanism", [...roundRectLines, ...toDataUrlLines].join("\n"));
          },
        });
      },
    },
  ],
});
