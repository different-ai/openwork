/**
 * Internal proof for storage-free Google Workspace file uploads.
 */
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "google-workspace-gmail-draft-attachments";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SERVER_ROOT = join(ROOT, "apps", "server");
const DEN_API_ROOT = join(ROOT, "ee", "apps", "den-api");
const SERVER_PATH = join(SERVER_ROOT, "src", "extensions", "cloud-uploads.ts");
const SERVER_TEST_PATH = join(SERVER_ROOT, "src", "extensions", "cloud-uploads.test.ts");
const ROUTE_PATH = join(DEN_API_ROOT, "src", "routes", "org", "google-workspace.ts");
const ROUTE_TEST_PATH = join(DEN_API_ROOT, "test", "google-workspace-capabilities.test.ts");
const vo = await loadVoiceoverParagraphs(FLOW_ID);

let serverTestRun;
let denTestRun;

function witness(ctx, condition, assertion, actual = "") {
  if (!condition) {
    ctx.recordEvidence({ type: "assertion", status: "failed", assertion, actual });
    ctx.assert(false, actual ? `${assertion} (actual: ${actual})` : assertion);
  }
  ctx.recordEvidence({ type: "assertion", status: "passed", assertion, actual });
}

function targetedTests() {
  serverTestRun ??= spawnSync("pnpm", ["exec", "bun", "test", "src/extensions/cloud-uploads.test.ts"], {
    cwd: SERVER_ROOT,
    encoding: "utf8",
    timeout: 120_000,
  });
  denTestRun ??= spawnSync("pnpm", ["exec", "bun", "test", "test/google-workspace-capabilities.test.ts"], {
    cwd: DEN_API_ROOT,
    encoding: "utf8",
    timeout: 120_000,
  });
  return [serverTestRun, denTestRun];
}

export default {
  id: FLOW_ID,
  title: "Google Workspace uploads carry workspace bytes outside model context without storage",
  kind: "internal",
  requiresApp: false,
  steps: [
    {
      name: "The agent sees paths rather than inline bytes",
      run: async (ctx) => {
        await ctx.prove("Drive and Gmail attachment actions accept authorized workspace paths and expose no upload base64 field", {
          voiceover: vo[0],
          assert: async () => {
            const server = await readFile(SERVER_PATH, "utf8");
            const route = await readFile(ROUTE_PATH, "utf8");
            witness(ctx, server.includes('action: "drive_upload_file"'), "Drive exposes a workspace-path upload action");
            witness(ctx, server.includes('action: "gmail_create_draft_with_attachments"'), "Gmail attachments reuse the direct upload transport");
            witness(ctx, !server.includes("dataBase64"), "The local upload action contains no inline byte field");
            witness(ctx, !route.includes("uploadDriveFileBodySchema"), "Den no longer advertises the legacy Drive JSON upload schema");
          },
        });
      },
    },
    {
      name: "Files cross the boundary only for the immediate operation",
      run: async (ctx) => {
        await ctx.prove("OpenWork posts multipart files directly to Den and Den immediately calls Google without persisting them", {
          voiceover: vo[1],
          assert: async () => {
            const server = await readFile(SERVER_PATH, "utf8");
            const route = await readFile(ROUTE_PATH, "utf8");
            witness(ctx, server.includes('form.append("file", new File([bytes], filename'), "The server creates multipart file parts from workspace bytes");
            witness(ctx, route.includes("/v1/direct-uploads/google-workspace/drive-files"), "Den exposes a non-capability direct Drive upload route");
            witness(ctx, route.includes("/v1/direct-uploads/google-workspace/gmail-drafts"), "Den exposes a non-capability direct Gmail attachment route");
            witness(ctx, !server.includes("fileRef") && !route.includes("FileReference"), "The upload path has no file-reference storage");
          },
        });
      },
    },
    {
      name: "Exact bytes and source metadata reach Google",
      run: async (ctx) => {
        await ctx.prove("Focused server and Den tests preserve Office bytes, filenames, MIME types, and Gmail attachment contents", {
          voiceover: vo[2],
          action: async () => {
            targetedTests();
          },
          assert: async () => {
            const runs = targetedTests();
            const serverTest = await readFile(SERVER_TEST_PATH, "utf8");
            const routeTest = await readFile(ROUTE_TEST_PATH, "utf8");
            witness(ctx, runs.every((run) => run.status === 0), "The focused storage-free upload suites pass", runs.map((run) => (run.stdout + run.stderr).trim()).join("\n\n"));
            witness(ctx, serverTest.includes("server-derived Office metadata"), "The local boundary verifies Office filename, MIME type, and bytes");
            witness(ctx, routeTest.includes("without model-facing base64"), "The Gmail boundary verifies exact bytes without upload base64");
            witness(ctx, routeTest.includes("preserves exact multipart bytes"), "The Drive boundary verifies exact multipart bytes");
          },
        });
      },
    },
  ],
};
