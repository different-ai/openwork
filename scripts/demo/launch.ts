#!/usr/bin/env node
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { demoStage, demoFlags, parseDemoOptions, guardDemoBudget } from "../../worlds/lib/demo-options.ts";
import { demoRootDir } from "../../worlds/lib/demo-output.ts";
import { launchDemo, manageDemo } from "../../worlds/lib/demo-launcher.ts";
import type { DemoProvider } from "../../worlds/lib/demo-launcher.ts";
import { readReviewedDemoSnapshot } from "../../worlds/lib/demo-snapshot.ts";

const usage = `Demo desktops (operator-only; no org seeding or sign-in)
  pnpm demo:desktops plan --snapshot demo-desktop-<reviewed-name>
  pnpm demo:desktops up --stage <new-name> --snapshot demo-desktop-<reviewed-name> [--seats demo,practice,backup] [--lifetime 1440] [--timezone America/Los_Angeles] [--budget-usd 30]
  pnpm demo:desktops refresh --stage <name>
  pnpm demo:desktops down --stage <name>
Viewer links are written only to ~/.openwork/demos/<stage>/<seat>/control.json.
plan is offline. up/refresh/down require explicit operator authorization and Daytona credentials.
`;

/** Load live adapters only after local allowlist and budget validation pass. */
async function liveProvider(): Promise<DemoProvider> {
  const provider = await import("../../worlds/lib/demo-provider.ts");
  const snapshot = await import("../../worlds/lib/demo-snapshot.ts");
  return {
    async review(name) {
      const expected = await readReviewedDemoSnapshot(name);
      snapshot.verifyDemoSnapshot(name, expected, await snapshot.getRawDemoSnapshot(snapshot.demoDaytonaApi(), name));
      return expected;
    },
    async create(name, expected, lifetime) {
      const id = await provider.createDemoSandbox(name, expected.id, lifetime);
      const info: unknown = JSON.parse(await provider.demoCli(["info", id, "-f", "json"], "Verify demo resources"));
      if (!snapshot.isRecord(info) || info.id !== id || info.name !== name || info.public !== false
        || info.cpu !== snapshot.DEMO_CPU || info.memory !== snapshot.DEMO_MEMORY || info.disk !== expected.diskGiB) {
        throw new Error("Created demo sandbox did not match reviewed resources and identity.");
      }
      return id;
    },
    async prepare(id, timezone) {
      await provider.demoSandboxInfo(id);
      await provider.waitForDemoGuest(id);
      if (timezone) await provider.demoGuest(id, `set -eu
zone='/usr/share/zoneinfo/${timezone}'
test -f "$zone"
sudo ln -snf "$zone" /etc/localtime
printf '%s\\n' '${timezone}' | sudo tee /etc/timezone >/dev/null`, "Set demo timezone");
      await provider.demoGuest(id, '"$HOME/demo/app-control.sh"', "Start packaged demo desktop");
      if (!await provider.demoCdpReachable(id)) throw new Error("Guest CDP is unavailable.");
    },
    viewer: provider.mintDemoViewer,
    remove: provider.deleteDemoSandbox,
  };
}

export async function main(argv: readonly string[]) {
  const [action, ...rest] = argv;
  if (!action || action === "--help") { console.log(usage); return; }
  if (action === "plan") {
    const options = parseDemoOptions(rest);
    const snapshot = await readReviewedDemoSnapshot(options.snapshot);
    console.log(JSON.stringify({ seats: options.seats, source: snapshot.source, snapshotId: snapshot.id,
      lifetimeMinutes: options.lifetime, infrastructureEstimateUsd: guardDemoBudget(options, snapshot.diskGiB) }, null, 2));
    return;
  }
  if (action !== "up" && action !== "refresh" && action !== "down") throw new Error("Use plan, up, refresh or down.");
  const stageIndex = rest.indexOf("--stage");
  if (stageIndex < 0 || !rest[stageIndex + 1]) throw new Error("Pass --stage <name>.");
  const stage = demoStage(rest[stageIndex + 1]);
  const flags = [...rest.slice(0, stageIndex), ...rest.slice(stageIndex + 2)];
  if (action === "up") {
    const options = parseDemoOptions(flags);
    guardDemoBudget(options, (await readReviewedDemoSnapshot(options.snapshot)).diskGiB);
  } else { demoFlags(flags, []); }
  const dir = join(await demoRootDir(action === "up"), stage);
  const provider = await liveProvider();
  const result = action === "up" ? await launchDemo(dir, flags, provider) : await manageDemo(dir, action, provider);
  console.log(JSON.stringify(result));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(() => {
    // Errors from libraries or providers can echo bearer URLs or command arguments.
    console.error("Demo command failed. No provider diagnostics or viewer links logged. Check scripts/demo/README.md and private receipts; retry down if a launch was attempted.");
    process.exitCode = 1;
  });
}
