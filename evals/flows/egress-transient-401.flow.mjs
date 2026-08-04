import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startEgressLab } from "../runner/labs/egress.mjs";
import { expectVerdictNames, productDiagnosticsPrecondition } from "../runner/journeys/diagnostics.mjs";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "egress-transient-401";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP_ROOT = join(ROOT, "apps", "app");
const COMMAND_TIMEOUT_MS = 45_000;
const vo = await loadVoiceoverParagraphs(FLOW_ID);

function runBun(script) {
  return new Promise((resolve) => {
    const child = spawn("bun", ["--conditions", "development", "--eval", script], { cwd: APP_ROOT, env: process.env });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
    }, COMMAND_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({ status: -1, stdout, stderr: `${stderr}\n${error.message}`.trim() });
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ status: typeof code === "number" ? code : -1, stdout, stderr });
    });
  });
}

function commandOutput(label, result) {
  return [
    `$ ${label}`,
    `cwd: ${APP_ROOT}`,
    `exit: ${String(result.status)}`,
    "--- stdout ---",
    result.stdout.trim(),
    "--- stderr ---",
    result.stderr.trim(),
  ].join("\n").trim();
}

function parseJsonStdout(result) {
  try {
    return JSON.parse(result.stdout.trim());
  } catch {
    return null;
  }
}

function transient401Script(baseUrl) {
  return `
    const storage = (() => {
      const map = new Map();
      return {
        get length() { return map.size; },
        clear() { map.clear(); },
        getItem(key) { return map.get(key) ?? null; },
        key(index) { return Array.from(map.keys())[index] ?? null; },
        removeItem(key) { map.delete(key); },
        setItem(key, value) { map.set(key, String(value)); },
      };
    })();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { localStorage: storage, dispatchEvent() { return true; } },
    });
    const { createDenClient, isDenSessionRevokedError } = await import("./src/app/lib/den.ts");
    const tokenKey = "openwork.den.authToken";
    window.localStorage.setItem(tokenKey, "tok_stored_transient_401");
    const client = createDenClient({ baseUrl: ${JSON.stringify(baseUrl)}, token: window.localStorage.getItem(tokenKey) });
    let first = null;
    try {
      await client.getSession();
      first = { threw: false };
    } catch (error) {
      const revoked = isDenSessionRevokedError(error);
      first = {
        threw: true,
        revoked,
        name: error?.name ?? null,
        status: error?.status ?? null,
        code: error?.code ?? null,
        message: error?.message ?? String(error),
      };
      if (revoked) window.localStorage.removeItem(tokenKey);
    }
    const tokenAfterFirst = window.localStorage.getItem(tokenKey);
    let second = null;
    try {
      second = { ok: true, user: await client.getSession() };
    } catch (error) {
      second = { ok: false, status: error?.status ?? null, code: error?.code ?? null, message: error?.message ?? String(error) };
    }
    console.log(JSON.stringify({ first, tokenAfterFirst, second, finalToken: window.localStorage.getItem(tokenKey) }));
  `;
}

function witness(ctx, condition, assertion, actual = "") {
  ctx.recordEvidence({ type: "assertion", status: condition ? "passed" : "failed", assertion, actual });
  ctx.assert(condition, assertion);
}

export default {
  id: FLOW_ID,
  title: "A transient proxy 401 does not wipe stored Den credentials",
  kind: "internal",
  requiresApp: false,
  precondition: (ctx) => productDiagnosticsPrecondition(ctx.env),
  steps: [
    {
      name: "Frame 1",
      run: async (ctx) => {
        let lab;
        let verdictLab;
        let result;
        await ctx.prove("A one-off foreign 401 is treated as unavailable, not revoked, and OpenWork product diagnostics report the recovered transient 401", {
          voiceover: vo[0],
          action: async () => {
            lab = await startEgressLab({ profile: "blip", blip: { route: "/api/den/v1/me", count: 1, status: 401, body: "" } });
            result = await runBun(transient401Script(lab.url));
            verdictLab = await startEgressLab({ profile: "blip", blip: { route: "/mcp/agent", count: 1, status: 401, body: "" } });
          },
          assert: async () => {
            try {
              const parsed = parseJsonStdout(result);
              ctx.output("Transient 401 token resilience probe", commandOutput("bun --eval <transient 401 Den client probe>", result));
              witness(ctx, result.status === 0, "the transient 401 probe script exits 0", commandOutput("bun --eval <transient 401 Den client probe>", result));
              witness(ctx, parsed?.first?.threw === true && parsed?.first?.status === 401 && parsed?.first?.code === "request_failed", "the first response is a foreign/proxy-shaped 401, not a Den revoked-session envelope", JSON.stringify(parsed));
              witness(ctx, parsed?.first?.revoked === false, "isDenSessionRevokedError rejects the proxy-shaped 401", JSON.stringify(parsed));
              witness(ctx, parsed?.tokenAfterFirst === "tok_stored_transient_401", "the stored token remains after the transient 401", JSON.stringify(parsed));
              witness(ctx, parsed?.second?.ok === true && parsed?.second?.user?.email === "lab@example.com", "the next request recovers with the same stored credential", JSON.stringify(parsed));
              witness(ctx, parsed?.finalToken === "tok_stored_transient_401", "the final token is still present", JSON.stringify(parsed));
              await expectVerdictNames(ctx, { lab: verdictLab, expect: "blip" });
            } finally {
              await lab?.stop();
              await verdictLab?.stop();
            }
          },
        });
      },
    },
  ],
};
