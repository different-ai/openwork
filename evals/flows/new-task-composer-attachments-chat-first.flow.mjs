/**
 * The other half of the new-task attachment fix: the New Task composer also
 * renders when **no workspace exists at all** (chat-first onboarding —
 * `showWorkspaceSetupEmptyState` is `workspaces.length === 0`). This flow
 * proves a file can be attached in that state and survives the workspace +
 * session creation that Run task performs.
 *
 * Scope note: the "first message actually sent" half of chat-first is covered
 * by `new-task-composer-attachments` (workspace-selected hero), which drives
 * the same seeding + auto-send + upload path end to end. Chat-first creates
 * the workspace on the fly, so its engine cannot be pointed at a mock provider
 * beforehand; this flow therefore stops at the handoff it can observe
 * deterministically.
 *
 * Requires a genuinely fresh desktop profile (no chat workspace folder yet).
 * Required env:
 * - OPENWORK_EVAL_DAYTONA_SANDBOX  Daytona sandbox running the Electron app.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "new-task-composer-attachments-chat-first";
const FILENAME = "quarterly-costs.csv";
const CSV_SOURCE = [
  "month,team,cost",
  "2026-01,Platform,12400",
  "2026-02,Platform,11875",
  "2026-03,Platform,13210",
  "",
].join("\n");
const PROMPT = "Summarize the attached quarterly costs spreadsheet.";
const EXPECTED_BYTES = Buffer.from(CSV_SOURCE, "utf8");
const EXPECTED_SHA256 = createHash("sha256").update(EXPECTED_BYTES).digest("hex");
const MOCK_PORT = 18093;
const PROVIDER_ID = "new-task-attachments-mock";
const MODEL_ID = "new-task-attachment-mock";
const ASSISTANT_SENTINEL = "Quarterly costs received";
const OLD_BLOCK_MESSAGE = "Attachments become available once the task starts.";

// Fixed by the Daytona devcontainer profile; the desktop "home" the chat-first
// path writes into lives under the dev data dir, not $HOME.
const DEV_PROFILE_DIR = "/home/daytona/.config/com.differentai.openwork.dev";
const DEV_HOME = `${DEV_PROFILE_DIR}/openwork-dev-data/home`;
const CHAT_WORKSPACE_PATH = `${DEV_HOME}/OpenWork Chat`;

const vo = await loadVoiceoverParagraphs(FLOW_ID);
const execFileAsync = promisify(execFile);

function assertEvidence(ctx, condition, assertion, actual) {
  ctx.recordEvidence({
    type: "assertion",
    status: condition ? "passed" : "failed",
    assertion,
    actual,
  });
  ctx.assert(condition, `${assertion}${actual ? ` (actual: ${String(actual).slice(0, 400)})` : ""}`);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function daytonaBash(ctx, script, timeout = 90_000) {
  const sandbox = ctx.env.OPENWORK_EVAL_DAYTONA_SANDBOX.trim();
  const encoded = Buffer.from(script, "utf8").toString("base64");
  try {
    return await execFileAsync(
      "daytona",
      ["exec", sandbox, "--", "echo", encoded, "|", "base64", "-d", "|", "bash"],
      { timeout, maxBuffer: 1024 * 1024 },
    );
  } catch (error) {
    const stdout = error && typeof error === "object" && "stdout" in error ? error.stdout : "";
    const stderr = error && typeof error === "object" && "stderr" in error ? error.stderr : "";
    throw new Error(`daytona exec failed: ${errorMessage(error)} stdout=${String(stdout ?? "").slice(0, 400)} stderr=${String(stderr ?? "").slice(0, 400)}`);
  }
}

/**
 * The workspace registry is owned by the running in-process server, so a true
 * zero-workspace state cannot be forced by editing state files underneath it.
 * This flow requires a fresh profile instead and fails loudly otherwise.
 */
async function requireSeededMockProvider(ctx) {
  const script = `set -euo pipefail
curl -sf http://127.0.0.1:${MOCK_PORT}/v1/models >/dev/null && echo mock-ready
grep -q ${JSON.stringify(PROVIDER_ID)} ${JSON.stringify(`${CHAT_WORKSPACE_PATH}/opencode.jsonc`)} && echo provider-seeded
`;
  const result = await daytonaBash(ctx, script, 30_000);
  ctx.assert(result.stdout.includes("mock-ready"), `Mock provider is not listening on ${MOCK_PORT}: ${result.stdout} ${result.stderr}`);
  ctx.assert(
    result.stdout.includes("provider-seeded"),
    `Harness setup missing: ${CHAT_WORKSPACE_PATH}/opencode.jsonc must pre-declare the mock provider (the workspace does not exist until Run task, so its engine cannot be configured later). Wipe ${DEV_PROFILE_DIR}, seed that file, and restart Electron.`,
  );
}

async function loadZeroWorkspaceProfile(ctx) {
  await ctx.eval(`(() => {
    const raw = localStorage.getItem("openwork.preferences");
    let prefs = {};
    try {
      prefs = raw ? JSON.parse(raw) : {};
    } catch {
      prefs = {};
    }
    if (!prefs || typeof prefs !== "object" || Array.isArray(prefs)) prefs = {};
    // Skip the welcome redirect so we land on the chat-first hero with no
    // workspace, which is exactly the state under test.
    localStorage.setItem("openwork.preferences", JSON.stringify({
      ...prefs,
      hasCompletedOnboarding: true,
      defaultModel: { providerID: ${JSON.stringify(PROVIDER_ID)}, modelID: ${JSON.stringify(MODEL_ID)} },
      modelVariant: null,
      providerStepCompleted: true,
    }));
    localStorage.setItem("openwork.defaultModel", ${JSON.stringify(`${PROVIDER_ID}/${MODEL_ID}`)});
    localStorage.removeItem("openwork.react.activeWorkspace");
    location.hash = "#/session";
    location.reload();
    return true;
  })()`);
  await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 90_000, label: "control API after reload" });
  await ctx.waitFor(
    `(() => {
      const inspector = window.__openwork;
      if (!inspector) return null;
      const workspaces = inspector.slice("route").workspaces || [];
      if (workspaces.length !== 0) return null;
      return document.body.innerText.includes("What do you need done?") || null;
    })()`,
    { timeoutMs: 60_000, label: "chat-first hero with zero workspaces" },
  );
}

async function workspaceCount(ctx) {
  return await ctx.eval(`(window.__openwork.slice("route").workspaces || []).length`);
}

const MODEL_UPSELL_TITLE = "Start working without API keys";

/**
 * A fresh, signed-out profile pops the OpenWork Models upsell over the
 * transcript once the first session opens. Dismiss it so the frames show the
 * actual experience instead of an unrelated overlay.
 */
async function dismissOpenWorkModelsModal(ctx) {
  await ctx.eval(`(() => {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [data-slot="dialog-content"]'));
    const dialog = dialogs.find((item) => (item.textContent || "").includes(${JSON.stringify(MODEL_UPSELL_TITLE)}));
    if (!dialog) return false;
    const buttons = Array.from(dialog.querySelectorAll("button"));
    const keep = buttons.find((button) => (button.textContent || "").trim().includes("Continue with my own provider keys"));
    const close = buttons.find((button) => (button.getAttribute("aria-label") || "") === "Close");
    const target = keep || close;
    if (!target) return false;
    target.click();
    return true;
  })()`);
  await ctx.waitFor(
    `(() => {
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [data-slot="dialog-content"]'));
      return dialogs.some((item) => (item.textContent || "").includes(${JSON.stringify(MODEL_UPSELL_TITLE)})) ? null : true;
    })()`,
    { timeoutMs: 20_000, label: "OpenWork Models upsell dismissed" },
  );
}

async function typePromptIntoHeroComposer(ctx) {
  const result = await ctx.eval(`(() => {
    const editor = document.querySelector('[contenteditable="true"][data-lexical-editor="true"]');
    if (!editor) return { ok: false, reason: "hero composer editor not found" };
    editor.focus();
    const data = new DataTransfer();
    data.setData("text/plain", ${JSON.stringify(PROMPT)});
    editor.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
    return { ok: true };
  })()`);
  ctx.assert(result?.ok, result?.reason ?? "Failed to paste the prompt into the new-task composer.");
}

async function attachCsvThroughFileInput(ctx) {
  const result = await ctx.eval(`(() => {
    const input = document.querySelector('input[type="file"][multiple]');
    if (!(input instanceof HTMLInputElement)) return { ok: false, reason: "composer file input not found" };
    const transfer = new DataTransfer();
    transfer.items.add(new File([${JSON.stringify(CSV_SOURCE)}], ${JSON.stringify(FILENAME)}, { type: "text/csv", lastModified: 1767225600000 }));
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true };
  })()`);
  ctx.assert(result?.ok, result?.reason ?? "Failed to hand the CSV to the composer file input.");
}

const SEEDED_COMPOSER_STATE = `(() => {
  const editor = document.querySelector('[contenteditable="true"][data-lexical-editor="true"]');
  const text = editor ? String(editor.innerText || "") : "";
  const chip = Array.from(document.querySelectorAll("*")).some((node) => node.childElementCount === 0 && (node.textContent || "").trim() === ${JSON.stringify(FILENAME)});
  return { promptCarried: text.includes("quarterly costs"), chip, rawToken: text.includes("[attachment "), text: text.slice(0, 200) };
})()`;

export default {
  id: FLOW_ID,
  title: "New Task composer accepts attachments when no workspace exists yet",
  kind: "user-facing",
  requiredEnv: ["OPENWORK_EVAL_DAYTONA_SANDBOX"],
  precondition: async (ctx) => {
    await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000, label: "control API" });
    return null;
  },
  steps: [
    {
      name: "Land on the chat-first composer with no workspace",
      run: async (ctx) => {
        await requireSeededMockProvider(ctx);
        await loadZeroWorkspaceProfile(ctx);
        ctx.output("profile", JSON.stringify({ workspaces: await workspaceCount(ctx), chatWorkspacePath: CHAT_WORKSPACE_PATH }, null, 2));
      },
    },
    {
      name: "Attach a spreadsheet with no workspace at all",
      run: async (ctx) => {
        await ctx.prove("The New Task composer takes a file before any workspace exists", {
          voiceover: vo[0],
          action: async () => {
            await typePromptIntoHeroComposer(ctx);
            await attachCsvThroughFileInput(ctx);
          },
          assert: async () => {
            await ctx.waitForText(FILENAME, { timeoutMs: 10_000 });
            const count = await workspaceCount(ctx);
            assertEvidence(ctx, count === 0, "No workspace exists while the file sits in the composer", `workspaces=${count}`);
            const route = await ctx.eval(`String(window.__openworkControl.snapshot().route || "")`);
            assertEvidence(ctx, !String(route).includes("/workspace/"), "The route has no workspace yet", String(route));
            const state = await ctx.eval(`(() => {
              const buttons = Array.from(document.querySelectorAll("button"));
              const attach = buttons.find((button) => button.title === "Attach files");
              const run = buttons.find((button) => button.textContent.trim() === "Run task");
              return { attachFound: Boolean(attach), attachDisabled: attach ? attach.disabled : null, runDisabled: run ? run.disabled : null };
            })()`);
            assertEvidence(ctx, state?.attachFound === true && state?.attachDisabled === false, "The attach button is enabled with no workspace", JSON.stringify(state));
            assertEvidence(ctx, state?.runDisabled === false, "Run task is enabled with the attachment in place", JSON.stringify(state));
            const bodyText = await ctx.eval("document.body.innerText");
            assertEvidence(ctx, !String(bodyText).includes(OLD_BLOCK_MESSAGE), "The old 'attachments become available once the task starts' block is gone", OLD_BLOCK_MESSAGE);
          },
          screenshot: {
            name: "attached-with-no-workspace",
            requireText: [FILENAME, "What do you need done?"],
            rejectText: [OLD_BLOCK_MESSAGE],
          },
        });
      },
    },
    {
      name: "Run the task: the workspace is created and the file rides the first message",
      run: async (ctx) => {
        await ctx.prove("One press creates the workspace and sends the attachment with the first message", {
          voiceover: vo[1],
          action: async () => {
            const clicked = await ctx.eval(`(() => {
              const button = Array.from(document.querySelectorAll("button")).find((item) => item.textContent.trim() === "Run task" && !item.disabled);
              if (!button) return false;
              button.click();
              return true;
            })()`);
            ctx.assert(clicked === true, "Could not click Run task on the chat-first hero.");
            await ctx.waitFor(`String(window.__openworkControl.snapshot().route || "").includes("/session/ses_")`, { timeoutMs: 120_000, label: "session route after workspace creation" });
            await ctx.waitFor(`(() => {
              const messages = Array.from(document.querySelectorAll('[data-message-role="assistant"]'));
              return messages.some((message) => (message.innerText || "").includes(${JSON.stringify(ASSISTANT_SENTINEL)})) || null;
            })()`, { timeoutMs: 120_000, label: "assistant reply in the created session" });
            await dismissOpenWorkModelsModal(ctx);
          },
          assert: async () => {
            const count = await workspaceCount(ctx);
            assertEvidence(ctx, count === 1, "Running the task created exactly one workspace", `workspaces=${count}`);
            const route = await ctx.eval(`String(window.__openworkControl.snapshot().route || "")`);
            assertEvidence(ctx, route.includes("/workspace/ws_") && route.includes("/session/ses_"), "The route now points at the created workspace and session", route);
            const workspacePath = await ctx.eval(`(() => {
              const workspaces = window.__openwork.slice("route").workspaces || [];
              return workspaces[0] ? String(workspaces[0].path || "") : "";
            })()`);
            assertEvidence(ctx, workspacePath === CHAT_WORKSPACE_PATH, "The created workspace is the chat-first default folder", workspacePath);
            const sent = await ctx.eval(`(() => {
              const cards = Array.from(document.querySelectorAll("button[aria-label], a[aria-label]"))
                .map((node) => node.getAttribute("aria-label") || "")
                .filter((label) => label.includes(${JSON.stringify(FILENAME)}));
              return { userTurns: document.querySelectorAll('[data-message-role="user"]').length, cards };
            })()`);
            assertEvidence(ctx, sent?.userTurns >= 1, "A first user turn was sent in the created session", JSON.stringify(sent));
            assertEvidence(ctx, (sent?.cards ?? []).length >= 1, "The sent user turn shows the attachment card", JSON.stringify(sent));
            const transcript = await ctx.control("session.read_transcript", { count: 8 });
            const text = transcriptText(transcript);
            assertEvidence(ctx, text.includes(".opencode/openwork/inbox/chat-attachments/"), "The first turn exposes the new workspace's inbox path", text.slice(0, 600));
            assertEvidence(ctx, !text.includes("[attachment "), "No raw attachment token leaked into the message text", text.slice(0, 600));
            ctx.output("created workspace", workspacePath);
          },
          screenshot: {
            name: "workspace-created-with-attachment",
            requireText: [FILENAME, ASSISTANT_SENTINEL],
            rejectText: [MODEL_UPSELL_TITLE],
            hashIncludes: "/session/",
          },
        });
      },
    },
    {
      name: "Verify the bytes inside the freshly created workspace",
      run: async (ctx) => {
        await ctx.prove("The exact bytes landed in the inbox of the workspace Run task created", {
          voiceover: vo[2],
          action: async () => {
            const clicked = await ctx.eval(`(() => {
              const button = Array.from(document.querySelectorAll("button")).find((node) => /-quarterly-costs\\.csv$/.test((node.textContent || "").trim()));
              if (!button) return false;
              button.click();
              return true;
            })()`);
            ctx.assert(clicked === true, "Could not open the uploaded CSV from the FILES panel.");
            await ctx.waitForText(`${EXPECTED_BYTES.length} bytes`, { timeoutMs: 15_000 });
            await dismissOpenWorkModelsModal(ctx);
          },
          assert: async () => {
            const transcript = await ctx.control("session.read_transcript", { count: 8 });
            const text = transcriptText(transcript);
            const fileUrl = extractAttachmentFileUrl(text);
            assertEvidence(ctx, Boolean(fileUrl), "The first turn includes a file:// URL for the uploaded CSV", text.slice(0, 600));
            const filePath = fileURLToPath(fileUrl);
            assertEvidence(ctx, filePath.startsWith(`${CHAT_WORKSPACE_PATH}/`), "The uploaded file lives inside the workspace Run task created", filePath);
            const digest = await readSandboxFileDigest(ctx, filePath);
            assertEvidence(ctx, digest.bytes === EXPECTED_BYTES.length, "Uploaded CSV byte count matches the fixture", `${digest.bytes} bytes`);
            assertEvidence(ctx, digest.sha256 === EXPECTED_SHA256, "Uploaded CSV sha256 matches the fixture exactly", digest.sha256);
            ctx.output("created workspace inbox path", filePath);
          },
          screenshot: {
            name: "bytes-in-created-workspace",
            requireText: [FILENAME, `${EXPECTED_BYTES.length} bytes`],
            rejectText: [MODEL_UPSELL_TITLE],
          },
        });
      },
    },
  ],
};

function transcriptText(transcript) {
  return (transcript?.messages ?? []).map((message) => message?.text ?? "").join("\n\n");
}

function extractAttachmentFileUrl(text) {
  const match = text.match(/file:\/\/[^\s)]+quarterly-costs\.csv/);
  return match ? match[0] : "";
}

async function readSandboxFileDigest(ctx, filePath) {
  const pathBase64 = Buffer.from(filePath, "utf8").toString("base64");
  const script = `set -euo pipefail
node <<'NODE'
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const filePath = Buffer.from(${JSON.stringify(pathBase64)}, "base64").toString("utf8");
const bytes = readFileSync(filePath);
console.log(JSON.stringify({ bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }));
NODE
`;
  const result = await daytonaBash(ctx, script, 30_000);
  const line = result.stdout.split(/\r?\n/).map((entry) => entry.trim()).find((entry) => entry.startsWith("{"));
  if (!line) throw new Error(`No digest JSON returned: ${result.stdout}`);
  return JSON.parse(line);
}
