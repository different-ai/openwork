export const summary = "Workbot with Den sign-in and the headless runner: the seeded Acme org, Workbot turned on.";
export const supportedTargets = ["local/host", "daytona/linux", "freestyle/linux"];

import { hold } from "../packages/world/src/hold.ts";
import { output, secret } from "../packages/world/src/outputs.ts";
import { resolvePlace } from "../evals/packages/env/src/place.ts";
import { bootWorkbot, probeWorkbot, workbotOutputs } from "./lib/workbot.ts";

const NAME = "preview-workbot";

/**
 * Den (seeded Acme org, signed-in owner alex@acme.test), the headless runner and the Workbot app, wired as in
 * production: Workbot signs people in through Den's OAuth server and runs each conversation on the runner, which
 * reaches the person's apps through Den's MCP. The model is the deterministic Acme upstream. Every placement checks
 * the whole path before it reports ready: sign in through Den, send a message, get the runner's answer.
 */
export async function main(argv = process.argv.slice(2)): Promise<void> {
  await using stack = new AsyncDisposableStack();
  if (process.env.OPENWORK_WORLD_PLACE === "freestyle") {
    const { parseAppWebOptions } = await import("./lib/app-web-options.ts");
    const { ensureSnapshot } = await import("../packages/freestyle/src/builder.ts");
    const { launchPreview, deletePreview } = await import("../packages/freestyle/src/index.ts");
    const { trackResource } = await import("../packages/world/src/ledger.ts");
    const options = parseAppWebOptions(argv, process.env);
    if (!options.ref) throw new Error("preview-workbot on Freestyle requires --source ref:dev or sha:<full-pushed-sha>.");
    await ensureSnapshot(options.ref, undefined, console.error, "workbot");
    const preview = await launchPreview({ gitSha: options.ref, lifetimeMinutes: options.lifetimeMinutes, world: "workbot" });
    stack.defer(() => deletePreview(preview.id));
    await trackResource({ kind: "freestyle-preview", id: preview.id, match: preview.id, label: NAME });
    await hold({ name: NAME, outputs: { ...preview.outputs, workbotUrl: secret(preview.url, { group: "URLs", note: "Opens Den and Workbot together; sign in as alex@acme.test" }), expires: preview.expiresAt, snapshotId: preview.snapshotId } });
    return;
  }
  const place = resolvePlace();
  if (place.kind === "daytona") {
    const { bootWorkbotOnDaytona } = await import("./lib/workbot.ts");
    await hold({ name: NAME, outputs: await bootWorkbotOnDaytona(stack, place) });
    return;
  }
  const world = await bootWorkbot(stack);
  const proof = await probeWorkbot(world);
  await hold({ name: NAME, outputs: workbotOutputs(world, { verified: output(`Signed in through Den and answered: ${proof.reply}`, { group: "Verification" }) }) });
}

if (import.meta.main) await main();
