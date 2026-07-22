/**
 * Voice-over scripts as first-class artifacts.
 *
 * A flow's demo narration lives in `evals/voiceovers/<flow-id>.md`, written and
 * approved BEFORE the flow (or the feature) is coded. Frames are the numbered
 * paragraphs ("1. ..."); everything else (headings, prose) is context. Flows
 * load their narration from the script via `loadVoiceoverParagraphs`, and the
 * runner fails the flow when the narration it recorded drifts from the script.
 */
import { access, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EvalMode } from "./flow.ts";

const RUNNER_DIR = dirname(fileURLToPath(import.meta.url));
export const VOICEOVERS_DIR = join(RUNNER_DIR, "..", "voiceovers");
export const FLOWS_DIR = join(RUNNER_DIR, "..", "flows");

function resolveVoiceoversDir(): string {
  return process.env.OPENWORK_EVAL_VOICEOVERS_DIR?.trim() || VOICEOVERS_DIR;
}

export function voiceoverScriptPath(flowId: string): string {
  return join(resolveVoiceoversDir(), `${flowId}.md`);
}

/** Frames are the numbered paragraphs: "1. narration...", possibly wrapped. */
export function parseVoiceoverScript(markdown: string): string[] {
  const blocks = markdown
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);
  const paragraphs: string[] = [];
  for (const block of blocks) {
    const match = block.match(/^(\d+)[.)]\s+([\s\S]+)$/);
    if (!match) continue;
    paragraphs.push(match[2].replace(/\s+/g, " ").trim());
  }
  return paragraphs;
}

/** Returns the script's frame paragraphs, or null when no script exists. */
export async function loadVoiceoverParagraphs(flowId: string): Promise<string[] | null> {
  const path = voiceoverScriptPath(flowId);
  try {
    await access(path);
  } catch {
    return null;
  }
  const markdown = await readFile(path, "utf8");
  const paragraphs = parseVoiceoverScript(markdown);
  if (paragraphs.length === 0) {
    throw new Error(`Voice-over script ${path} has no numbered frame paragraphs ("1. ...").`);
  }
  return paragraphs;
}

const normalize = (value: unknown) => String(value).replace(/\s+/g, " ").trim();

export interface VoiceoverCoverage {
  ok: boolean;
  missing: string[];
  extra: string[];
}

/**
 * Drift check: every script paragraph must have been narrated by the run, and
 * the run must not narrate lines that are not in the approved script.
 */
export function checkVoiceoverCoverage(paragraphs: string[], recordedVoiceovers: string[]): VoiceoverCoverage {
  const script = paragraphs.map(normalize);
  const recorded = recordedVoiceovers.filter(Boolean).map(normalize);
  const missing = script.filter((line) => !recorded.includes(line));
  const extra = recorded.filter((line) => !script.includes(line));
  return { ok: missing.length === 0 && extra.length === 0, missing, extra };
}

function narratedFlowStub(flowId: string, paragraphs: string[]): string {
  const steps = paragraphs
    .map(
      (paragraph, index) => `    {
      name: ${JSON.stringify(`Frame ${index + 1}`)},
      run: async (ctx) => {
        await ctx.prove(${JSON.stringify(`TODO: claim for frame ${index + 1}`)}, {
          voiceover: vo[${index}],
          // ${JSON.stringify(paragraph.slice(0, 76))}
          action: async () => {
            // TODO: drive the app as the end user (ctx.clickText, ctx.fill, ...)
          },
          assert: async () => {
            // TODO: witness the side effect (ctx.expectText, ctx.eval, ...)
            ctx.assert(false, "frame ${index + 1} not implemented yet");
          },
          screenshot: { name: ${JSON.stringify(`frame-${index + 1}`)}, requireText: [] },
        });
      },
    },`,
    )
    .join("\n");
  return `import { defineFlow } from "../runner/flow.ts";
import { loadVoiceoverParagraphs } from "../runner/voiceover.ts";

// Narration is loaded from the approved script (evals/voiceovers/${flowId}.md).
// The runner fails this flow if the narration drifts from that script.
const vo = await loadVoiceoverParagraphs(${JSON.stringify(flowId)});
if (!vo) throw new Error("Missing approved voice-over script for ${flowId}.");

export default defineFlow({
  id: ${JSON.stringify(flowId)},
  title: "TODO: one-line claim — user can do X and sees Y",
  kind: "user-facing",
  steps: [
${steps}
  ],
});
`;
}

function plainFlowStub(flowId: string): string {
  return `import { defineFlow } from "../runner/flow.ts";

export default defineFlow({
  id: ${JSON.stringify(flowId)},
  title: "TODO: one-line claim — user can do X and sees Y",
  kind: "internal",
  steps: [
    {
      name: "TODO: prove the automation claim",
      run: async (ctx) => {
        await ctx.prove("TODO: claim for this automation check", {
          action: async () => {
            // TODO: drive the system under test.
          },
          assert: async () => {
            // TODO: witness the side effect (ctx.expectText, ctx.eval, ctx.output, ...).
            ctx.assert(false, "automation flow not implemented yet");
          },
          screenshot: { name: "todo-frame", requireText: [] },
        });
      },
    },
  ],
});
`;
}

export interface ScaffoldOptions {
  flowsDir?: string;
  force?: boolean;
  mode?: EvalMode;
}

export interface ScaffoldResult {
  flowPath: string;
  frames: number;
  narrated: boolean;
}

/** Generate evals/flows/<id>.flow.ts from the approved voice-over script, or a plain automation stub in automation mode. */
export async function scaffoldFlow(flowId: string, { flowsDir = FLOWS_DIR, force = false, mode = "demo" }: ScaffoldOptions = {}): Promise<ScaffoldResult> {
  const paragraphs = await loadVoiceoverParagraphs(flowId);
  if (!paragraphs && mode === "demo") {
    throw new Error(
      `No voice-over script at ${voiceoverScriptPath(flowId)}. Write and approve the script first (see the voiceover skill).`,
    );
  }
  const flowPath = join(flowsDir, `${flowId}.flow.ts`);
  if (!force) {
    const exists = await access(flowPath).then(() => true, () => false);
    if (exists) throw new Error(`${flowPath} already exists. Pass --force to overwrite.`);
  }
  const source = paragraphs ? narratedFlowStub(flowId, paragraphs) : plainFlowStub(flowId);
  await writeFile(flowPath, source);
  return { flowPath, frames: paragraphs?.length ?? 1, narrated: Boolean(paragraphs) };
}
