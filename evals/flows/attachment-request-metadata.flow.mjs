import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "attachment-request-metadata";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TEST_PATH = join(ROOT, "apps", "app", "tests", "attachment-file-part.test.ts");
const vo = await loadVoiceoverParagraphs(FLOW_ID);

function witness(ctx, condition, assertion, actual = "") {
  ctx.recordEvidence({
    type: "assertion",
    status: condition ? "passed" : "failed",
    assertion,
    actual,
  });
  ctx.assert(condition, `${assertion}${actual ? ` (actual: ${actual})` : ""}`);
}

function runTests(pattern) {
  return spawnSync(
    "pnpm",
    ["--filter", "@openwork/app", "exec", "bun", "test", "tests/attachment-file-part.test.ts", "--test-name-pattern", pattern],
    { cwd: ROOT, encoding: "utf8", timeout: 60_000 },
  );
}

export default {
  id: FLOW_ID,
  title: "Attachment requests preserve authoritative filename, MIME type, and bytes",
  kind: "internal",
  requiresApp: false,
  steps: [
    {
      name: "A selected JPEG keeps its filename and MIME type",
      run: async (ctx) => {
        await ctx.prove("The attachment boundary recognizes PassaportoPaolo_small.jpg as image/jpeg", {
          voiceover: vo[0],
          assert: async () => {
            const run = runTests("preserves JPEG filename");
            witness(ctx, run.status === 0, "The focused JPEG metadata test passes", run.stderr.trim());
            const source = await readFile(TEST_PATH, "utf8");
            witness(ctx, source.includes('toBe("PassaportoPaolo_small.jpg")'), "The test asserts the original JPEG filename");
            witness(ctx, source.includes('toBe("image/jpeg")'), "The test asserts the image/jpeg MIME type");
            ctx.output("$ bun test — JPEG metadata", `${run.stdout.trim()}\n\n${source.split("\n").slice(31, 40).join("\n")}`);
          },
        });
      },
    },
    {
      name: "The provider-bound part carries JPEG bytes and cannot inherit stale PDF metadata",
      run: async (ctx) => {
        await ctx.prove("The provider-bound FilePartInput uses the underlying JPEG File as its source of truth", {
          voiceover: vo[1],
          assert: async () => {
            const run = runTests("stale ComposerAttachment PDF metadata");
            witness(ctx, run.status === 0, "The stale-PDF-metadata regression test passes", run.stderr.trim());
            const source = await readFile(TEST_PATH, "utf8");
            witness(ctx, source.includes('name: "PassaportoPaolo_small.pdf"'), "The fixture supplies stale PDF display metadata");
            witness(ctx, source.includes('expect(part.filename).toBe("PassaportoPaolo_small.jpg")'), "The outbound part still uses the JPEG filename");
            witness(ctx, source.includes('data:image/jpeg;base64,'), "The outbound part carries an image/jpeg data URL");
            witness(ctx, source.includes("decodedDataUrlBytes"), "The request-data test decodes and compares the transmitted bytes");
            ctx.output("$ bun test — provider-bound attachment part", `${run.stdout.trim()}\n\n${source.split("\n").slice(41, 53).join("\n")}`);
          },
        });
      },
    },
    {
      name: "The regression suite rejects JPEG-to-PDF metadata drift",
      run: async (ctx) => {
        await ctx.prove("Automated coverage locks filename, MIME, extension, and byte preservation together", {
          voiceover: vo[2],
          assert: async () => {
            const run = spawnSync(
              "pnpm",
              ["--filter", "@openwork/app", "exec", "bun", "test", "tests/attachment-file-part.test.ts", "tests/ollama-local-provider.test.ts"],
              { cwd: ROOT, encoding: "utf8", timeout: 60_000 },
            );
            const output = `${run.stdout}\n${run.stderr}`.trim();
            witness(ctx, run.status === 0, "The complete attachment and Ollama capability regression suite passes", run.stderr.trim());
            witness(ctx, output.includes("12 pass"), "All twelve focused regression tests pass", output);
            ctx.output("$ bun test — attachment request metadata suite", output);
          },
        });
      },
    },
  ],
};
