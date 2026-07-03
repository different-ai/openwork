/**
 * Voice-over scripts as first-class artifacts.
 *
 * A flow's demo narration lives in `evals/voiceovers/<flow-id>.md`, written and
 * approved BEFORE the flow (or the feature) is coded. Frames are the numbered
 * paragraphs ("1. ..."); everything else (headings, prose) is context. Flows
 * load their narration from the script via `loadVoiceoverParagraphs`, and the
 * runner fails the flow when the narration it recorded drifts from the script.
 */
import { readFile, writeFile, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const RUNNER_DIR = dirname(fileURLToPath(import.meta.url));
export const VOICEOVERS_DIR = join(RUNNER_DIR, "..", "voiceovers");
export const FLOWS_DIR = join(RUNNER_DIR, "..", "flows");

export function voiceoverScriptPath(flowId) {
  return join(VOICEOVERS_DIR, `${flowId}.md`);
}

/** Frames are the numbered paragraphs: "1. narration...", possibly wrapped. */
export function parseVoiceoverScript(markdown) {
  const blocks = markdown
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);
  const paragraphs = [];
  for (const block of blocks) {
    const match = block.match(/^(\d+)[.)]\s+([\s\S]+)$/);
    if (!match) continue;
    paragraphs.push(match[2].replace(/\s+/g, " ").trim());
  }
  return paragraphs;
}

/** Returns the script's frame paragraphs, or null when no script exists. */
export async function loadVoiceoverParagraphs(flowId) {
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

const normalize = (value) => String(value).replace(/\s+/g, " ").trim();

/**
 * Drift check: every script paragraph must have been narrated by the run, and
 * the run must not narrate lines that are not in the approved script.
 */
export function checkVoiceoverCoverage(paragraphs, recordedVoiceovers) {
  const script = paragraphs.map(normalize);
  const recorded = recordedVoiceovers.filter(Boolean).map(normalize);
  const missing = script.filter((line) => !recorded.includes(line));
  const extra = recorded.filter((line) => !script.includes(line));
  return { ok: missing.length === 0 && extra.length === 0, missing, extra };
}

function flowStub(flowId, paragraphs) {
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
  return `import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

// Narration is loaded from the approved script (evals/voiceovers/${flowId}.md).
// The runner fails this flow if the narration drifts from that script.
const vo = await loadVoiceoverParagraphs(${JSON.stringify(flowId)});

export default {
  id: ${JSON.stringify(flowId)},
  title: "TODO: one-line claim — user can do X and sees Y",
  kind: "user-facing",
  steps: [
${steps}
  ],
};
`;
}

/** Generate evals/flows/<id>.flow.mjs from the approved voice-over script. */
export async function scaffoldFlow(flowId, { flowsDir = FLOWS_DIR, force = false } = {}) {
  const paragraphs = await loadVoiceoverParagraphs(flowId);
  if (!paragraphs) {
    throw new Error(
      `No voice-over script at ${voiceoverScriptPath(flowId)}. Write and approve the script first (see the voiceover skill).`,
    );
  }
  const flowPath = join(flowsDir, `${flowId}.flow.mjs`);
  if (!force) {
    const exists = await access(flowPath).then(() => true, () => false);
    if (exists) throw new Error(`${flowPath} already exists. Pass --force to overwrite.`);
  }
  await writeFile(flowPath, flowStub(flowId, paragraphs));
  return { flowPath, frames: paragraphs.length };
}
