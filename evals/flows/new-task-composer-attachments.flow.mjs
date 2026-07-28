/**
 * User feedback (#new-task attachments): the attachment entry on the New Task
 * page was disabled until the first message created the session, so tasks
 * that need a file up front hit a circular dependency. This flow proves the
 * fix end-to-end: attach a spreadsheet on the empty new-task screen, run the
 * task, and witness the same file land in the worker workspace inbox and ride
 * the first message.
 *
 * Required env:
 * - OPENWORK_EVAL_DAYTONA_SANDBOX  Daytona sandbox running the Electron app
 *   (used to start the mock provider and hash the uploaded file bytes).
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "new-task-composer-attachments";
const FILENAME = "quarterly-costs.csv";
const CSV_SOURCE = [
  "month,team,cost",
  "2026-01,Platform,12400",
  "2026-02,Platform,11875",
  "2026-03,Platform,13210",
  "",
].join("\n");
const EXPECTED_BYTES = Buffer.from(CSV_SOURCE, "utf8");
const EXPECTED_SHA256 = createHash("sha256").update(EXPECTED_BYTES).digest("hex");
const PROMPT = "Summarize the attached quarterly costs spreadsheet.";
const OLD_BLOCK_MESSAGE = "Attachments become available once the task starts.";

const MOCK_PORT = 18093;
const PROVIDER_ID = "new-task-attachments-mock";
const MODEL_ID = "new-task-attachment-mock";
const MODEL_NAME = "New task attachment mock";
const ASSISTANT_SENTINEL = "Quarterly costs received";

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

async function daytonaBash(ctx, script, timeout = 60_000) {
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

// Minimal OpenAI-compatible endpoint inside the sandbox: list one model and
// stream one canned completion so the auto-sent first message completes
// deterministically without a real provider.
const MOCK_SERVER_SOURCE = `import http from "node:http";
const chunks = (text) => [
  { id: "chatcmpl-ntca", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
  { id: "chatcmpl-ntca", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
  { id: "chatcmpl-ntca", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
];
http.createServer((req, res) => {
  if (req.method === "GET" && req.url.startsWith("/v1/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: ${JSON.stringify(MODEL_ID)}, object: "model" }] }));
    return;
  }
  if (req.method === "POST" && (req.url === "/v1/chat/completions" || req.url === "/chat/completions")) {
    let body = "";
    req.on("data", (part) => { body += part; });
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      for (const chunk of chunks(${JSON.stringify(`${ASSISTANT_SENTINEL}: the workspace inbox copy of ${FILENAME} lists Platform team costs for 2026-01 through 2026-03.`)})) {
        res.write("data: " + JSON.stringify(chunk) + "\\n\\n");
      }
      res.write("data: [DONE]\\n\\n");
      res.end();
    });
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: "not found" } }));
}).listen(${MOCK_PORT}, "127.0.0.1");
console.log("ntca mock listening on ${MOCK_PORT}");
`;

async function startMockProvider(ctx) {
  const script = `set -euo pipefail
cat > /tmp/ntca-mock.mjs <<'MOCK'
${MOCK_SERVER_SOURCE}
MOCK
(pgrep -f "node /tmp/ntca-mock.mjs" >/dev/null && exit 0) || true
nohup node /tmp/ntca-mock.mjs > /tmp/ntca-mock.log 2>&1 < /dev/null &
for i in $(seq 1 20); do
  if curl -sf http://127.0.0.1:${MOCK_PORT}/v1/models >/dev/null; then echo mock-ready; exit 0; fi
  sleep 0.5
done
cat /tmp/ntca-mock.log >&2
exit 1
`;
  const result = await daytonaBash(ctx, script, 60_000);
  ctx.assert(result.stdout.includes("mock-ready"), `Mock provider did not become ready: ${result.stdout} ${result.stderr}`);
}

async function appRouteState(ctx) {
  return await ctx.eval(`(() => {
    const hash = location.hash;
    const control = window.__openworkControl;
    const snapshot = control && typeof control.snapshot === "function" ? control.snapshot() : null;
    const route = (snapshot && snapshot.route) || (hash.startsWith("#") ? hash.slice(1) : hash);
    const pathSegment = (value, segment) => {
      const marker = "/" + segment + "/";
      const text = String(value || "");
      const index = text.indexOf(marker);
      if (index < 0) return "";
      const rest = text.slice(index + marker.length);
      const end = rest.indexOf("/");
      return end < 0 ? rest : rest.slice(0, end);
    };
    const workspaceId = pathSegment(hash, "workspace") || localStorage.getItem("openwork.react.activeWorkspace") || "";
    const sessionId = pathSegment(hash, "session") || pathSegment(route, "session") || "";
    return { hash, route, workspaceId, sessionId };
  })()`);
}

async function serverJson(ctx, path, init = {}) {
  const method = init.method || "GET";
  const raw = await ctx.eval(`(async () => {
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token");
    if (!port || !token) return JSON.stringify({ ok: false, status: 0, text: "missing server port/token" });
    const response = await fetch("http://127.0.0.1:" + port + ${JSON.stringify(path)}, {
      method: ${JSON.stringify(method)},
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: ${init.body === undefined ? "undefined" : JSON.stringify(JSON.stringify(init.body))},
    });
    const text = await response.text();
    return JSON.stringify({ ok: response.ok, status: response.status, text });
  })()`, { awaitPromise: true });
  const result = JSON.parse(raw);
  ctx.assert(result.ok, `${method} ${path} failed: ${result.status} ${String(result.text).slice(0, 500)}`);
  return result.text ? JSON.parse(result.text) : null;
}

async function waitForControlReady(ctx) {
  await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 90_000, label: "control API" });
  await ctx.waitFor(
    `window.__openworkControl.listActions().some((item) => item.id === "session.create_task" && !item.disabled)`,
    { timeoutMs: 60_000, label: "session.create_task enabled" },
  );
}

async function configureMockProvider(ctx) {
  const state = await appRouteState(ctx);
  ctx.assert(Boolean(state.workspaceId), `Could not determine workspace id from ${state.hash}`);
  ctx.workspaceId = state.workspaceId;

  await serverJson(ctx, `/workspace/${encodeURIComponent(ctx.workspaceId)}/config`, {
    method: "PATCH",
    body: {
      opencode: {
        provider: {
          [PROVIDER_ID]: {
            npm: "@ai-sdk/openai-compatible",
            name: MODEL_NAME,
            options: { baseURL: `http://127.0.0.1:${MOCK_PORT}/v1`, apiKey: "sk-openwork-ntca-eval" },
            models: {
              [MODEL_ID]: {
                name: MODEL_NAME,
                attachment: true,
                modalities: { input: ["text", "image", "pdf"], output: ["text"] },
              },
            },
          },
        },
      },
    },
  });
  await serverJson(ctx, `/workspace/${encodeURIComponent(ctx.workspaceId)}/engine/reload`, { method: "POST" });
  await ctx.eval(`(() => {
    const prefsRaw = localStorage.getItem("openwork.preferences");
    let prefs = {};
    try {
      prefs = prefsRaw ? JSON.parse(prefsRaw) : {};
    } catch {
      prefs = {};
    }
    if (!prefs || typeof prefs !== "object" || Array.isArray(prefs)) prefs = {};
    localStorage.setItem("openwork.preferences", JSON.stringify({
      ...prefs,
      defaultModel: { providerID: ${JSON.stringify(PROVIDER_ID)}, modelID: ${JSON.stringify(MODEL_ID)} },
      modelVariant: null,
      providerStepCompleted: true,
    }));
    localStorage.setItem("openwork.defaultModel", ${JSON.stringify(`${PROVIDER_ID}/${MODEL_ID}`)});
    localStorage.removeItem("openwork.sessionModels." + ${JSON.stringify(ctx.workspaceId)});
    location.reload();
    return true;
  })()`);
  await waitForControlReady(ctx);
  ctx.output("mock provider", JSON.stringify({ provider: PROVIDER_ID, model: MODEL_ID, port: MOCK_PORT }, null, 2));
}

async function openNewTaskScreen(ctx) {
  const emptyRoute = await ctx.eval(`(() => {
    const route = String(window.__openworkControl.snapshot().route || "");
    const at = route.indexOf("/session/");
    return at === -1 ? "" : route.slice(0, at) + "/session";
  })()`);
  if (typeof emptyRoute === "string" && emptyRoute.length > 0) await ctx.navigateHash(emptyRoute);
  await ctx.waitForText("What do you need done?", { timeoutMs: 30_000 });
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
  ctx.assert(result?.ok, result?.reason ?? "Failed to paste prompt into the new-task composer.");
  await ctx.waitFor(`(() => {
    const editor = document.querySelector('[contenteditable="true"][data-lexical-editor="true"]');
    return Boolean(editor && String(editor.innerText || "").includes("quarterly costs"));
  })()`, { timeoutMs: 10_000, label: "prompt text visible in hero composer" });
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

function transcriptText(transcript) {
  return (transcript?.messages ?? [])
    .map((message) => message?.text ?? "")
    .join("\n\n");
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
console.log(JSON.stringify({
  bytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
}));
NODE
`;
  const result = await daytonaBash(ctx, script, 30_000);
  const line = result.stdout.split(/\r?\n/).map((entry) => entry.trim()).find((entry) => entry.startsWith("{"));
  if (!line) throw new Error(`No digest JSON returned: ${result.stdout}`);
  return JSON.parse(line);
}

export default {
  id: FLOW_ID,
  title: "New Task composer accepts attachments before the session exists",
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
      ? "Profile is not onboarded (welcome/signin); the new-task attachment proof requires a workspace."
      : null;
  },
  steps: [
    {
      name: "Point the workspace at the mock provider",
      run: async (ctx) => {
        await startMockProvider(ctx);
        await configureMockProvider(ctx);
      },
    },
    {
      name: "Attach a spreadsheet on the New Task screen",
      run: async (ctx) => {
        await ctx.prove("The New Task composer accepts a file before any session exists", {
          voiceover: vo[0],
          action: async () => {
            await openNewTaskScreen(ctx);
            await typePromptIntoHeroComposer(ctx);
            await attachCsvThroughFileInput(ctx);
          },
          assert: async () => {
            await ctx.waitForText(FILENAME, { timeoutMs: 10_000 });
            const route = await ctx.eval(`String(window.__openworkControl.snapshot().route || "")`);
            assertEvidence(ctx, !String(route).includes("/session/ses_"), "No session exists yet while the file sits in the composer", String(route));
            const attachState = await ctx.eval(`(() => {
              const buttons = Array.from(document.querySelectorAll("button"));
              const attach = buttons.find((button) => button.title === "Attach files");
              return {
                found: Boolean(attach),
                disabled: attach ? attach.disabled : null,
                title: attach ? attach.title : null,
              };
            })()`);
            assertEvidence(ctx, attachState?.found === true && attachState?.disabled === false, "The attach button on the New Task screen is enabled", JSON.stringify(attachState));
            const bodyText = await ctx.eval("document.body.innerText");
            assertEvidence(ctx, !String(bodyText).includes(OLD_BLOCK_MESSAGE), "The old 'attachments become available once the task starts' block is gone", OLD_BLOCK_MESSAGE);
          },
          screenshot: {
            name: "csv-attached-before-task",
            requireText: [FILENAME, "What do you need done?"],
            rejectText: [OLD_BLOCK_MESSAGE],
          },
        });
      },
    },
    {
      name: "Run the task and send the attachment with the first message",
      run: async (ctx) => {
        await ctx.prove("Run task creates the session and the first message carries the attachment", {
          voiceover: vo[1],
          action: async () => {
            const clicked = await ctx.eval(`(() => {
              const button = Array.from(document.querySelectorAll("button")).find((item) => item.textContent.trim() === "Run task" && !item.disabled);
              if (!button) return false;
              button.click();
              return true;
            })()`);
            ctx.assert(clicked === true, "Could not click the Run task button on the New Task screen.");
            await ctx.waitFor(`String(window.__openworkControl.snapshot().route || "").includes("/session/ses_")`, { timeoutMs: 60_000, label: "session route after run task" });
            // Scope to the transcript's assistant message: sidebar titles of
            // previous runs can also contain the sentinel.
            await ctx.waitFor(`(() => {
              const messages = Array.from(document.querySelectorAll('[data-message-role="assistant"]'));
              return messages.some((message) => (message.innerText || "").includes(${JSON.stringify(ASSISTANT_SENTINEL)})) || null;
            })()`, { timeoutMs: 120_000, label: "assistant reply with mock sentinel" });
          },
          assert: async () => {
            // Text-like attachments render an "Open … in default app" card in
            // the sent turn (images/office files render a Download card).
            const sentCard = await ctx.waitFor(`(() => {
              const nodes = Array.from(document.querySelectorAll("button[aria-label], a[aria-label]"));
              return nodes.some((node) => (node.getAttribute("aria-label") || "").includes(${JSON.stringify(FILENAME)})) || null;
            })()`, { timeoutMs: 30_000, label: "sent attachment card in transcript" });
            assertEvidence(ctx, sentCard === true, "The sent user turn shows the attachment card", String(sentCard));
            const transcript = await ctx.control("session.read_transcript", { count: 8 });
            const text = transcriptText(transcript);
            assertEvidence(ctx, text.includes(".opencode/openwork/inbox/chat-attachments/"), "The submitted turn exposes the worker inbox path", text.slice(0, 600));
            assertEvidence(ctx, text.includes(ASSISTANT_SENTINEL), "The mock model answered, proving the auto-send completed", text.slice(-400));
            assertEvidence(ctx, !text.includes("[attachment "), "The raw composer attachment token is not leaked into the message text", text.slice(0, 600));
          },
          screenshot: {
            name: "first-message-with-attachment",
            requireText: [FILENAME, ASSISTANT_SENTINEL],
            hashIncludes: "/session/",
          },
        });
      },
    },
    {
      name: "Verify the uploaded bytes in the worker workspace inbox",
      run: async (ctx) => {
        await ctx.prove("The attachment bytes were copied into the worker workspace inbox unchanged", {
          voiceover: vo[2],
          action: async () => {
            // Open the uploaded inbox copy from the FILES panel so the frame
            // shows the workspace artifact (name + byte count), not just chat.
            const clicked = await ctx.eval(`(() => {
              const button = Array.from(document.querySelectorAll("button")).find((node) => /-quarterly-costs\\.csv$/.test((node.textContent || "").trim()));
              if (!button) return false;
              button.click();
              return true;
            })()`);
            ctx.assert(clicked === true, "Could not open the uploaded CSV from the FILES panel.");
            await ctx.waitForText(`${EXPECTED_BYTES.length} bytes`, { timeoutMs: 15_000 });
          },
          assert: async () => {
            const transcript = await ctx.control("session.read_transcript", { count: 8 });
            const text = transcriptText(transcript);
            const fileUrl = extractAttachmentFileUrl(text);
            assertEvidence(ctx, Boolean(fileUrl), "Submitted turn includes a file:// URL for the uploaded CSV", text.slice(0, 600));
            const filePath = fileURLToPath(fileUrl);
            assertEvidence(ctx, filePath.includes(".opencode/openwork/inbox/chat-attachments/"), "File path is inside the worker chat-attachments inbox", filePath);
            const digest = await readSandboxFileDigest(ctx, filePath);
            assertEvidence(ctx, digest.bytes === EXPECTED_BYTES.length, "Uploaded CSV byte count matches the fixture", `${digest.bytes} bytes`);
            assertEvidence(ctx, digest.sha256 === EXPECTED_SHA256, "Uploaded CSV sha256 matches the fixture exactly", digest.sha256);
            ctx.output("worker inbox path", filePath);
          },
          screenshot: {
            name: "workspace-inbox-proof",
            requireText: [FILENAME, `${EXPECTED_BYTES.length} bytes`],
          },
        });
      },
    },
  ],
};
