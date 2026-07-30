import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  clearDenWebBuildCache,
  denEvalEnvironment,
  denSeedNodeArgs,
  nativeMysqlServerArgs,
  nativeMysqlSocketArgs,
} from "./den-stack.ts";

test("native MariaDB explicitly permits root-owned Daytona runtimes", () => {
  assert(nativeMysqlServerArgs(true).includes("--user=root"));
  assert(!nativeMysqlServerArgs(false).includes("--user=root"));
});

test("native MariaDB supports fresh and resumed socket authentication", () => {
  assert(!nativeMysqlSocketArgs(false).some((arg) => arg.startsWith("-p")));
  assert(nativeMysqlSocketArgs(true).includes("-ppassword"));
});

test("demo-org seed resolves development exports without package builds", () => {
  assert.deepEqual(denSeedNodeArgs(), [
    "--conditions=development",
    "--import",
    "tsx",
    "scripts/seed-demo-org.ts",
  ]);
});

test("Den evaluator explicitly permits the isolated demo signup", () => {
  assert.equal(
    denEvalEnvironment().DEN_SINGLE_ORG_ALLOW_PUBLIC_SIGNUP,
    "true",
  );
});

test("Den evaluator threads orgMode only when requested", () => {
  const defaultEnv = denEvalEnvironment();
  const multiOrgEnv = denEvalEnvironment({ orgMode: "multi_org" });

  assert.equal(defaultEnv.DEN_ORG_MODE, undefined);
  assert.equal(multiOrgEnv.DEN_ORG_MODE, "multi_org");
  assert.equal(multiOrgEnv.PORT, defaultEnv.PORT);
});

test("Den evaluator trusts both loopback spellings used by the proof browser", () => {
  const trustedOrigins = denEvalEnvironment()
    .DEN_BETTER_AUTH_TRUSTED_ORIGINS?.split(",");

  assert(trustedOrigins?.includes("http://localhost:3005"));
  assert(trustedOrigins?.includes("http://127.0.0.1:3005"));
});

test("Den Web startup discards generated output from a reusable image", async () => {
  const denWebRoot = await mkdtemp(join(tmpdir(), "openwork-den-web-"));
  const staleManifest = join(denWebRoot, ".next", "server", "app-paths-manifest.json");

  try {
    await mkdir(join(denWebRoot, ".next", "server"), { recursive: true });
    await writeFile(staleManifest, "{}");

    await clearDenWebBuildCache(denWebRoot);

    await assert.rejects(access(staleManifest));
  } finally {
    await rm(denWebRoot, { recursive: true, force: true });
  }
});
