import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { expect, onTestFinished } from "vitest";
import { clickButton, control, createAndSelectWorkspace, evalIn, waitFor } from "@openwork/behaviors";
import { screenshot } from "@openwork/fraimz";
import { desktop } from "@openwork/hosts";
import { needs, test } from "@openwork/testkit";

const providerId = "attachment-upload-mock";
const modelId = "attachment-upload-model";
const reply = "attachment upload loading proof";
const attachmentName = "big-photo.png";
const appSpecsEnabled = process.env.OPENWORK_EVAL_APP_SPECS === "1";
const title = appSpecsEnabled
  ? "attaching an image shows its chip instantly and sends with a visible uploading state"
  : "attachment upload loading state skipped — needs: set OPENWORK_EVAL_APP_SPECS=1";

const repoRoot = resolve(import.meta.dirname, "../..");

/**
 * Boot the standalone openwork-server (the web/gateway posture) in
 * manual-approval mode with nobody answering approvals. This is the exact
 * configuration that used to park chat-attachment uploads for the whole
 * approval timeout and then fail them with 403 write_denied.
 */
async function startManualApprovalServer(approvalTimeoutMs: number) {
  const script = `
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { startServer } = await import("./src/server.ts");
    const root = mkdtempSync(join(tmpdir(), "openwork-attachment-spec-"));
    const server = await startServer({
      host: "127.0.0.1",
      port: 0,
      token: "owt_spec_token",
      hostToken: "owt_spec_host_token",
      approval: { mode: "manual", timeoutMs: ${approvalTimeoutMs} },
      corsOrigins: ["*"],
      workspaces: [{ id: "ws_spec", name: "Workspace", path: root, preset: "starter", workspaceType: "local" }],
      authorizedRoots: [root],
      readOnly: false,
      startedAt: Date.now(),
      tokenSource: "cli",
      hostTokenSource: "cli",
      logFormat: "pretty",
      logRequests: false,
    });
    console.log("SPEC_SERVER_PORT:" + server.port);
    setInterval(() => {}, 60_000);
  `;
  const child = spawn("bun", ["-e", script], {
    cwd: join(repoRoot, "apps", "server"),
    stdio: ["ignore", "pipe", "pipe"],
  });
  onTestFinished(() => {
    child.kill("SIGKILL");
  });
  const port = await new Promise<number>((resolvePort, reject) => {
    const timer = setTimeout(() => reject(new Error("Standalone openwork-server did not report a port within 30s.")), 30_000);
    let buffered = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffered += chunk;
      const match = buffered.match(/SPEC_SERVER_PORT:(\d+)/);
      if (match?.[1]) {
        clearTimeout(timer);
        resolvePort(Number(match[1]));
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Standalone openwork-server exited early (code ${code}): ${buffered.slice(0, 500)}`));
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn bun for the standalone server: ${error.message}`));
    });
  });
  return { base: `http://127.0.0.1:${port}`, token: "owt_spec_token" };
}

test.skipIf(!appSpecsEnabled)(title, async ({ evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_APP_SPECS"] });

  // ---------------------------------------------------------------------
  // Part 1 — gateway server contract: manual-approval mode must not park
  // chat-attachment inbox uploads, while other writes stay approval-gated.
  // ---------------------------------------------------------------------
  const approvalTimeoutMs = 3_000;
  const gateway = await startManualApprovalServer(approvalTimeoutMs);

  const uploadBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 9, 9, 9, 9]);
  const uploadForm = new FormData();
  uploadForm.append("file", new File([uploadBytes], "screenshot.png", { type: "image/png" }));
  const uploadStartedAt = Date.now();
  const uploadResponse = await fetch(
    `${gateway.base}/workspace/ws_spec/inbox?path=${encodeURIComponent("chat-attachments/s1/att-1-screenshot.png")}`,
    { method: "POST", headers: { Authorization: `Bearer ${gateway.token}` }, body: uploadForm },
  );
  const uploadElapsedMs = Date.now() - uploadStartedAt;
  expect(uploadResponse.status).toBe(200);
  expect(uploadElapsedMs).toBeLessThan(approvalTimeoutMs);
  evidence.fact(
    "A chat-attachment upload to a manual-approval gateway server succeeds immediately instead of parking on the approval queue",
    `POST /workspace/:id/inbox with a client token returned ${uploadResponse.status} in ${uploadElapsedMs}ms (approval timeout is ${approvalTimeoutMs}ms; before the fix this waited the full timeout and returned 403 write_denied).`,
    true,
  );

  const writeStartedAt = Date.now();
  const writeResponse = await fetch(`${gateway.base}/workspace/ws_spec/files/content`, {
    method: "POST",
    headers: { Authorization: `Bearer ${gateway.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ path: "notes/unapproved.md", content: "# should not land\n" }),
  });
  const writeElapsedMs = Date.now() - writeStartedAt;
  expect(writeResponse.status).toBe(403);
  expect(writeElapsedMs).toBeGreaterThanOrEqual(approvalTimeoutMs - 100);
  evidence.fact(
    "Ordinary workspace writes remain approval-gated: the inbox exemption is not a blanket approval bypass",
    `POST /workspace/:id/files/content with the same client token still parked and was denied with HTTP ${writeResponse.status} after ${writeElapsedMs}ms.`,
    true,
  );

  // ---------------------------------------------------------------------
  // Part 2 — composer UX: chip appears instantly, uploading state visible.
  // ---------------------------------------------------------------------
  const mock = createServer((request, response) => {
    const url = request.url ?? "";
    if (request.method === "GET" && url.startsWith("/v1/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: modelId, object: "model" }] }));
      return;
    }
    if (request.method === "POST" && (url.startsWith("/v1/chat/completions") || url.startsWith("/chat/completions"))) {
      request.resume();
      request.on("end", () => {
        const chunks = [
          { id: "chatcmpl-attachment-upload", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
          { id: "chatcmpl-attachment-upload", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: reply }, finish_reason: null }] },
          { id: "chatcmpl-attachment-upload", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ];
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
        response.write("data: [DONE]\n\n");
        response.end();
      });
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "not found" } }));
  });
  await new Promise<void>((resolveListen, reject) => {
    mock.once("error", reject);
    mock.listen(0, "127.0.0.1", resolveListen);
  });
  onTestFinished(async () => {
    await new Promise<void>((resolveClose, reject) => mock.close((error) => error ? reject(error) : resolveClose()));
  });
  const address = mock.address();
  if (!address || typeof address === "string") throw new Error("Mock provider did not bind a TCP port.");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;

  await using app = await desktop({ name: "attachment-upload-loading" });
  const workspace = await createAndSelectWorkspace(app, {
    path: `/tmp/openwork-attachment-upload-${Date.now()}`,
  });

  const configured = await evalIn(app, `(async () => {
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token");
    if (!port || !token) return "missing local server credentials";
    const request = async (path, init) => {
      const response = await fetch("http://127.0.0.1:" + port + path, {
        ...init,
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      });
      if (!response.ok) return path + " failed: " + response.status + " " + (await response.text()).slice(0, 500);
      return "ok";
    };
    const workspaceId = ${JSON.stringify(workspace.workspaceId)};
    const patched = await request("/workspace/" + encodeURIComponent(workspaceId) + "/config", {
      method: "PATCH",
      body: JSON.stringify({
        opencode: {
          provider: {
            [${JSON.stringify(providerId)}]: {
              npm: "@ai-sdk/openai-compatible",
              name: "Attachment upload mock",
              options: { baseURL: ${JSON.stringify(baseUrl)}, apiKey: "sk-attachment-upload" },
              models: {
                [${JSON.stringify(modelId)}]: { name: "Attachment upload model" },
              },
            },
          },
        },
      }),
    });
    if (patched !== "ok") return patched;
    const reloaded = await request("/workspace/" + encodeURIComponent(workspaceId) + "/engine/reload", { method: "POST" });
    if (reloaded !== "ok") return reloaded;
    const raw = localStorage.getItem("openwork.preferences");
    let preferences = {};
    try { preferences = raw ? JSON.parse(raw) : {}; } catch { preferences = {}; }
    if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) preferences = {};
    localStorage.setItem("openwork.preferences", JSON.stringify({
      ...preferences,
      defaultModel: { providerID: ${JSON.stringify(providerId)}, modelID: ${JSON.stringify(modelId)} },
      modelVariant: null,
      providerStepCompleted: true,
    }));
    localStorage.setItem("openwork.defaultModel", ${JSON.stringify(`${providerId}/${modelId}`)});
    localStorage.removeItem("openwork.sessionModels." + workspaceId);
    return "ok";
  })()`, { awaitPromise: true, timeoutMs: 30_000 });
  expect(configured).toBe("ok");

  // Reload so the renderer re-reads the mock provider preference before the
  // new session is created. Without this, the already-mounted model store can
  // keep the previous default model despite the localStorage update above.
  await evalIn(app, "location.reload(); true");
  await waitFor(app, "Boolean(window.__openworkControl)", {
    timeoutMs: 30_000,
    label: "app reloaded with attachment mock provider preference",
  });

  await control(app, "session.create_task");
  await waitFor(app, `Boolean(document.querySelector('[contenteditable="true"][data-lexical-editor="true"]'))`, {
    timeoutMs: 30_000,
    label: "new-task composer editor ready",
  });
  const focused = await evalIn(app, `(() => {
    const editor = document.querySelector('[contenteditable="true"][data-lexical-editor="true"]');
    if (!(editor instanceof HTMLElement)) return false;
    editor.focus();
    return true;
  })()`);
  expect(focused).toBe(true);
  await app.client.send("Input.insertText", { text: "Describe the attached image." });

  // Attach a >1.5MB image (random noise defeats PNG compression) through the
  // composer's hidden file input, and measure dispatch -> chip visibility.
  const attachResult = await evalIn(app, `(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 2400;
    canvas.height = 2400;
    const ctx = canvas.getContext("2d");
    if (!ctx) return "no canvas context";
    const image = ctx.createImageData(2400, 2400);
    for (let index = 0; index < image.data.length; index += 1) {
      image.data[index] = Math.floor(Math.random() * 256);
    }
    ctx.putImageData(image, 0, 0);
    const blob = await new Promise((resolveBlob) => canvas.toBlob(resolveBlob, "image/png"));
    if (!blob) return "no blob";
    const file = new File([blob], ${JSON.stringify(attachmentName)}, { type: "image/png" });
    const inputs = [...document.querySelectorAll('input[type="file"][multiple]')];
    const input = inputs.at(-1);
    if (!input) return "no composer file input";
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    const startedAt = performance.now();
    input.dispatchEvent(new Event("change", { bubbles: true }));
    const chip = await new Promise((resolveChip) => {
      const deadline = performance.now() + 5000;
      const poll = () => {
        const found = document.querySelector("[data-attachment-id]");
        if (found) return resolveChip(found);
        if (performance.now() > deadline) return resolveChip(null);
        requestAnimationFrame(poll);
      };
      poll();
    });
    if (!chip) return "chip never appeared";
    return JSON.stringify({
      fileBytes: file.size,
      elapsedMs: Math.round(performance.now() - startedAt),
      chipTitle: chip.getAttribute("title"),
      chipStatus: chip.getAttribute("data-attachment-status"),
    });
  })()`, { awaitPromise: true, timeoutMs: 60_000 });
  if (typeof attachResult !== "string" || !attachResult.startsWith("{")) {
    throw new Error(`Attaching the image failed: ${String(attachResult)}`);
  }
  const attach = JSON.parse(attachResult) as { fileBytes: number; elapsedMs: number; chipTitle: string | null; chipStatus: string | null };
  expect(attach.fileBytes).toBeGreaterThan(1_500_000);
  expect(attach.elapsedMs).toBeLessThan(2_000);
  // The chip keeps the original .png name: compression no longer runs before
  // the chip renders (the old attach path re-encoded to .jpg first, which is
  // exactly the silent dead time users saw).
  expect(attach.chipTitle).toBe(attachmentName);
  expect(attach.chipStatus).toBe("ready");
  evidence.fact(
    "Attaching a large image shows its composer chip instantly instead of blocking on compression",
    `A ${attach.fileBytes}-byte PNG showed its chip ${attach.elapsedMs}ms after the file input change event, still named ${attachmentName} (compression now happens at send time).`,
    true,
  );

  await screenshot(app);

  // Watch for the uploading overlay before clicking send, so even a fast
  // local upload cannot slip past the assertion.
  await evalIn(app, `(() => {
    window.__attachmentUploadingSeen = false;
    const record = () => {
      if (document.querySelector('[data-attachment-status="uploading"]')) {
        window.__attachmentUploadingSeen = true;
      }
    };
    const observer = new MutationObserver(record);
    observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["data-attachment-status"], childList: true });
    record();
    return "observing";
  })()`);

  await clickButton(app, "Run task", { timeoutMs: 30_000 });

  await waitFor(app, `window.__attachmentUploadingSeen === true`, {
    timeoutMs: 30_000,
    label: "attachment chip showed its uploading state during send",
  });
  evidence.fact(
    "The attachment chip shows a visible uploading state while the send is in flight",
    "A MutationObserver installed before composer.send recorded a chip with data-attachment-status=\"uploading\" — the send is no longer a silent hang.",
    true,
  );

  // The regression is the pre-model attachment handoff. Prove the submission
  // was accepted without depending on provider completion timing: the app
  // creates a real session route and clears the sent chip from the composer.
  // (The mock may still be generating when this bounded assertion completes.)
  await waitFor(app, `window.location.hash.includes("/session/ses_")`, {
    timeoutMs: 30_000,
    label: "attachment submission created a session",
  });
  const sessionId = await evalIn(app, `window.location.hash.split("/session/")[1]?.split(/[/?#]/)[0] ?? ""`);
  expect(typeof sessionId === "string" && sessionId.startsWith("ses_")).toBe(true);
  await waitFor(app, `!document.querySelector("[data-attachment-id]")`, {
    timeoutMs: 30_000,
    label: "composer cleared its attachment chips after the send completed",
  });
  const errorToastVisible = await evalIn(app, `Boolean(document.querySelector('[data-sonner-toast][data-type="error"]'))`);
  expect(errorToastVisible).toBe(false);
  evidence.fact(
    "The message with the attachment is accepted: a session is created, the composer clears, and no error toast appears",
    `The app created session ${sessionId}, cleared the attachment chip from the composer, and showed no error toast.`,
    true,
  );

  await screenshot(app);

  const stopEnabled = await evalIn(app, `window.__openworkControl.listActions().some((action) => action.id === "composer.stop" && !action.disabled)`);
  if (stopEnabled) await control(app, "composer.stop");
});
