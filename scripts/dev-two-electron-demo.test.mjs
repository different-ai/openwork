import assert from "node:assert/strict";
import { access, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createDemoRun,
  demoEnv,
  resetDemoData,
  resolveDemoRoot
} from "./dev-two-electron-demo.mjs";

test("uses a non-production temporary demo root by default", () => {
  const root = resolveDemoRoot({});

  assert.equal(root, path.join(os.tmpdir(), "openwork-two-electron-demo"));
  assert.notEqual(root, path.join(os.homedir(), ".openwork"));
});

test("honors an explicit demo root", () => {
  assert.equal(
    resolveDemoRoot({
      OPENWORK_ELECTRON_DEMO_ROOT: " /tmp/openwork-custom-demo "
    }),
    "/tmp/openwork-custom-demo"
  );
});

test("creates fresh, independent folders for every demo launch", async context => {
  const testRoot = await mkdtemp(path.join(os.tmpdir(), "openwork-demo-test-"));
  context.after(() => rm(testRoot, { recursive: true, force: true }));

  const first = await createDemoRun(testRoot);
  const second = await createDemoRun(testRoot);

  assert.notEqual(first.runRoot, second.runRoot);
  assert.notEqual(first.admin.root, first.consumer.root);
  assert.equal(path.dirname(first.admin.root), first.runRoot);
  assert.equal(path.dirname(first.consumer.root), first.runRoot);

  for (const paths of [
    first.admin,
    first.consumer,
    second.admin,
    second.consumer
  ]) {
    assert.equal((await stat(paths.userDataDir)).isDirectory(), true);
    assert.equal((await stat(paths.dataDir)).isDirectory(), true);
  }
});

test("reset removes all prior demo runs from the configured root", async context => {
  const testRoot = await mkdtemp(
    path.join(os.tmpdir(), "openwork-demo-reset-test-")
  );
  context.after(() => rm(testRoot, { recursive: true, force: true }));
  const run = await createDemoRun(testRoot);

  await resetDemoData(testRoot);

  await assert.rejects(access(run.runRoot));
});

test("points each Electron instance at its own profile folders", async context => {
  const testRoot = await mkdtemp(
    path.join(os.tmpdir(), "openwork-demo-env-test-")
  );
  context.after(() => rm(testRoot, { recursive: true, force: true }));
  const run = await createDemoRun(testRoot);
  const profile = {
    appIdentifier: "com.example.demo",
    appName: "Demo"
  };

  const adminEnv = demoEnv(profile, run.admin, "5273", "9923");
  const consumerEnv = demoEnv(profile, run.consumer, "5274", "9924");

  assert.equal(adminEnv.OPENWORK_ELECTRON_USERDATA, run.admin.userDataDir);
  assert.equal(adminEnv.OPENWORK_DATA_DIR, run.admin.dataDir);
  assert.equal(
    consumerEnv.OPENWORK_ELECTRON_USERDATA,
    run.consumer.userDataDir
  );
  assert.equal(consumerEnv.OPENWORK_DATA_DIR, run.consumer.dataDir);
  assert.notEqual(
    adminEnv.OPENWORK_ELECTRON_USERDATA,
    consumerEnv.OPENWORK_ELECTRON_USERDATA
  );
  assert.notEqual(adminEnv.OPENWORK_DATA_DIR, consumerEnv.OPENWORK_DATA_DIR);
});
