/**
 * Internal proof for the Google Workspace Gmail-draft attachment capability.
 *
 * The user-facing surface is an agent capability rather than dedicated UI, so
 * the proof binds the discoverable tool contract to the MIME sent to the mock
 * Gmail API and the focused integration tests that exercise that boundary.
 */
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "google-workspace-gmail-draft-attachments";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEN_API_ROOT = join(ROOT, "ee", "apps", "den-api");
const ROUTE_PATH = join(ROOT, "ee", "apps", "den-api", "src", "routes", "org", "google-workspace.ts");
const MIME_PATH = join(ROOT, "ee", "apps", "den-api", "src", "capability-sources", "gmail.ts");
const ROUTE_TEST_PATH = join(ROOT, "ee", "apps", "den-api", "test", "google-workspace-capabilities.test.ts");
const MIME_TEST_PATH = join(ROOT, "ee", "apps", "den-api", "test", "gmail-draft.test.ts");
const vo = await loadVoiceoverParagraphs(FLOW_ID);

let testRun;

function witness(ctx, condition, assertion, actual = "") {
  if (!condition) {
    ctx.recordEvidence({ type: "assertion", status: "failed", assertion, actual });
    ctx.assert(false, actual ? `${assertion} (actual: ${actual})` : assertion);
  }
  ctx.recordEvidence({ type: "assertion", status: "passed", assertion, actual });
}

function snippet(source, anchor, lineCount) {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line.includes(anchor));
  if (start === -1) return `Missing snippet anchor: ${anchor}`;
  return lines.slice(start, start + lineCount).map((line, index) => `${start + index + 1}: ${line}`).join("\n");
}

async function sources() {
  const [route, mime, routeTest, mimeTest] = await Promise.all([
    readFile(ROUTE_PATH, "utf8"),
    readFile(MIME_PATH, "utf8"),
    readFile(ROUTE_TEST_PATH, "utf8"),
    readFile(MIME_TEST_PATH, "utf8"),
  ]);
  return { route, mime, routeTest, mimeTest };
}

function targetedTests() {
  testRun ??= spawnSync("pnpm", ["exec", "bun", "test", "test/gmail-draft.test.ts", "test/google-workspace-capabilities.test.ts"], {
    cwd: DEN_API_ROOT,
    encoding: "utf8",
    timeout: 120_000,
  });
  return testRun;
}

export default {
  id: FLOW_ID,
  title: "Google Workspace Gmail drafts accept bounded workspace-file attachments for new messages and threaded replies",
  kind: "internal",
  requiresApp: false,
  steps: [
    {
      name: "The agent can discover the workspace attachment contract",
      run: async (ctx) => {
        await ctx.prove("Capability search tells the agent exactly how to attach active-workspace file bytes", {
          voiceover: vo[0],
          assert: async () => {
            const { route } = await sources();
            witness(
              ctx,
              route.includes("body.attachments: [{ filename, mimeType, dataBase64 }]") ,
              "The searchable operation summary exposes the exact attachment body shape",
            );
            witness(ctx, route.includes("Read the file from the active workspace and base64-encode it"), "The data field directs the agent to the active workspace file");
            witness(ctx, route.includes("attachments: z.array(gmailDraftAttachmentSchema).min(1).max(10).optional()"), "The draft body accepts an optional bounded attachment list");
            ctx.output("discoverable Gmail-draft contract", [
              snippet(route, "const gmailDraftAttachmentSchema", 20),
              snippet(route, "summary: \"Create a Gmail draft", 5),
            ].join("\n\n"));
          },
        });
      },
    },
    {
      name: "Filename, MIME type, and bytes become a real attachment",
      run: async (ctx) => {
        await ctx.prove("The MIME builder preserves the requested filename and file type and carries the exact workspace bytes", {
          voiceover: vo[1],
          action: async () => {
            targetedTests();
          },
          assert: async () => {
            const { mime, mimeTest } = await sources();
            const run = targetedTests();
            witness(ctx, run.status === 0, "The focused Gmail MIME and capability tests pass", (run.stdout + run.stderr).trim().split("\n").slice(-8).join("\n"));
            witness(ctx, mime.includes('Content-Type: ${attachment.mimeType}; name="${encodeMimeParameter(attachment.filename)}"'), "The attachment MIME part uses the requested type and safe filename");
            witness(ctx, mime.includes('Content-Disposition: attachment; filename="${encodeMimeParameter(attachment.filename)}"'), "The part is explicitly marked as an attachment");
            witness(ctx, mime.includes("base64MimeContent(attachment.content)"), "The MIME part contains the supplied file bytes encoded as base64");
            witness(ctx, mimeTest.includes("encodes attachments as multipart MIME while preserving filename, MIME type, and bytes"), "A focused unit test decodes and checks the multipart draft");
            ctx.output("$ pnpm exec bun test Gmail attachment suites", (run.stdout + run.stderr).trim());
            ctx.output("multipart MIME builder", snippet(mime, "const message = attachments.length === 0", 38));
          },
        });
      },
    },
    {
      name: "Creating the draft confirms the attachment without sending",
      run: async (ctx) => {
        await ctx.prove("The capability calls Gmail drafts.create and returns recipient, subject, and attachment metadata", {
          voiceover: vo[2],
          assert: async () => {
            const { route, routeTest } = await sources();
            witness(ctx, route.includes('/gmail/v1/users/me/drafts'), "The Google request targets Gmail drafts.create, not a send endpoint");
            witness(ctx, !route.includes('/gmail/v1/users/me/messages/send'), "The capability contains no Gmail send call");
            witness(ctx, route.includes("attachments: attachments.map((attachment) => ({"), "The response confirms each attachment filename, MIME type, and byte size");
            witness(ctx, routeTest.includes("gmail plain draft attaches active workspace file bytes with filename and MIME type"), "The route integration test creates an attached plain draft");
            witness(ctx, routeTest.includes('to: "sam@acme.test"') && routeTest.includes('subject: "Quarterly plan"'), "The integration request includes the expected recipient and subject");
            ctx.output("draft creation and confirmation", snippet(route, "const message: { raw: string; threadId?: string }", 44));
          },
        });
      },
    },
    {
      name: "The mock Gmail receives a review-ready attached draft",
      run: async (ctx) => {
        await ctx.prove("The Gmail-side witness decodes a multipart draft with the exact attachment metadata and contents", {
          voiceover: vo[3],
          assert: async () => {
            const { routeTest } = await sources();
            witness(ctx, routeTest.includes('expect(decoded).toContain("Content-Type: multipart/mixed;")'), "The Gmail-bound raw message is multipart/mixed");
            witness(ctx, routeTest.includes('Content-Type: application/pdf; name="invoice-2026.pdf"'), "The Gmail-bound attachment keeps its PDF type and filename");
            witness(ctx, routeTest.includes('Content-Disposition: attachment; filename="invoice-2026.pdf"'), "The Gmail-bound message exposes the file as an attachment");
            witness(ctx, routeTest.includes('attachmentBytes.toString("base64")'), "The Gmail-bound MIME contains the exact workspace file bytes");
            witness(ctx, routeTest.includes('size: attachmentBytes.byteLength'), "The capability response reports the observed attachment byte size");
            ctx.output("mock Gmail external witness", snippet(routeTest, "test(\"gmail plain draft attaches active workspace file bytes", 42));
          },
        });
      },
    },
    {
      name: "Threaded reply drafts retain the same attachment",
      run: async (ctx) => {
        await ctx.prove("A threaded reply keeps Gmail reply headers, thread id, and the attached workspace file", {
          voiceover: vo[4],
          assert: async () => {
            const { routeTest } = await sources();
            witness(ctx, routeTest.includes('expect(message.threadId).toBe("thread_1")'), "The reply draft remains attached to the requested Gmail thread");
            witness(ctx, routeTest.includes('In-Reply-To: <orig-2@mail.gmail.com>'), "The reply draft retains In-Reply-To metadata");
            witness(ctx, routeTest.includes('References: <orig-1@mail.gmail.com> <orig-2@mail.gmail.com>'), "The reply draft retains References metadata");
            witness(ctx, routeTest.includes('filename: "notes.txt"'), "The threaded draft request includes the workspace attachment filename");
            witness(ctx, routeTest.includes('Content-Disposition: attachment; filename="notes.txt"'), "The threaded Gmail MIME includes the attachment");
            ctx.output("threaded reply attachment witness", snippet(routeTest, "test(\"gmail threaded reply draft reads thread metadata", 54));
          },
        });
      },
    },
  ],
};
