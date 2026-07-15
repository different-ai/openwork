import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";
import { XLSX_FILENAME, XLSX_FIXTURE, XLSX_SENTINEL } from "../fixtures/ooxml-office-fixtures.mjs";

const FLOW_ID = "xlsx-chat-attachments";
const PROVIDER_ID = "xlsx-attachments-mock";
const MODEL_ID = "office-attachment-mock";
const MOCK_PORT = 18082;
const DOWNLOAD_DIR = "/tmp/openwork-xlsx-attachment-downloads";
const ARTIFACT_PATH = "artifacts/RevenueWorkbook.xlsx";
const PROMPT = "Please inspect the attached Excel workbook, preserve an exact copy as a workspace artifact, and summarize the sheet values, formula, formatting, and merge range.";
const FOLLOW_UP = "Confirm this spreadsheet attachment session still works after reopening.";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const vo = await loadVoiceoverParagraphs(FLOW_ID);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function runInSandbox(ctx, script, timeout = 120_000) {
  const sandbox = ctx.env?.OPENWORK_EVAL_DAYTONA_SANDBOX?.trim();
  if (!sandbox) {
    const result = spawnSync("bash", ["-lc", script], { cwd: REPO_ROOT, encoding: "utf8", timeout });
    ctx.assert(result.status === 0, `Local command failed: ${result.stderr || result.stdout}`);
    return result.stdout;
  }

  const sandboxScript = `cd /workspace\n${script}`;
  const encoded = Buffer.from(sandboxScript, "utf8").toString("base64");
  const result = spawnSync(
    "daytona",
    ["exec", sandbox, "--", "echo", encoded, "|", "base64", "-d", "|", "bash"],
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
  return runInSandbox(ctx, `
set -euo pipefail
if [ -f /tmp/openwork-xlsx-attachments-mock.pid ]; then
  kill "$(cat /tmp/openwork-xlsx-attachments-mock.pid)" >/dev/null 2>&1 || true
fi
rm -f /tmp/openwork-xlsx-attachments-mock.log /tmp/openwork-xlsx-attachments-mock.pid
nohup node evals/drivers/office-attachments-mock-provider.mjs --mode xlsx --port ${MOCK_PORT} --workspace ${shellQuote(ctx.workspacePath || "/workspace")} > /tmp/openwork-xlsx-attachments-mock.log 2>&1 < /dev/null &
echo $! > /tmp/openwork-xlsx-attachments-mock.pid
for _ in $(seq 1 80); do
  if curl -sf http://127.0.0.1:${MOCK_PORT}/health >/tmp/openwork-xlsx-attachments-health.json; then
    cat /tmp/openwork-xlsx-attachments-health.json
    exit 0
  fi
  sleep 0.25
done
cat /tmp/openwork-xlsx-attachments-mock.log >&2
exit 1
`).trim();
}

function stopMockProvider(ctx) {
  return runInSandbox(ctx, `
set -uo pipefail
curl -sf --connect-timeout 1 --max-time 2 -X POST http://127.0.0.1:${MOCK_PORT}/shutdown >/dev/null 2>&1 || true
if [ -s /tmp/openwork-xlsx-attachments-mock.pid ]; then
  pid="$(cat /tmp/openwork-xlsx-attachments-mock.pid 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" >/dev/null 2>&1; then
    kill "$pid" >/dev/null 2>&1 || true
  fi
fi
rm -f /tmp/openwork-xlsx-attachments-mock.pid
printf 'mock stopped\n'
`, 30_000).trim();
}

function proofFromSandbox(ctx) {
  return JSON.parse(runInSandbox(ctx, `curl -sf http://127.0.0.1:${MOCK_PORT}/proof`, 30_000));
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
  await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000, label: "control API after language reload" });
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

async function serverShell(ctx, path, init = {}) {
  const auth = await ctx.eval(`JSON.stringify({ port: localStorage.getItem("openwork.server.port"), token: localStorage.getItem("openwork.server.token") })`);
  const { port, token } = JSON.parse(auth);
  ctx.assert(Boolean(port && token), "missing server port/token");
  const method = init.method || "GET";
  const body = init.body === undefined ? "" : JSON.stringify(init.body);
  return runInSandbox(ctx, `
set -euo pipefail
url=${shellQuote(`http://127.0.0.1:${port}${path}`)}
body=${shellQuote(body)}
if [ -n "$body" ]; then
  curl -sf --max-time 120 -X ${shellQuote(method)} -H ${shellQuote(`Authorization: Bearer ${token}`)} -H 'Content-Type: application/json' --data "$body" "$url"
else
  curl -sf --max-time 120 -X ${shellQuote(method)} -H ${shellQuote(`Authorization: Bearer ${token}`)} -H 'Content-Type: application/json' "$url"
fi
`, 150_000);
}

async function loadWorkspacePath(ctx) {
  const payload = await serverJson(ctx, "/workspaces");
  const workspaces = Array.isArray(payload) ? payload : payload?.items ?? payload?.workspaces ?? [];
  const workspace = workspaces.find((item) => item?.id === ctx.workspaceId);
  ctx.workspacePath = typeof workspace?.path === "string" ? workspace.path : "";
  ctx.assert(Boolean(ctx.workspacePath), `Could not determine workspace path for ${ctx.workspaceId}`);
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
            name: "XLSX Attachments Mock",
            options: { baseURL, apiKey: "sk-openwork-xlsx-attachments-eval" },
            models: {
              [MODEL_ID]: {
                name: "Spreadsheet attachment mock",
                attachment: true,
                modalities: { input: ["text", "image", "pdf"], output: ["text"] },
              },
            },
          },
        },
      },
    },
  });
  await serverShell(ctx, `/workspace/${encodeURIComponent(ctx.workspaceId)}/engine/reload`, { method: "POST" });
  await ctx.eval(`(() => {
    const prefsRaw = localStorage.getItem("openwork.preferences");
    let prefs = {};
    try { prefs = prefsRaw ? JSON.parse(prefsRaw) : {}; } catch { prefs = {}; }
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
  ctx.output("XLSX mock provider", JSON.stringify({ provider: PROVIDER_ID, model: MODEL_ID, baseURL }, null, 2));
}

async function createFreshSession(ctx) {
  await ctx.waitFor(`window.__openworkControl.listActions().some((item) => item.id === "session.create_task" && !item.disabled)`, { timeoutMs: 60_000, label: "session.create_task enabled" });
  await ctx.control("session.create_task");
  await ctx.waitFor(`location.hash.includes("/session/")`, { timeoutMs: 60_000, label: "fresh session route" });
  const state = await appRouteState(ctx);
  ctx.workspaceId = state.workspaceId;
  ctx.sessionId = state.sessionId;
  ctx.assert(Boolean(ctx.workspaceId && ctx.sessionId), `Missing session route info: ${JSON.stringify(state)}`);
  await ctx.waitFor(`Boolean(document.querySelector('input[type="file"][multiple]'))`, { timeoutMs: 30_000, label: "composer file input" });
}

async function assertMockSelected(ctx) {
  const selected = await ctx.waitFor(`(() => {
    const button = Array.from(document.querySelectorAll("button")).find((item) => item.getAttribute("aria-label") === "Change model");
    const text = button && button.textContent ? button.textContent : "";
    return text.includes("Spreadsheet attachment mock") ? text : null;
  })()`, { timeoutMs: 60_000, label: "visible Spreadsheet mock selected model" });
  record(ctx, selected.includes("Spreadsheet attachment mock"), "Visible selected model is Spreadsheet attachment mock", selected);
}

async function attachXlsxFile(ctx) {
  return ctx.eval(
    `(() => {
      const input = document.querySelector('input[type="file"][multiple]');
      if (!(input instanceof HTMLInputElement)) return { ok: false, reason: "file input not found" };
      const binary = atob(${JSON.stringify(XLSX_FIXTURE.dataBase64)});
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], ${JSON.stringify(XLSX_FILENAME)}, { type: "application/octet-stream", lastModified: 1767225600000 }));
      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, files: Array.from(transfer.files).map((file) => ({ name: file.name, type: file.type, size: file.size })) };
    })()`,
  );
}

async function dismissOpenWorkModelsModal(ctx) {
  const result = await ctx.eval(`(() => {
    const dialog = Array.from(document.querySelectorAll('[role="dialog"], [data-slot="dialog-content"], [data-radix-dialog-content]')).find((item) => (item.textContent || "").includes("OpenWork Models"));
    if (!dialog) return { dismissed: false };
    const button = Array.from(dialog.querySelectorAll("button")).find((item) => (item.textContent || "").trim().includes("Continue without OpenWork Models") || item.getAttribute("aria-label") === "Close");
    if (!button) return { dismissed: false };
    button.click();
    return { dismissed: true };
  })()`);
  if (!result?.dismissed) return;
  await ctx.waitFor(`!Array.from(document.querySelectorAll('[role="dialog"], [data-slot="dialog-content"], [data-radix-dialog-content]')).some((item) => (item.textContent || "").includes("OpenWork Models"))`, { timeoutMs: 10_000, label: "OpenWork Models modal dismissed" });
}

function sentXlsxCardExpr() {
  return `(() => {
    const buttons = Array.from(document.querySelectorAll("button"));
    const button = buttons.find((item) => item.getAttribute("aria-label") === "Download " + ${JSON.stringify(XLSX_FILENAME)});
    const card = button ? button.closest("div") : null;
    const text = card && card.textContent ? card.textContent : "";
    return button && text.includes(${JSON.stringify(XLSX_FILENAME)}) && text.includes("XLSX") && text.includes("Download") ? { ok: true } : null;
  })()`;
}

async function clickDownloadButtonAndVerifySha(ctx, { buttonLabel, filename, expectedSha, assertion }) {
  runInSandbox(ctx, `rm -rf ${shellQuote(DOWNLOAD_DIR)} && mkdir -p ${shellQuote(DOWNLOAD_DIR)}`, 30_000);
  await ctx.client.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: DOWNLOAD_DIR }).catch(async () => {
    await ctx.client.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: DOWNLOAD_DIR });
  });
  const clicked = await ctx.eval(`(() => {
    const buttons = Array.from(document.querySelectorAll("button")).filter((item) => item.getAttribute("aria-label") === ${JSON.stringify(buttonLabel)} && !item.disabled);
    if (buttons.length !== 1) return { ok: false, count: buttons.length };
    buttons[0].scrollIntoView({ block: "center", inline: "center" });
    buttons[0].click();
    return { ok: true, count: 1 };
  })()`);
  ctx.assert(clicked?.ok, `Expected exactly one enabled ${buttonLabel} button, found ${clicked?.count ?? "unknown"}`);
  const output = runInSandbox(ctx, `
set -euo pipefail
path=${shellQuote(`${DOWNLOAD_DIR}/${filename}`)}
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

function collectFileParts(value, out = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectFileParts(item, out);
    return out;
  }
  if (!isRecord(value)) return out;
  const filename = stringField(value, ["filename", "fileName", "name"]);
  if (stringField(value, ["type"]) === "file" || filename === XLSX_FILENAME) out.push(value);
  for (const item of Object.values(value)) collectFileParts(item, out);
  return out;
}

function dataUrlDetails(value) {
  if (typeof value !== "string") return null;
  const match = /^data:([^;,]+)?(?:;[^,]*)?;base64,([A-Za-z0-9+/=\s]+)$/i.exec(value);
  if (!match) return null;
  const bytes = Buffer.from(match[2].replace(/\s+/g, ""), "base64");
  return { mime: (match[1] || "application/octet-stream").trim().toLowerCase(), sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.byteLength };
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

function workspaceRelativePath(root, target) {
  const relativePath = relative(resolve(root), resolve(target));
  const outside = relativePath === ".." || relativePath.startsWith("../") || relativePath.startsWith("..\\");
  return relativePath && !outside ? relativePath : "";
}

function hashWorkspaceFile(ctx, filePath) {
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
if (!relativePath || outside || isAbsolute(relativePath)) throw new Error("attachment path is outside workspace: " + target);
const bytes = readFileSync(target);
process.stdout.write(JSON.stringify({ relativePath, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") }));
EOF
`, 30_000).trim();
  return JSON.parse(raw);
}

function assertPersistedOriginalXlsx(ctx, messages) {
  const candidates = collectFileParts(messages).filter((part) => stringField(part, ["filename", "fileName", "name"]) === XLSX_FILENAME);
  const expectedUrl = `data:${XLSX_FIXTURE.mime};base64,${XLSX_FIXTURE.dataBase64}`;
  const found = candidates.find((part) => stringField(part, ["url"]) === expectedUrl) || candidates[0];
  record(ctx, Boolean(found), "Session read API retained the original XLSX FilePart", JSON.stringify({ candidates: candidates.length }));
  if (!found) return;
  const dataUrl = findDataUrlDetails(found);
  record(ctx, stringField(found, ["mime", "mimeType", "mediaType", "contentType"]).toLowerCase() === XLSX_FIXTURE.mime, "Persisted XLSX MIME is canonical");
  record(ctx, stringField(found, ["url"]) === expectedUrl, "Persisted XLSX FilePart URL is the exact canonical data URL");
  record(ctx, dataUrl?.sha256 === XLSX_FIXTURE.sha256, "Persisted XLSX data URL sha256 matches original bytes", dataUrl?.sha256 || "missing");
}

function assertWorkspaceAttachmentPathNote(ctx, messages) {
  const text = collectStrings(messages).filter((item) => item.includes(".opencode/openwork/inbox/chat-attachments/") || item.includes("Attached files were copied into this worker workspace")).join("\n");
  const line = text.split(/\r?\n/).find((item) => item.includes(XLSX_FILENAME)) || "";
  const path = /\.opencode\/openwork\/inbox\/chat-attachments\/[^\s)]*RevenueWorkbook\.xlsx/.exec(line)?.[0] ?? "";
  const url = /file:\/\/[^\s)]+/i.exec(line)?.[0] ?? "";
  record(ctx, Boolean(path), "Submitted XLSX path note includes a workspace-local inbox path", line || text.slice(0, 1000));
  record(ctx, Boolean(url), "Submitted XLSX path note includes a file: URL", line || text.slice(0, 1000));
  const filePath = url ? fileURLToPath(url) : "";
  record(ctx, workspaceRelativePath(ctx.workspacePath, filePath) === path, "Submitted XLSX file: URL resolves to the noted workspace path", JSON.stringify({ filePath, path }));
  const hash = hashWorkspaceFile(ctx, filePath);
  record(ctx, hash.sha256 === XLSX_FIXTURE.sha256, "Workspace XLSX copy sha256 matches the fixture exactly", JSON.stringify(hash));
  record(ctx, hash.bytes === XLSX_FIXTURE.size, "Workspace XLSX copy size matches the fixture exactly", JSON.stringify(hash));
}

function resetXlsxArtifact(ctx) {
  runInSandbox(ctx, `rm -f ${shellQuote(`${ctx.workspacePath}/${ARTIFACT_PATH}`)}`, 30_000);
}

function xlsxArtifactHash(ctx) {
  return runInSandbox(ctx, `
set -euo pipefail
path=${shellQuote(`${ctx.workspacePath}/${ARTIFACT_PATH}`)}
test -f "$path"
node - "$path" <<'EOF'
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
process.stdout.write(createHash("sha256").update(readFileSync(process.argv[2])).digest("hex"));
EOF
`, 30_000).trim();
}

async function waitForFinalResponse(ctx) {
  await ctx.waitFor(`(() => {
    const text = document.body.innerText;
    return text.includes(${JSON.stringify(XLSX_SENTINEL)})
      && text.includes("Northstar Revenue")
      && text.includes("SUM(C2:C3)")
      && text.includes("$#,##0.00")
      && text.includes(${JSON.stringify(ARTIFACT_PATH)});
  })()`, { timeoutMs: 120_000, label: "final assistant response with XLSX facts" });
}

export default {
  id: FLOW_ID,
  title: "Session composer safely normalizes valid Excel XLSX attachments through the real model boundary",
  kind: "user-facing",
  precondition: async (ctx) => {
    await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000, label: "control API" });
    const serverExited = await ctx.eval(`document.body.innerText.includes("OpenCode server exited")`);
    if (serverExited) {
      await ctx.eval("location.reload()");
      await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000, label: "control API after server-error reload" });
    }
    const state = await ctx.waitFor(`(() => {
      const control = window.__openworkControl;
      const route = control.snapshot().route;
      if (route.startsWith("/welcome") || route.startsWith("/signin")) return "blocked";
      if (document.body.innerText.includes("OpenCode server exited")) return "server-exited";
      const action = control.listActions().find((item) => item.id === "session.create_task");
      if (action && !action.disabled) return "ready";
      return null;
    })()`, { timeoutMs: 30_000, label: "session.create_task enabled (or welcome/signin)" });
    if (state === "server-exited") return "OpenCode server exited before the flow could create a task.";
    return state === "blocked" ? "Profile is not onboarded (welcome/signin); XLSX attachment flow requires a workspace." : null;
  },
  steps: [
    {
      name: "Attach an XLSX workbook",
      run: async (ctx) => {
        await ctx.prove("The real composer accepts a generic-MIME .xlsx workbook without an unsupported-format warning", {
          voiceover: vo[0],
          action: async () => {
            await forceEnglish(ctx);
            const state = await appRouteState(ctx);
            ctx.assert(Boolean(state.workspaceId), `Could not determine workspace id from ${state.hash}`);
            ctx.workspaceId = state.workspaceId;
            await loadWorkspacePath(ctx);
            ctx.output("XLSX mock health", startMockProvider(ctx));
            await configureMockProvider(ctx);
            await ctx.eval("location.reload()");
            await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000, label: "control API after provider reload" });
            await createFreshSession(ctx);
            await assertMockSelected(ctx);
            const attached = await attachXlsxFile(ctx);
            ctx.assert(attached?.ok, `Could not attach XLSX file: ${attached?.reason ?? "unknown"}`);
            await ctx.control("composer.set_text", { text: PROMPT });
            await ctx.waitFor(`document.body.innerText.includes(${JSON.stringify(XLSX_FILENAME)}) && document.body.innerText.includes(${JSON.stringify(PROMPT)})`, { timeoutMs: 30_000, label: "XLSX chip and prompt" });
          },
          assert: async () => {
            await ctx.expectText(XLSX_FILENAME);
            await ctx.expectText("Run task");
            await ctx.expectNoText("has a format the model can't read");
          },
          screenshot: { name: "xlsx-attached-composer", requireText: [XLSX_FILENAME, "Run task"], rejectText: ["has a format the model can't read"], hashIncludes: "/session/" },
        });
      },
    },
    {
      name: "Sent XLSX card is downloadable",
      run: async (ctx) => {
        await ctx.prove("After sending, the workbook renders as an XLSX file card and its Download action saves the exact original bytes", {
          voiceover: vo[1],
          action: async () => {
            resetXlsxArtifact(ctx);
            await ctx.control("composer.send");
            await ctx.waitFor(sentXlsxCardExpr(), { timeoutMs: 45_000, label: "sent XLSX card with Download action" });
            await dismissOpenWorkModelsModal(ctx);
            await clickDownloadButtonAndVerifySha(ctx, {
              buttonLabel: `Download ${XLSX_FILENAME}`,
              filename: XLSX_FILENAME,
              expectedSha: XLSX_FIXTURE.sha256,
              assertion: `Sent attachment card Download for ${XLSX_FILENAME} saves the exact expected sha256`,
            });
          },
          assert: async () => {
            await ctx.expectText(XLSX_FILENAME);
            await ctx.expectText("XLSX");
            await ctx.expectText("Download");
          },
          screenshot: { name: "xlsx-sent-card-downloadable", requireText: [XLSX_FILENAME, "XLSX", "Download"], hashIncludes: "/session/" },
        });
      },
    },
    {
      name: "Provider sees structured XLSX text and exact workspace bytes",
      run: async (ctx) => {
        await ctx.prove("The provider receives bounded structured spreadsheet text while exact original XLSX bytes stay in workspace-safe paths", {
          voiceover: vo[2],
          action: async () => {
            const proof = await pollProof(
              ctx,
              (item) => item.providerReceipt && item.normalizedTextOnly && item.exactHashes && item.exactMimes && item.materializedPaths && item.sentinelsExtracted && item.toolCallCompleted && item.finalResponse,
              120_000,
              "normalized XLSX provider text, materialized hash, completed tool call, and final response",
            );
            ctx.output("XLSX mock proof after send", JSON.stringify(proof, null, 2));
            record(ctx, proof.normalizedTextOnly && proof.payloadCount === 0 && proof.officeFileMarkers === 0 && !proof.rawOfficeBinaryLeak, "Provider request contains normalized XLSX text only, with no raw spreadsheet binary or file media", JSON.stringify({ payloadCount: proof.payloadCount, officeFileMarkers: proof.officeFileMarkers, rawOfficeBinaryLeak: proof.rawOfficeBinaryLeak }));
            record(ctx, proof.sentinelsExtracted, "Provider proof found cell values, formula, number format, and merged range in the structured XLSX text", JSON.stringify(proof.attachments));
            record(ctx, xlsxArtifactHash(ctx) === XLSX_FIXTURE.sha256, "Workspace XLSX artifact was written from exact materialized bytes");
            const messages = await sessionMessages(ctx);
            assertPersistedOriginalXlsx(ctx, messages);
            assertWorkspaceAttachmentPathNote(ctx, messages);
          },
          assert: async () => {
            await ctx.expectText(XLSX_FILENAME);
            await ctx.expectText("XLSX");
          },
          screenshot: { name: "xlsx-normalized-provider-proof", requireText: [XLSX_FILENAME, "XLSX"], hashIncludes: "/session/" },
        });
      },
    },
    {
      name: "Assistant summarizes workbook contents",
      run: async (ctx) => {
        await ctx.prove("The assistant summarizes the workbook's sheet values, formula, number format, merge range, and copied artifact", {
          voiceover: vo[3],
          action: async () => {
            await waitForFinalResponse(ctx);
            await dismissOpenWorkModelsModal(ctx);
            await ctx.control("session.scroll_bottom");
          },
          assert: async () => {
            await ctx.expectText(XLSX_SENTINEL);
            await ctx.expectText("Northstar Revenue");
            await ctx.expectText("SUM(C2:C3)");
            await ctx.expectText(ARTIFACT_PATH);
          },
          screenshot: { name: "xlsx-final-summary", requireText: [XLSX_SENTINEL, "Northstar Revenue", "SUM(C2:C3)", ARTIFACT_PATH], hashIncludes: "/session/" },
        });
      },
    },
    {
      name: "Reloaded XLSX session can continue",
      run: async (ctx) => {
        await ctx.prove("Reloading the session keeps spreadsheet history safe, and a follow-up message succeeds without provider errors", {
          voiceover: vo[4],
          action: async () => {
            await ctx.eval("location.reload()");
            await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000, label: "control API after session reload" });
            await ctx.navigateHash(`/workspace/${ctx.workspaceId}/session/${ctx.sessionId}`);
            await ctx.waitFor(sentXlsxCardExpr(), { timeoutMs: 45_000, label: "restored XLSX sent card" });
            await ctx.control("composer.set_text", { text: FOLLOW_UP });
            await ctx.control("composer.send");
            const replayProof = await pollProof(ctx, (item) => item.replayResponse && item.replayOfficeHistoryOk && item.replay?.normalizedTextOnly, 90_000, "successful replay follow-up with normalized XLSX history");
            ctx.output("XLSX mock proof after replay", JSON.stringify(replayProof, null, 2));
            await ctx.waitFor(`document.body.innerText.includes("Replay succeeded after reopening the session")`, { timeoutMs: 60_000, label: "replay success assistant response" });
            await dismissOpenWorkModelsModal(ctx);
          },
          assert: async () => {
            await ctx.expectText(XLSX_FILENAME);
            await ctx.expectText("Download");
            await ctx.expectText("Replay succeeded after reopening the session");
          },
          screenshot: { name: "xlsx-reopened-session-safe", requireText: [XLSX_FILENAME, "Download", "Replay succeeded after reopening the session"], hashIncludes: "/session/" },
        });
      },
    },
    {
      name: "Stop XLSX mock provider",
      run: async (ctx) => {
        ctx.output("XLSX mock shutdown", stopMockProvider(ctx));
      },
    },
  ],
};
