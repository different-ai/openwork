import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "chat-attachment-workspace-path";
const FILENAME = "image-only scan.pdf";
const PROMPT = "Please inspect the attached scanned PDF. Use the provided worker file path when a tool needs the bytes.";
const IMAGE_ONLY_PDF_SOURCE = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>
endobj
4 0 obj
<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 7 >>
stream
FF0000>
endstream
endobj
5 0 obj
<< /Length 31 >>
stream
q 72 0 0 72 0 0 cm /Im0 Do Q
endstream
endobj
%%EOF
`;
const EXPECTED_BYTES = Buffer.from(IMAGE_ONLY_PDF_SOURCE, "utf8");
const EXPECTED_SHA256 = createHash("sha256").update(EXPECTED_BYTES).digest("hex");
const vo = await loadVoiceoverParagraphs(FLOW_ID);
const execFileAsync = promisify(execFile);

function assertEvidence(ctx, condition, assertion, actual) {
  ctx.recordEvidence({
    type: "assertion",
    status: condition ? "passed" : "failed",
    assertion,
    actual,
  });
  ctx.assert(condition, `${assertion}${actual ? ` (actual: ${actual})` : ""}`);
}

async function activeSessionId(ctx) {
  return ctx.waitFor(
    `(() => {
      const route = window.__openworkControl.snapshot().route || "";
      const match = route.match(/ses_[A-Za-z0-9]+/);
      return match ? match[0] : null;
    })()`,
    { timeoutMs: 30_000, label: "active session id" },
  );
}

async function pastePdfAttachment(ctx) {
  const result = await ctx.eval(`(() => {
    const editor = document.querySelector('[contenteditable="true"][data-lexical-editor="true"]')
      || document.querySelector('[contenteditable="true"]');
    if (!editor) return { ok: false, reason: "composer not found" };
    editor.focus();
    const file = new File([${JSON.stringify(IMAGE_ONLY_PDF_SOURCE)}], ${JSON.stringify(FILENAME)}, { type: "application/pdf" });
    const data = new DataTransfer();
    data.items.add(file);
    editor.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
    return { ok: true };
  })()`);
  ctx.assert(result?.ok, result?.reason ?? "Failed to paste PDF attachment into composer.");
}

function transcriptText(transcript) {
  return (transcript?.messages ?? [])
    .map((message) => message?.text ?? "")
    .join("\n\n");
}

function extractAttachmentFileUrl(text) {
  const match = text.match(/file:\/\/[^\s)]+image-only%20scan\.pdf/);
  return match ? match[0] : "";
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function readSandboxFileDigest(ctx, filePath) {
  const sandbox = ctx.env.OPENWORK_EVAL_DAYTONA_SANDBOX.trim();
  const pathBase64 = Buffer.from(filePath, "utf8").toString("base64");
  // The Daytona CLI builds a remote shell command after `--`, so keep the
  // filename out of that shell string. The only interpolated value below is a
  // base64 payload decoded inside Node before readFileSync opens the file.
  const script = `set -euo pipefail
node <<'NODE'
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const filePath = Buffer.from(${JSON.stringify(pathBase64)}, "base64").toString("utf8");
const bytes = readFileSync(filePath);
console.log(JSON.stringify({
  bytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
}));
NODE
`;
  const encodedScript = Buffer.from(script, "utf8").toString("base64");
  try {
    const result = await execFileAsync(
      "daytona",
      ["exec", sandbox, "--", "echo", encodedScript, "|", "base64", "-d", "|", "bash"],
      { timeout: 30_000, maxBuffer: 1024 * 1024 },
    );
    const line = result.stdout.split(/\r?\n/).map((entry) => entry.trim()).find((entry) => entry.startsWith("{"));
    if (!line) throw new Error(`No digest JSON returned: ${result.stdout}`);
    return JSON.parse(line);
  } catch (error) {
    const stdout = error && typeof error === "object" && "stdout" in error ? error.stdout : "";
    const stderr = error && typeof error === "object" && "stderr" in error ? error.stderr : "";
    throw new Error(`Daytona file digest failed: ${errorMessage(error)} stdout=${String(stdout ?? "").slice(0, 500)} stderr=${String(stderr ?? "").slice(0, 500)}`);
  }
}

export default {
  id: FLOW_ID,
  title: "Chat attachments are copied into the active worker workspace before send",
  kind: "user-facing",
  requiredEnv: ["OPENWORK_EVAL_DAYTONA_SANDBOX"],
  precondition: async (ctx) => {
    await ctx.waitFor("Boolean(window.__openworkControl)", {
      timeoutMs: 60_000,
      label: "control API",
    });
    const state = await ctx.waitFor(
      `(() => {
        const control = window.__openworkControl;
        const route = control.snapshot().route;
        if (route.startsWith("/welcome") || route.startsWith("/signin")) return "blocked";
        const action = control.listActions().find((item) => item.id === "session.create_task");
        if (action && !action.disabled) return "ready";
        return null;
      })()`,
      { timeoutMs: 30_000, label: "session.create_task enabled" },
    );
    return state === "blocked"
      ? "Profile is not onboarded (welcome/signin); chat attachment proof requires a workspace."
      : null;
  },
  steps: [
    {
      name: "Attach an image-only PDF through the composer",
      run: async (ctx) => {
        await ctx.prove("A normal chat attachment appears in the composer before sending", {
          voiceover: vo[0],
          action: async () => {
            await ctx.control("session.create_task");
            await activeSessionId(ctx);
            await pastePdfAttachment(ctx);
            await ctx.control("composer.set_text", { text: PROMPT });
          },
          assert: async () => {
            await ctx.waitForText(FILENAME, { timeoutMs: 10_000 });
            const composer = await ctx.eval("window.__openwork?.slice('composer')");
            const attached = (composer?.attachments ?? []).some((attachment) => attachment?.name === FILENAME && attachment?.mimeType === "application/pdf");
            assertEvidence(ctx, attached, "Composer inspector shows the PDF as an accepted attachment", JSON.stringify(composer?.attachments ?? []));
          },
          screenshot: { name: "pdf-attached", requireText: [FILENAME] },
        });
      },
    },
    {
      name: "Send the prompt and expose the worker inbox path",
      run: async (ctx) => {
        await ctx.prove("The submitted user turn includes the worker inbox path", {
          voiceover: vo[1],
          action: async () => {
            await ctx.control("composer.send");
          },
          assert: async () => {
            await ctx.waitForText(".opencode/openwork/inbox/chat-attachments/", { timeoutMs: 30_000 });
            const transcript = await ctx.control("session.read_transcript", { count: 5 });
            const text = transcriptText(transcript);
            assertEvidence(ctx, text.includes(".opencode/openwork/inbox/chat-attachments/"), "Transcript contains the workspace inbox path", text);
            assertEvidence(ctx, !text.includes("data:application/pdf"), "Transcript does not expose the PDF as a data URL fallback", text);
            ctx.output("submitted user turn", text);
          },
          screenshot: { name: "worker-path-in-turn", requireText: [".opencode/openwork/inbox/chat-attachments/", FILENAME] },
        });
      },
    },
    {
      name: "Read the uploaded PDF bytes from the worker path",
      run: async (ctx) => {
        await ctx.prove("The uploaded scan path is a real file path for tools such as Docling", {
          voiceover: vo[2],
          assert: async () => {
            const transcript = await ctx.control("session.read_transcript", { count: 5 });
            const text = transcriptText(transcript);
            const fileUrl = extractAttachmentFileUrl(text);
            assertEvidence(ctx, Boolean(fileUrl), "Submitted turn includes a file:// URL for the uploaded PDF", text);
            const filePath = fileURLToPath(fileUrl);
            assertEvidence(ctx, filePath.includes(".opencode/openwork/inbox/chat-attachments/"), "File path is inside the worker chat-attachments inbox", filePath);
            const digest = await readSandboxFileDigest(ctx, filePath);
            assertEvidence(ctx, digest.bytes === EXPECTED_BYTES.length, "Uploaded PDF byte count matches the image-only PDF fixture", `${digest.bytes} bytes`);
            assertEvidence(ctx, digest.sha256 === EXPECTED_SHA256, "Uploaded PDF sha256 matches the image-only PDF fixture exactly", digest.sha256);
            assertEvidence(ctx, !text.toLowerCase().includes("ocr complete"), "The prompt does not claim OpenWork performed native OCR", text);
            ctx.output("Docling-ready path", filePath);
          },
          screenshot: { name: "docling-ready-path", requireText: [FILENAME, "chat-attachments"] },
        });
      },
    },
  ],
};
