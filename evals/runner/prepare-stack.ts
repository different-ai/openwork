import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { deleteSandboxes, provisionDenSandbox, provisionDesktopSandbox } from "../packages/hosts/src/provision.ts";
import { shouldPrepareSuite, suiteWorkerCount } from "./stack-suite.ts";
import type { TestProject } from "vitest/node";

const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

export type StackPreparation =
  | { kind: "none" }
  | { kind: "local"; runtimePrepared: true; electronPrepared: true }
  | { kind: "daytona"; slots: { denSandbox: string; desktopSandbox: string }[] };

declare module "vitest" {
  export interface ProvidedContext {
    openworkStackPreparation: StackPreparation;
  }
}

async function run(command: string, args: string[], cwd = REPO_ROOT): Promise<void> {
  await execFileAsync(command, args, {
    cwd,
    env: process.env,
    maxBuffer: 32 * 1024 * 1024,
    timeout: 20 * 60 * 1_000,
  });
}

async function readable(path: string): Promise<boolean> {
  return access(path, constants.R_OK).then(() => true).catch(() => false);
}

async function prepareLocal(): Promise<StackPreparation> {
  console.error("[openwork/evals] preparing shared local Den and Electron runtime once...");
  const runtimeBuilds = [
    "@openwork/email",
    "@openwork/install-config",
    "@openwork/connect-link",
    "@openwork/enterprise-mcp-client",
    "@openwork/codemode",
    "@openwork/headless-threads",
  ].map((pkg) => run("pnpm", ["--filter", pkg, "build"]));
  await Promise.all(runtimeBuilds);
  await run("pnpm", ["--filter", "@openwork-ee/den-db", "build"]);

  await Promise.all([
    run("pnpm", ["--filter", "@openwork/ui", "build"]),
    run("pnpm", ["--filter", "@openwork-ee/utils", "build"]),
    run(process.execPath, [join(REPO_ROOT, "apps/desktop/scripts/prepare-sidecar.mjs"), "--force", "--outdir", join(REPO_ROOT, "apps/desktop/resources/sidecars")], join(REPO_ROOT, "apps/desktop")),
    run(process.execPath, [join(REPO_ROOT, "apps/desktop/scripts/prepare-computer-use-helper.mjs"), "--force", "--outdir", join(REPO_ROOT, "apps/desktop/resources/helpers")], join(REPO_ROOT, "apps/desktop")),
  ]);

  const nextEnvPath = join(REPO_ROOT, "ee/apps/den-web/next-env.d.ts");
  const hadNextEnv = await readable(nextEnvPath);
  const nextEnv = hadNextEnv ? await readFile(nextEnvPath) : null;
  try {
    await run("pnpm", ["--filter", "@openwork-ee/den-web", "build"]);
  } finally {
    if (nextEnv) await writeFile(nextEnvPath, nextEnv);
    else if (!hadNextEnv) await rm(nextEnvPath, { force: true });
  }
  await rm(join(REPO_ROOT, "ee/apps/den-web/.next/dev"), { recursive: true, force: true });
  return { kind: "local", runtimePrepared: true, electronPrepared: true };
}

async function prepareDaytona(argv: readonly string[]): Promise<{ preparation: StackPreparation; cleanup: () => Promise<void> }> {
  const workerCount = suiteWorkerCount(argv, process.env);
  const ref = process.env.OPENWORK_EVAL_REF?.trim() || process.env.GITHUB_SHA?.trim() || "dev";
  const created = new Set<string>();
  const log = (line: string): void => console.error(`[openwork/evals] ${line}`);
  try {
    const slots = await Promise.all(Array.from({ length: workerCount }, async (_, index) => {
      const [den, desktop] = await Promise.all([
        provisionDenSandbox({
          ref,
          bootstrapAdminEmail: process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test",
          log,
        }).then((result) => {
          if (result.created) created.add(result.sandbox);
          return result;
        }),
        provisionDesktopSandbox({ ref, name: `suite-${index + 1}`, log }).then((result) => {
          if (result.created) created.add(result.sandbox);
          return result;
        }),
      ]);
      return { denSandbox: den.sandbox, desktopSandbox: desktop.sandbox };
    }));
    console.error(`[openwork/evals] prepared ${slots.length} isolated Daytona worker slot${slots.length === 1 ? "" : "s"}.`);
    return {
      preparation: { kind: "daytona", slots },
      cleanup: async () => {
        await deleteSandboxes([...created], { log });
      },
    };
  } catch (error) {
    await deleteSandboxes([...created], { log }).catch(() => undefined);
    throw error;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  if (!shouldPrepareSuite(process.argv) || process.env.OPENWORK_EVAL_DEN_API_URL?.trim()) {
    project.provide("openworkStackPreparation", { kind: "none" });
    return async () => undefined;
  }
  if (process.env.OPENWORK_EVAL_DAYTONA?.trim() === "1") {
    const prepared = await prepareDaytona(process.argv);
    project.provide("openworkStackPreparation", prepared.preparation);
    return prepared.cleanup;
  }
  const preparation = await prepareLocal();
  project.provide("openworkStackPreparation", preparation);
  return async () => undefined;
}
