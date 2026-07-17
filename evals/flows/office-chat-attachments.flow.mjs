import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";
import {
  DOCX_FILENAME,
  DOCX_SENTINEL,
  OFFICE_FIXTURES,
  PPTX_FILENAME,
  PPTX_SENTINEL,
} from "../fixtures/ooxml-office-fixtures.mjs";

const FLOW_ID = "office-chat-attachments";
const PROVIDER_ID = "office-attachments-mock";
const MODEL_ID = "office-attachment-mock";
const MOCK_PORT = 18081;
const DOWNLOAD_DIR = "/tmp/openwork-office-attachment-downloads";
const PROMPT = "Please inspect the attached Word document and PowerPoint deck, save exact copies as workspace artifacts, and summarize what you found.";
const FOLLOW_UP = "Confirm this Office attachment session still works after reopening.";
const vo = await loadVoiceoverParagraphs(FLOW_ID);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function runInSandbox(ctx, script, timeout = 120_000) {
  const encoded = Buffer.from(script, "utf8").toString("base64");
  const result = spawnSync(
    "daytona",
    ["exec", ctx.env.OPENWORK_EVAL_DAYTONA_SANDBOX.trim(), "--", "echo", encoded, "|", "base64", "-d", "|", "bash"],
    { encoding: "utf8", timeout },
  );
  ctx.assert(result.status === 0, `Daytona command failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function record(ctx, condition, assertion, actual = "") {
  ctx.recordEvidence({ type: "assertion", status: condition ? "passed" : "failed", assertion, actual });
  ctx.assert(condition, `${assertion}${actual ? ` (actual: ${actual})` : ""}`);
}

function startMockProvider(ctx) {
  const output = runInSandbox(ctx, `
set -euo pipefail
cd /workspace
if [ -f /tmp/openwork-office-attachments-mock.pid ]; then
  kill "$(cat /tmp/openwork-office-attachments-mock.pid)" >/dev/null 2>&1 || true
fi
rm -f /tmp/openwork-office-attachments-mock.log /tmp/openwork-office-attachments-mock.pid
nohup node evals/drivers/office-attachments-mock-provider.mjs --port ${MOCK_PORT} --workspace ${shellQuote(ctx.workspacePath || "/workspace")} > /tmp/openwork-office-attachments-mock.log 2>&1 < /dev/null &
echo $! > /tmp/openwork-office-attachments-mock.pid
for _ in $(seq 1 80); do
  if curl -sf http://127.0.0.1:${MOCK_PORT}/health >/tmp/openwork-office-attachments-health.json; then
    cat /tmp/openwork-office-attachments-health.json
    exit 0
  fi
  sleep 0.25
done
cat /tmp/openwork-office-attachments-mock.log >&2
exit 1
`);
  return output.trim();
}

function stopMockProvider(ctx) {
  return runInSandbox(ctx, `
set -uo pipefail
pidfile=/tmp/openwork-office-attachments-mock.pid
curl -sf --connect-timeout 1 --max-time 2 -X POST http://127.0.0.1:${MOCK_PORT}/shutdown >/dev/null 2>&1 || true
if [ -s "$pidfile" ]; then
  pid="$(cat "$pidfile" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" >/dev/null 2>&1; then
    kill "$pid" >/dev/null 2>&1 || true
    for _ in $(seq 1 20); do
      if ! kill -0 "$pid" >/dev/null 2>&1; then
        break
      fi
      sleep 0.1
    done
    if kill -0 "$pid" >/dev/null 2>&1; then
      kill -KILL "$pid" >/dev/null 2>&1 || true
    fi
  fi
fi
rm -f "$pidfile"
printf 'mock stopped\n'
`, 30_000).trim();
}

function proofFromSandbox(ctx) {
  const raw = runInSandbox(ctx, `curl -sf http://127.0.0.1:${MOCK_PORT}/proof`, 30_000);
  return JSON.parse(raw);
}

async function pollProof(ctx, predicate, timeoutMs, label) {
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt < timeoutMs) {
    last = proofFromSandbox(ctx);
    if (predicate(last)) return last;
    await sleep(500);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}. Last proof: ${JSON.stringify(last)}`);
}

async function forceEnglish(ctx) {
  const shouldReload = await ctx.eval(`(() => {
    const current = localStorage.getItem("openwork.language");
    localStorage.setItem("openwork.language", "en");
    return current !== "en" || document.documentElement.getAttribute("lang") !== "en";
  })()`);
  if (!shouldReload) return;
  await ctx.eval("location.reload()");
  await ctx.waitFor("Boolean(window.__openworkControl)", {
    timeoutMs: 60_000,
    label: "control API after language reload",
  });
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

async function loadWorkspacePath(ctx) {
  const payload = await serverJson(ctx, "/workspaces");
  const workspaces = Array.isArray(payload) ? payload : payload?.items ?? payload?.workspaces ?? [];
  const workspace = workspaces.find((item) => item?.id === ctx.workspaceId);
  const workspacePath = typeof workspace?.path === "string" ? workspace.path : "";
  ctx.assert(Boolean(workspacePath), `Could not determine workspace path for ${ctx.workspaceId}`);
  ctx.workspacePath = workspacePath;
}

async function configureMockProvider(ctx) {
  const state = await appRouteState(ctx);
  ctx.assert(Boolean(state.workspaceId), `Could not determine workspace id from ${state.hash}`);
  ctx.workspaceId = state.workspaceId;
  await loadWorkspacePath(ctx);

  const baseURL = `http://127.0.0.1:${MOCK_PORT}/v1`;
  await serverJson(ctx, `/workspace/${encodeURIComponent(ctx.workspaceId)}/config`, {
    method: "PATCH",
    body: {
      opencode: {
        provider: {
          [PROVIDER_ID]: {
            npm: "@ai-sdk/openai-compatible",
            name: "Office Attachments Mock",
            options: { baseURL, apiKey: "sk-openwork-office-attachments-eval" },
            models: {
              [MODEL_ID]: {
                name: "Office attachment mock",
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
    localStorage.removeItem("openwork.sessionModels.${ctx.workspaceId}");
  })()`);
  ctx.output("Office mock provider", JSON.stringify({ provider: PROVIDER_ID, model: MODEL_ID, baseURL }, null, 2));
}

async function assertOfficeMockSelected(ctx) {
  const selected = await ctx.waitFor(`(() => {
    const buttons = Array.from(document.querySelectorAll("button"));
    const button = buttons.find((item) => item.getAttribute("aria-label") === "Change model");
    const text = button && button.textContent ? button.textContent : "";
    return text.includes("Office attachment mock") ? text : null;
  })()`, { timeoutMs: 60_000, label: "visible Office mock selected model" });
  record(ctx, selected.includes("Office attachment mock"), "Visible selected model is Office attachment mock", selected);
}

async function dismissOpenWorkModelsModal(ctx) {
  const result = await ctx.eval(`(() => {
    const roots = Array.from(document.querySelectorAll('[role="dialog"], [data-slot="dialog-content"], [data-radix-dialog-content]'));
    const dialog = roots.find((item) => (item.textContent || "").includes("OpenWork Models"));
    if (!dialog) return { dismissed: false };
    const buttons = Array.from(dialog.querySelectorAll("button"));
    const continueButton = buttons.find((button) => (button.textContent || "").trim().includes("Continue without OpenWork Models"));
    const closeButton = buttons.find((button) => {
      const label = button.getAttribute("aria-label") || "";
      return label === "Close" || (button.textContent || "").trim() === "Close";
    });
    const button = continueButton || closeButton;
    if (!button) return { dismissed: false, reason: "OpenWork Models modal had no dismiss button" };
    button.click();
    return { dismissed: true };
  })()`);
  if (!result || !result.dismissed) return;
  await ctx.waitFor(`(() => {
    const roots = Array.from(document.querySelectorAll('[role="dialog"], [data-slot="dialog-content"], [data-radix-dialog-content]'));
    return !roots.some((item) => (item.textContent || "").includes("OpenWork Models"));
  })()`, { timeoutMs: 10_000, label: "OpenWork Models modal dismissed" });
}

async function createFreshSession(ctx) {
  await ctx.waitFor(
    `window.__openworkControl.listActions().some((item) => item.id === "session.create_task" && !item.disabled)`,
    { timeoutMs: 60_000, label: "session.create_task enabled" },
  );
  await ctx.control("session.create_task");
  await ctx.waitFor(
    `(() => {
      const sessionIdFrom = (value) => {
        const text = String(value || "");
        const marker = "/session/";
        const index = text.indexOf(marker);
        if (index < 0) return "";
        const rest = text.slice(index + marker.length);
        const end = rest.indexOf("/");
        const sessionId = end < 0 ? rest : rest.slice(0, end);
        return sessionId.startsWith("ses_") ? sessionId : "";
      };
      const control = window.__openworkControl;
      const snapshot = control && typeof control.snapshot === "function" ? control.snapshot() : null;
      const route = snapshot && snapshot.route ? snapshot.route : "";
      return Boolean(sessionIdFrom(location.hash) || sessionIdFrom(route));
    })()`,
    { timeoutMs: 60_000, label: "fresh session route" },
  );
  const state = await appRouteState(ctx);
  ctx.workspaceId = state.workspaceId;
  ctx.sessionId = state.sessionId;
  ctx.assert(Boolean(ctx.workspaceId && ctx.sessionId), `Missing session route info: ${JSON.stringify(state)}`);
  await ctx.waitFor(`Boolean(document.querySelector('input[type="file"][multiple]'))`, {
    timeoutMs: 30_000,
    label: "composer file input",
  });
}

async function attachOfficeFiles(ctx) {
  return ctx.eval(
    `(() => {
      const input = document.querySelector('input[type="file"][multiple]');
      if (!(input instanceof HTMLInputElement)) return { ok: false, reason: "file input not found" };
      const toBytes = (base64) => {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        return bytes;
      };
      const transfer = new DataTransfer();
      transfer.items.add(new File(
        [toBytes(${JSON.stringify(OFFICE_FIXTURES.docx.dataBase64)})],
        ${JSON.stringify(DOCX_FILENAME)},
        { type: ${JSON.stringify(OFFICE_FIXTURES.docx.mime)}, lastModified: 1767225600000 },
      ));
      transfer.items.add(new File(
        [toBytes(${JSON.stringify(OFFICE_FIXTURES.pptx.dataBase64)})],
        ${JSON.stringify(PPTX_FILENAME)},
        { type: ${JSON.stringify(OFFICE_FIXTURES.pptx.mime)}, lastModified: 1767225600000 },
      ));
      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, files: Array.from(transfer.files).map((file) => ({ name: file.name, type: file.type, size: file.size })) };
    })()`,
  );
}

async function waitForFinalResponse(ctx) {
  await ctx.waitFor(
    `(() => {
      const text = document.body.innerText;
      return text.includes(${JSON.stringify(DOCX_SENTINEL)})
        && text.includes(${JSON.stringify(PPTX_SENTINEL)})
        && text.includes("artifacts/QuarterlyBrief.docx")
        && text.includes("artifacts/LaunchRoadmap.pptx");
    })()`,
    { timeoutMs: 120_000, label: "final assistant response with Office facts and artifacts" },
  );
}

async function waitForVisibleFinalResponse(ctx) {
  await ctx.waitFor(
    `(() => {
      const required = [
        ${JSON.stringify(DOCX_SENTINEL)},
        ${JSON.stringify(PPTX_SENTINEL)},
        "artifacts/QuarterlyBrief.docx",
        "artifacts/LaunchRoadmap.pptx",
      ];
      const isVisibleRect = (rect) => rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
      const visibleTextIncludes = (root, needle) => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const text = node.nodeValue || "";
          const index = text.indexOf(needle);
          if (index < 0) continue;
          const range = document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + needle.length);
          const visible = Array.from(range.getClientRects()).some(isVisibleRect);
          range.detach();
          if (visible) return true;
        }
        return false;
      };
      const messages = Array.from(document.querySelectorAll('[data-message-role="assistant"]'));
      return messages.some((message) => required.every((item) => visibleTextIncludes(message, item)));
    })()`,
    { timeoutMs: 30_000, label: "visible final assistant response with Office facts and artifacts" },
  );
}

function sentAttachmentCardsExpr() {
  return `(() => {
    const buttons = Array.from(document.querySelectorAll("button"));
    const hasSentFileCard = (filename, badge) => {
      const button = buttons.find((item) => item.getAttribute("aria-label") === "Download " + filename);
      const card = button ? button.closest("div") : null;
      const text = card && card.textContent ? card.textContent : "";
      return Boolean(button && text.includes(filename) && text.includes(badge) && text.includes("Download"));
    };
    const docx = hasSentFileCard(${JSON.stringify(DOCX_FILENAME)}, "DOCX");
    const pptx = hasSentFileCard(${JSON.stringify(PPTX_FILENAME)}, "PPTX");
    if (!docx || !pptx) return null;
    return {
      docx,
      pptx,
      downloadButtons: buttons.filter((button) => {
        const label = button.getAttribute("aria-label") || "";
        return label.startsWith("Download ") && label !== "Download artifact";
      }).length,
    };
  })()`;
}

async function sessionMessages(ctx) {
  const payload = await serverJson(ctx, `/workspace/${encodeURIComponent(ctx.workspaceId)}/sessions/${encodeURIComponent(ctx.sessionId)}/messages?limit=80`);
  return payload.items ?? [];
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(record, names) {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function dataUrlDetails(value) {
  if (typeof value !== "string") return null;
  const match = /^data:([^;,]+)?(?:;[^,]*)?;base64,([A-Za-z0-9+/=\s]+)$/i.exec(value);
  if (!match) return null;
  const bytes = Buffer.from(match[2].replace(/\s+/g, ""), "base64");
  return {
    mime: (match[1] || "application/octet-stream").trim().toLowerCase(),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.byteLength,
  };
}

function findDataUrlDetails(value) {
  const direct = dataUrlDetails(value);
  if (direct) return direct;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findDataUrlDetails(item);
      if (found) return found;
    }
  }
  if (!isRecord(value)) return null;
  for (const item of Object.values(value)) {
    const found = findDataUrlDetails(item);
    if (found) return found;
  }
  return null;
}

function collectStrings(value, out = []) {
  if (typeof value === "string") {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return out;
  }
  if (!isRecord(value)) return out;
  for (const item of Object.values(value)) collectStrings(item, out);
  return out;
}

function canonicalDataUrl(expected) {
  return `data:${expected.mime};base64,${expected.dataBase64}`;
}

function workspaceRelativePath(root, target) {
  const relativePath = relative(resolve(root), resolve(target));
  const outside = relativePath === ".." || relativePath.startsWith("../") || relativePath.startsWith("..\\");
  return relativePath && !outside ? relativePath : "";
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function attachmentPathNoteText(messages) {
  return collectStrings(messages)
    .filter((text) => text.includes(".opencode/openwork/inbox/chat-attachments/") || text.includes("Attached files were copied into this worker workspace"))
    .join("\n");
}

function parseAttachmentPathNoteReference(text, expected) {
  const filenamePattern = escapeRegExp(expected.filename);
  const pathPattern = new RegExp(`\\.opencode/openwork/inbox/chat-attachments/[^\\s)]*${filenamePattern}`);
  const lines = text.split(/\r?\n/).filter((line) => line.includes(expected.filename));
  for (const line of lines) {
    const path = pathPattern.exec(line)?.[0] ?? "";
    const url = /file:\/\/[^\s)]+/i.exec(line)?.[0] ?? "";
    if (path || url) return { line, path, url };
  }
  return { line: "", path: "", url: "" };
}

function hashWorkspaceFile(ctx, filePath) {
  ctx.assert(Boolean(ctx.workspacePath), "Missing workspace path");
  const raw = runInSandbox(ctx, `
set -euo pipefail
root=${shellQuote(ctx.workspacePath)}
target=${shellQuote(filePath)}
node - "$root" "$target" <<'EOF'
const { createHash } = require("node:crypto");
const { readFileSync, realpathSync } = require("node:fs");
const { isAbsolute, relative } = require("node:path");
const root = realpathSync(process.argv[2]);
const target = realpathSync(process.argv[3]);
const relativePath = relative(root, target);
const outside = relativePath === ".." || relativePath.startsWith("../") || relativePath.startsWith("..\\\\");
if (!relativePath || outside || isAbsolute(relativePath)) {
  throw new Error("attachment path is outside workspace: " + target);
}
const bytes = readFileSync(target);
process.stdout.write(JSON.stringify({
  path: target,
  relativePath,
  bytes: bytes.byteLength,
  sha256: createHash("sha256").update(bytes).digest("hex"),
}));
EOF
`, 30_000).trim();
  return JSON.parse(raw);
}

function collectFileParts(value, out = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectFileParts(item, out);
    return out;
  }
  if (!isRecord(value)) return out;
  const type = stringField(value, ["type"]);
  const filename = stringField(value, ["filename", "fileName", "name"]);
  if (type === "file" || filename === DOCX_FILENAME || filename === PPTX_FILENAME) out.push(value);
  for (const item of Object.values(value)) collectFileParts(item, out);
  return out;
}

function assertPersistedOriginalOfficeParts(ctx, messages) {
  const parts = collectFileParts(messages);
  for (const [kind, expected] of Object.entries(OFFICE_FIXTURES)) {
    const candidates = parts.filter((part) => stringField(part, ["filename", "fileName", "name"]) === expected.filename);
    const expectedUrl = canonicalDataUrl(expected);
    const found = candidates.find((part) => {
      const details = findDataUrlDetails(part);
      const url = stringField(part, ["url"]);
      return stringField(part, ["mediaType", "mime", "mimeType", "contentType"]).toLowerCase() === expected.mime
        && url === expectedUrl
        && details?.sha256 === expected.sha256
        && details.mime === expected.mime;
    }) || candidates[0];
    record(ctx, Boolean(found), `Session read API retained original ${kind.toUpperCase()} FilePart`, JSON.stringify({ candidates: candidates.length }));
    if (!found) continue;
    const filename = stringField(found, ["filename", "fileName", "name"]);
    const mime = stringField(found, ["mediaType", "mime", "mimeType", "contentType"]).toLowerCase();
    const url = stringField(found, ["url"]);
    const dataUrl = findDataUrlDetails(found);
    const fileUrls = candidates.map((part) => stringField(part, ["url"])).filter((value) => value.toLowerCase().startsWith("file:"));
    record(ctx, filename === expected.filename, `Persisted ${kind.toUpperCase()} filename is canonical`, filename);
    record(ctx, mime === expected.mime, `Persisted ${kind.toUpperCase()} MIME is canonical`, mime);
    record(ctx, url === expectedUrl, `Persisted ${kind.toUpperCase()} FilePart URL is the exact canonical data URL`, JSON.stringify({ urlPrefix: url.slice(0, 64), urlLength: url.length }));
    record(ctx, dataUrl?.mime === expected.mime, `Persisted ${kind.toUpperCase()} data URL MIME is canonical`, dataUrl?.mime || "missing");
    record(ctx, dataUrl?.sha256 === expected.sha256, `Persisted ${kind.toUpperCase()} data URL sha256 matches original bytes`, dataUrl?.sha256 || "missing");
    record(ctx, fileUrls.length === 0, `Session read API exposes only data URLs for ${kind.toUpperCase()} FileParts`, JSON.stringify(fileUrls));
  }
}

function assertWorkspaceAttachmentPathNotes(ctx, messages) {
  const text = attachmentPathNoteText(messages);
  record(ctx, text.includes("Attached files were copied into this worker workspace"), "Session text contains the worker attachment path note", text.slice(0, 1000));
  for (const [kind, expected] of Object.entries(OFFICE_FIXTURES)) {
    const reference = parseAttachmentPathNoteReference(text, expected);
    record(ctx, Boolean(reference.path), `Submitted ${kind.toUpperCase()} path note includes a workspace-local inbox path`, reference.line || text.slice(0, 1000));
    record(ctx, reference.path.startsWith(".opencode/openwork/inbox/chat-attachments/"), `Submitted ${kind.toUpperCase()} path note stays under chat-attachments`, reference.path);
    record(ctx, Boolean(reference.url), `Submitted ${kind.toUpperCase()} path note includes a file: URL`, reference.line || text.slice(0, 1000));
    const filePath = reference.url ? fileURLToPath(reference.url) : "";
    const relativePath = filePath ? workspaceRelativePath(ctx.workspacePath, filePath) : "";
    record(ctx, relativePath === reference.path, `Submitted ${kind.toUpperCase()} file: URL resolves to the noted workspace path`, JSON.stringify({ filePath, relativePath, notedPath: reference.path }));
    const hash = hashWorkspaceFile(ctx, filePath);
    record(ctx, hash.relativePath === reference.path, `Daytona ${kind.toUpperCase()} workspace copy resolves under the noted inbox path`, JSON.stringify(hash));
    record(ctx, hash.sha256 === expected.sha256, `Daytona ${kind.toUpperCase()} workspace copy sha256 matches the fixture exactly`, hash.sha256);
    record(ctx, hash.bytes === expected.size, `Daytona ${kind.toUpperCase()} workspace copy size matches the fixture exactly`, String(hash.bytes));
  }
}

function workspaceArtifactHashes(ctx) {
  ctx.assert(Boolean(ctx.workspacePath), "Missing workspace path");
  const raw = runInSandbox(ctx, `
set -euo pipefail
root=${shellQuote(ctx.workspacePath)}
node - "$root" <<'EOF'
const { createHash } = require("node:crypto");
const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const root = process.argv[2];
const files = ["artifacts/QuarterlyBrief.docx", "artifacts/LaunchRoadmap.pptx"];
const result = {};
for (const file of files) {
  const path = join(root, file);
  result[file] = existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null;
}
process.stdout.write(JSON.stringify(result));
EOF
`, 30_000).trim();
  return JSON.parse(raw);
}

function resetWorkspaceOfficeArtifacts(ctx) {
  ctx.assert(Boolean(ctx.workspacePath), "Missing workspace path");
  runInSandbox(ctx, `
set -euo pipefail
root=${shellQuote(ctx.workspacePath)}
rm -f "$root/artifacts/QuarterlyBrief.docx" "$root/artifacts/LaunchRoadmap.pptx"
`, 30_000);
  return workspaceArtifactHashes(ctx);
}

function workspaceArtifactsHaveExpectedHashes(hashes) {
  return hashes["artifacts/QuarterlyBrief.docx"] === OFFICE_FIXTURES.docx.sha256
    && hashes["artifacts/LaunchRoadmap.pptx"] === OFFICE_FIXTURES.pptx.sha256;
}

async function clickArtifact(ctx, filename) {
  await dismissOpenWorkModelsModal(ctx);
  await ctx.waitFor(`(() => {
    const buttons = Array.from(document.querySelectorAll("button"));
    const tabsOpen = buttons.some((item) => {
      const label = item.getAttribute("aria-label") || "";
      return label.startsWith("Select tab: ");
    });
    if (tabsOpen) return true;
    const railButton = buttons.find((item) => {
      const label = item.getAttribute("aria-label") || "";
      return label.startsWith("Artifacts");
    });
    if (!railButton) return false;
    railButton.scrollIntoView({ block: "center", inline: "center" });
    railButton.click();
    return true;
  })()`, { timeoutMs: 30_000, label: "artifact rail button" });
  await ctx.waitFor(`(() => {
    const buttons = Array.from(document.querySelectorAll("button"));
    return buttons.some((item) => {
      const label = item.getAttribute("aria-label") || "";
      return label.startsWith("Select tab: ");
    });
  })()`, { timeoutMs: 30_000, label: "artifact panel tabs" });
  await ctx.waitFor(`(() => {
    const heading = document.querySelector("h3");
    if (heading && (heading.textContent || "").includes(${JSON.stringify(filename)})) return true;
    const buttons = Array.from(document.querySelectorAll("button"));
    const tab = buttons.find((item) => item.getAttribute("aria-label") === "Select tab: " + ${JSON.stringify(filename)});
    if (tab) {
      tab.scrollIntoView({ block: "center", inline: "center" });
      tab.click();
      return true;
    }
    const previewTitle = "Preview " + ${JSON.stringify(filename)};
    const openTitle = "Open " + ${JSON.stringify(filename)};
    const inlineArtifact = buttons.find((item) => {
      const title = item.getAttribute("title") || "";
      return title === previewTitle || title === openTitle;
    });
    if (!inlineArtifact) return false;
    inlineArtifact.scrollIntoView({ block: "center", inline: "center" });
    inlineArtifact.click();
    return true;
  })()`, { timeoutMs: 30_000, label: `artifact tab ${filename}` });
  await ctx.waitFor(`(() => {
    const heading = document.querySelector("h3");
    return Boolean(heading && (heading.textContent || "").includes(${JSON.stringify(filename)}));
  })()`, {
    timeoutMs: 30_000,
    label: `artifact panel ${filename}`,
  });
}

async function assertArtifactPanelControls(ctx, filename) {
  const controls = await ctx.eval(`(() => {
    const buttons = Array.from(document.querySelectorAll("button"));
    const heading = document.querySelector("h3");
    return {
      heading: heading && heading.textContent ? heading.textContent : "",
      previewUnavailable: document.body.innerText.includes("Preview unavailable"),
      download: buttons.some((button) => button.getAttribute("aria-label") === "Download artifact" && !button.disabled),
      openExternal: buttons.some((button) => button.getAttribute("aria-label") === "Open externally" && !button.disabled),
      showInFolder: buttons.some((button) => button.getAttribute("aria-label") === "Show in folder" && !button.disabled),
    };
  })()`);
  record(ctx, controls.heading.includes(filename), `${filename} is the selected artifact`, controls.heading);
  record(ctx, controls.previewUnavailable, `${filename} deliberately renders Preview unavailable`);
  record(ctx, controls.download, `${filename} exposes an enabled Download control`);
  record(ctx, controls.openExternal, `${filename} exposes an enabled Open externally control`);
  record(ctx, controls.showInFolder, `${filename} exposes an enabled Show in folder control`);
}

async function clickDownloadButtonAndVerifySha(ctx, { buttonLabel, filename, expectedSha, assertion }) {
  runInSandbox(ctx, `rm -rf ${shellQuote(DOWNLOAD_DIR)} && mkdir -p ${shellQuote(DOWNLOAD_DIR)}`, 30_000);
  await ctx.client.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: DOWNLOAD_DIR }).catch(async () => {
    await ctx.client.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: DOWNLOAD_DIR });
  });
  const clicked = await ctx.eval(`(() => {
    const buttons = Array.from(document.querySelectorAll("button"))
      .filter((item) => item.getAttribute("aria-label") === ${JSON.stringify(buttonLabel)} && !item.disabled);
    if (buttons.length !== 1) return { ok: false, count: buttons.length };
    const button = buttons[0];
    button.scrollIntoView({ block: "center", inline: "center" });
    button.click();
    return { ok: true, count: 1 };
  })()`);
  ctx.assert(clicked?.ok, `Expected exactly one enabled ${buttonLabel} button, found ${clicked?.count ?? "unknown"}`);
  const output = runInSandbox(ctx, `
set -euo pipefail
download_dir=${shellQuote(DOWNLOAD_DIR)}
filename=${shellQuote(filename)}
path="$download_dir/$filename"
for _ in $(seq 1 80); do
  if [ -f "$path" ]; then break; fi
  sleep 0.25
done
test -f "$path"
node - "$path" <<'EOF'
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
process.stdout.write(createHash("sha256").update(readFileSync(process.argv[2])).digest("hex"));
EOF
`, 45_000).trim();
  record(ctx, output === expectedSha, assertion, output);
}

export default {
  id: FLOW_ID,
  title: "Session composer safely normalizes valid Word and PowerPoint attachments through the real model boundary",
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
      { timeoutMs: 30_000, label: "session.create_task enabled (or welcome/signin)" },
    );
    return state === "blocked"
      ? "Profile is not onboarded (welcome/signin); Office attachment flow requires a workspace."
      : null;
  },
  steps: [
    {
      name: "Mock provider is selected for a fresh task",
      run: async (ctx) => {
        await ctx.prove("A fresh Daytona task uses the deterministic OpenAI-compatible Office mock provider", {
          voiceover: vo[0],
          action: async () => {
            await forceEnglish(ctx);
            const state = await appRouteState(ctx);
            ctx.assert(Boolean(state.workspaceId), `Could not determine workspace id from ${state.hash}`);
            ctx.workspaceId = state.workspaceId;
            await loadWorkspacePath(ctx);
            const health = startMockProvider(ctx);
            ctx.output("Office mock health", health);
            await configureMockProvider(ctx);
            await ctx.eval("location.reload()");
            await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000, label: "control API after provider reload" });
            await createFreshSession(ctx);
            await assertOfficeMockSelected(ctx);
          },
          assert: async () => {
            await ctx.expectText("Run task");
            await ctx.expectText("Office attachment mock");
            await ctx.expectNoText("has a format the model can't read");
            record(ctx, !PROMPT.includes(DOCX_SENTINEL) && !PROMPT.includes(PPTX_SENTINEL), "The user prompt does not contain either sentinel fact");
          },
          screenshot: {
            name: "fresh-office-mock-composer",
            requireText: ["Run task", "Office attachment mock"],
            rejectText: ["has a format the model can't read"],
            hashIncludes: "/session/",
          },
        });
      },
    },
    {
      name: "Valid DOCX and PPTX attach through the real composer",
      run: async (ctx) => {
        await ctx.prove("Valid deterministic Office packages attach as normal file chips with no unsupported-format warning", {
          voiceover: vo[1],
          action: async () => {
            const attached = await attachOfficeFiles(ctx);
            ctx.assert(attached?.ok, `Could not attach Office files: ${attached?.reason ?? "unknown"}`);
            await ctx.control("composer.set_text", { text: PROMPT });
            await ctx.waitFor(
              `(() => {
                const text = document.body.innerText;
                return text.includes(${JSON.stringify(DOCX_FILENAME)}) && text.includes(${JSON.stringify(PPTX_FILENAME)}) && text.includes(${JSON.stringify(PROMPT)});
              })()`,
              { timeoutMs: 30_000, label: "Office attachment chips and prompt" },
            );
          },
          assert: async () => {
            await ctx.expectText(DOCX_FILENAME);
            await ctx.expectText(PPTX_FILENAME);
            await ctx.expectNoText("has a format the model can't read");
            await ctx.expectNoText("files have formats the model can't read");
            await ctx.expectNoText("Convert to PDF");
          },
          screenshot: {
            name: "valid-office-attachment-chips",
            requireText: [DOCX_FILENAME, PPTX_FILENAME, "File", "Run task"],
            rejectText: ["has a format the model can't read", "files have formats the model can't read", "Convert to PDF"],
            hashIncludes: "/session/",
          },
        });
      },
    },
    {
      name: "Send normalizes Office files for provider text, tool loop writes artifacts, and sent cards are actionable",
      run: async (ctx) => {
        await ctx.prove("Sending crosses Electron, OpenWork, OpenCode, and the provider; the mock receives normalized Office text, then writes exact materialized bytes via bash", {
          voiceover: vo[2],
          action: async () => {
            const beforeHashes = resetWorkspaceOfficeArtifacts(ctx);
            record(
              ctx,
              beforeHashes["artifacts/QuarterlyBrief.docx"] === null && beforeHashes["artifacts/LaunchRoadmap.pptx"] === null,
              "Workspace Office artifacts are absent before send",
              JSON.stringify(beforeHashes),
            );
            await ctx.control("composer.send");
            const proof = await pollProof(
              ctx,
              (item) => item.providerReceipt && item.normalizedTextOnly && item.exactHashes && item.exactMimes && item.materializedPaths && item.sentinelsExtracted && item.toolCallCompleted && item.finalResponse,
              120_000,
              "normalized provider text, materialized Office hashes, completed bash tool call, and final response",
            );
            ctx.output("Office mock proof after send", JSON.stringify(proof, null, 2));
            record(
              ctx,
              proof.normalizedTextOnly && proof.payloadCount === 0 && proof.officeFileMarkers === 0 && !proof.rawOfficeBinaryLeak,
              "Provider request contains normalized Office text only, with no raw Office binary or file media",
              JSON.stringify({ payloadCount: proof.payloadCount, officeFileMarkers: proof.officeFileMarkers, rawOfficeBinaryLeak: proof.rawOfficeBinaryLeak }),
            );
            record(ctx, proof.materializedPaths, "Mock verified safe materialized worker-relative Office paths", JSON.stringify(proof.attachments));
            record(ctx, proof.toolCallCompleted, "Mock observed the completed bash tool result before final response");
            const afterHashes = workspaceArtifactHashes(ctx);
            record(
              ctx,
              workspaceArtifactsHaveExpectedHashes(afterHashes),
              "Workspace Office artifacts are present after the bash tool with exact hashes",
              JSON.stringify(afterHashes),
            );
            await waitForFinalResponse(ctx);
            await dismissOpenWorkModelsModal(ctx);
            const messages = await sessionMessages(ctx);
            const sessionText = JSON.stringify(messages);
            record(ctx, sessionText.includes(DOCX_SENTINEL) && sessionText.includes(PPTX_SENTINEL), "Session read API contains both extracted sentinel facts");
            record(ctx, sessionText.includes("artifacts/QuarterlyBrief.docx") && sessionText.includes("artifacts/LaunchRoadmap.pptx"), "Session read API contains both artifact paths");
            assertPersistedOriginalOfficeParts(ctx, messages);
            assertWorkspaceAttachmentPathNotes(ctx, messages);
            const cards = await ctx.waitFor(sentAttachmentCardsExpr(), { timeoutMs: 30_000, label: "sent Office cards with Download actions" });
            record(ctx, cards.docx, "Sent DOCX card shows DOCX badge and Download action");
            record(ctx, cards.pptx, "Sent PPTX card shows PPTX badge and Download action");
            record(ctx, cards.downloadButtons >= 2, "Sent Office cards expose DOCX/PPTX Download actions", JSON.stringify({ downloadButtons: cards.downloadButtons }));
            await clickDownloadButtonAndVerifySha(ctx, {
              buttonLabel: `Download ${DOCX_FILENAME}`,
              filename: DOCX_FILENAME,
              expectedSha: OFFICE_FIXTURES.docx.sha256,
              assertion: `Sent attachment card Download for ${DOCX_FILENAME} saves the exact expected sha256`,
            });
            await dismissOpenWorkModelsModal(ctx);
            await ctx.control("session.scroll_bottom");
            await waitForVisibleFinalResponse(ctx);
          },
          assert: async () => {
            await ctx.expectText(DOCX_SENTINEL);
            await ctx.expectText(PPTX_SENTINEL);
            await ctx.expectText("artifacts/QuarterlyBrief.docx");
            await ctx.expectText("artifacts/LaunchRoadmap.pptx");
            await ctx.expectText("Download");
          },
          screenshot: {
            name: "provider-tool-loop-final-response",
            requireText: [DOCX_FILENAME, PPTX_FILENAME, "DOCX", "PPTX", "Download", "artifacts/QuarterlyBrief.docx", "artifacts/LaunchRoadmap.pptx"],
            hashIncludes: "/session/",
          },
        });
      },
    },
    {
      name: "DOCX artifact is collectible and downloads exact bytes",
      run: async (ctx) => {
        await ctx.prove("The generated DOCX appears in the artifact rail, opens to Preview unavailable, and downloads exact bytes", {
          voiceover: vo[3],
          action: async () => {
            await clickArtifact(ctx, DOCX_FILENAME);
            await assertArtifactPanelControls(ctx, DOCX_FILENAME);
            await clickDownloadButtonAndVerifySha(ctx, {
              buttonLabel: "Download artifact",
              filename: DOCX_FILENAME,
              expectedSha: OFFICE_FIXTURES.docx.sha256,
              assertion: `Artifact panel Download for ${DOCX_FILENAME} saves the exact expected sha256`,
            });
          },
          assert: async () => {
            await ctx.expectText(DOCX_FILENAME);
            await ctx.expectText("Preview unavailable");
          },
          screenshot: {
            name: "docx-preview-unavailable-controls",
            requireText: [DOCX_FILENAME, "Preview unavailable"],
            hashIncludes: "/session/",
          },
        });
      },
    },
    {
      name: "PPTX artifact keeps slides classification and external controls",
      run: async (ctx) => {
        await ctx.prove("The generated PPTX remains a slides artifact and deliberately uses the same external-file affordances", {
          voiceover: vo[4],
          action: async () => {
            await clickArtifact(ctx, PPTX_FILENAME);
            await assertArtifactPanelControls(ctx, PPTX_FILENAME);
          },
          assert: async () => {
            await ctx.expectText(PPTX_FILENAME);
            await ctx.expectText("Preview unavailable");
          },
          screenshot: {
            name: "pptx-preview-unavailable-controls",
            requireText: [PPTX_FILENAME, "Preview unavailable"],
            hashIncludes: "/session/",
          },
        });
      },
    },
    {
      name: "Reloaded session can send a follow-up without poisoned Office history",
      run: async (ctx) => {
        await ctx.prove("After reloading and reopening the same session, Office history replays safely and the restored cards stay actionable", {
          voiceover: vo[5],
          action: async () => {
            await ctx.eval("location.reload()");
            await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000, label: "control API after session reload" });
            await ctx.navigateHash(`/workspace/${ctx.workspaceId}/session/${ctx.sessionId}`);
            await ctx.waitFor(`location.hash.includes(${JSON.stringify(`/workspace/${ctx.workspaceId}/session/${ctx.sessionId}`)})`, {
              timeoutMs: 30_000,
              label: "reopened Office session route",
            });
            await dismissOpenWorkModelsModal(ctx);
            const restoredCards = await ctx.waitFor(sentAttachmentCardsExpr(), { timeoutMs: 45_000, label: "restored Office sent cards" });
            record(ctx, restoredCards.docx && restoredCards.pptx, "Reload restored both sent Office cards with badges and Download actions");
            record(ctx, restoredCards.downloadButtons >= 2, "Reloaded Office sent cards keep DOCX/PPTX Download actions", JSON.stringify({ downloadButtons: restoredCards.downloadButtons }));
            await ctx.control("composer.set_text", { text: FOLLOW_UP });
            await ctx.control("composer.send");
            const replayProof = await pollProof(ctx, (item) => item.replayResponse && item.replayOfficeHistoryOk && item.replay?.normalizedTextOnly, 90_000, "successful replay follow-up with normalized Office history");
            ctx.output("Office mock proof after replay", JSON.stringify(replayProof, null, 2));
            await ctx.waitFor(`document.body.innerText.includes("Replay succeeded after reopening the session")`, {
              timeoutMs: 60_000,
              label: "replay success assistant response",
            });
            await dismissOpenWorkModelsModal(ctx);
          },
          assert: async () => {
            await ctx.expectText(DOCX_FILENAME);
            await ctx.expectText(PPTX_FILENAME);
            await ctx.expectText("Download");
            await ctx.expectText("Replay succeeded after reopening the session");
          },
          screenshot: {
            name: "reopened-session-office-history-safe",
            requireText: [DOCX_FILENAME, PPTX_FILENAME, "Download", "Replay succeeded after reopening the session"],
            hashIncludes: "/session/",
          },
        });
      },
    },
    {
      name: "Stop Office mock provider",
      run: async (ctx) => {
        const output = stopMockProvider(ctx);
        ctx.output("Office mock shutdown", output);
      },
    },
  ],
};
