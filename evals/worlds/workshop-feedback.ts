import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { allocateFreePort, browserScript, evaluateOnSurface, type Surface } from "@openwork/cdp";
import { startPlainWitness } from "../packages/labs/src/workshop-feedback.mjs";

/** Observe hydration only: SSR inputs can be visible before React owns their events. */
export async function waitForWorkshopFeedbackForm(surface: Surface) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const ready = await evaluateOnSurface(surface, browserScript(() => {
      const inputs = Array.from(document.querySelectorAll("input[required],textarea[required]"));
      return inputs.length === 3 && inputs.every((input) => Object.keys(input).some((key) => key.startsWith("__reactProps$")));
    }, []));
    if (ready) return;
    await delay(100);
  }
  throw new Error("The existing feedback form did not hydrate before trusted user input");
}

/** Real landing UI/API, with only its external Plain HTTP boundary redirected.
 * Call before seed.appWeb; pass feedbackUrl as VITE_OPENWORK_FEEDBACK_URL.
 * The caller must click the app feedback control, type the negative note and
 * submit through the rendered form. This helper never submits feedback.
 */
export async function startWorkshopFeedback(resources: AsyncDisposableStack, directory: string) {
  await mkdir(directory, { recursive: true });
  const token = `workshop-synthetic-${randomUUID()}`;
  const witness = resources.use(await startPlainWitness({ directory: join(directory, "provider"), token }));
  const cwd = fileURLToPath(new URL("../../ee/apps/landing/", import.meta.url));
  const require = createRequire(join(cwd, "package.json"));
  const next = require.resolve("next/dist/bin/next");
  const preload = new URL("../packages/labs/src/workshop-feedback-preload.mjs", import.meta.url).href;
  const port = await allocateFreePort();
  const origin = `http://127.0.0.1:${port}`;
  let logs = "", failure: Error | undefined;
  const child = spawn(process.execPath, ["--import", preload, next, "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd,
    env: { PATH: process.env.PATH, HOME: directory, NODE_ENV: "development", NEXT_TELEMETRY_DISABLED: "1", PLAIN_API_KEY: token, OPENWORK_WORKSHOP_PLAIN_ORIGIN: witness.origin, OPENWORK_WORKSHOP_PLAIN_TOKEN: token, LANDING_FORM_ALLOWED_ORIGINS: origin, VERCEL_ENV: "development", OPENWORK_DEV_MODE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.on("error", (error) => { failure = error; });
  const capture = (chunk: Buffer) => { logs = `${logs}${chunk.toString()}`.slice(-30_000); };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  resources.defer(async () => {
    await writeFile(join(directory, "landing.log"), logs.replaceAll(token, "[owned-token]"));
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
      child.kill("SIGTERM");
    });
  });
  const deadline = Date.now() + 120_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (failure || child.exitCode !== null) throw new Error(`Owned feedback landing failed: ${failure?.message ?? logs.replaceAll(token, "[owned-token]")}`);
    ready = await fetch(`${origin}/feedback`, { signal: AbortSignal.timeout(2000) }).then((response) => response.ok).catch(() => false);
    if (ready) break;
    await delay(300);
  }
  if (!ready) throw new Error(`Owned feedback form did not become ready: ${logs.replaceAll(token, "[owned-token]")}`);
  return {
    feedbackUrl: `${origin}/feedback`,
    /** Authenticated HTTP readback, independently re-read from persisted disk. */
    async read() {
      const response = await fetch(`${witness.origin}/operator/state`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`Plain operator read failed: ${response.status}`);
      const http = await response.json();
      const disk = await witness.read();
      if (JSON.stringify(http) !== JSON.stringify(disk)) throw new Error("Plain HTTP and persisted operator readback disagree");
      return disk;
    },
  };
}
