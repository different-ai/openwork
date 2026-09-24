// Runs inside an ACME clone, started by scripts/verify-freestyle-preview.ts.
// Prints exactly one JSON line and always exits. Closing the CDP WebSocket waits
// for Chromium's close frame with no bound; when that frame never came, this
// process stayed alive after a successful chat until the host killed it, and CI
// reported a failure. The host's timeout is longer than DEADLINE_MS, so the host
// always learns which step failed. Output is step names and timings only.
const DEADLINE_MS = 240_000;
const started = Date.now();
const timings = {};
let step = "import";

function advance(next) {
  timings[step] = Date.now() - started;
  step = next;
}

function finish(result, code) {
  process.stdout.write(`${JSON.stringify({ ...result, step, timings })}\n`, () => process.exit(code));
}

setTimeout(() => finish({ ok: false, timedOut: true }, 1), DEADLINE_MS);

try {
  const { attachSurface } = await import("/workspace/evals/packages/cdp/src/index.ts");
  const { evalIn, readComposerState, sendComposerMessage, waitForAssistantReply } = await import("/workspace/evals/packages/behaviors/src/index.ts");
  advance("attach");
  const surface = await attachSurface({ name: "verify", kind: "electron", hostKind: "local", cdpUrl: "http://127.0.0.1:9825" }, { timeoutMs: 30_000 });
  advance("route");
  await evalIn(surface, () => { location.hash = location.hash.replace(/\?.*$/, ""); });
  advance("model");
  // A new conversation renders its model label after the route settles.
  let model = "";
  const modelDeadline = Date.now() + 60_000;
  while (Date.now() < modelDeadline) {
    model = (await readComposerState(surface)).selectedModelLabel;
    if (model && model !== "Select model") break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  advance("send");
  await sendComposerMessage(surface, "Verify the desktop gateway.");
  advance("reply");
  const reply = await waitForAssistantReply(surface, { timeoutMs: 90_000 });
  advance("done");
  finish({ ok: true, model, reply: reply.text }, 0);
} catch {
  finish({ ok: false, timedOut: false }, 1);
}
