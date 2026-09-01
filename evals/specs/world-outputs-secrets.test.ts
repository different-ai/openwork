import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { eventually, test } from "@openwork/testkit";
import {
  isProcessAlive,
  main,
  readScriptWorldSnapshot,
  type WorldCliOptions,
} from "@openwork/world";
import { MASK } from "../../packages/world/src/outputs.ts";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

function assertRecord(value: unknown): asserts value is Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
}

test("world outputs publish grouped credentials and mask secrets everywhere but the receipt", async ({ evidence }) => {
  const root = await mkdtemp(join(tmpdir(), "openwork-world-outputs-secrets-"));
  const worldsDirectory = join(root, "worlds");
  const snapshotDirectory = join(root, ".worlds", "scripts");
  const vaultPath = join(worldsDirectory, "vault-world.ts");
  const plainPath = join(worldsDirectory, "plain-world.ts");
  const vaultReceiptPath = join(snapshotDirectory, "vault-world--v.json");
  const vaultLogPath = join(snapshotDirectory, "vault-world--v.log");
  const vaultEventsPath = join(snapshotDirectory, "vault-world--v.events.jsonl");
  const plainReceiptPath = join(snapshotDirectory, "plain-world--v.json");
  const plainLogPath = join(snapshotDirectory, "plain-world--v.log");
  const recipeUrl = pathToFileURL(join(REPO_ROOT, "evals", "packages", "env", "src", "recipe.ts")).href;
  const previousSnapshotDirectory = process.env.OPENWORK_WORLD_SNAPSHOT_DIR;
  const launchedPids = new Set<number>();
  let printed: string[] = [];
  let narrated: string[] = [];
  const maskedLines = [
    "url  http://127.0.0.1:1",
    "Accounts",
    "  adminEmail     alex@acme.test  org owner",
    `  adminPassword  ${MASK}`,
    "Keys",
    `  apiKey  ${MASK}  master`,
  ];
  const revealedLines = [
    "url  http://127.0.0.1:1",
    "Accounts",
    "  adminEmail     alex@acme.test  org owner",
    "  adminPassword  Sup3rSecretPw!",
    "Keys",
    "  apiKey  sk-vault-123456  master",
  ];
  const options: WorldCliOptions = {
    cwd: root,
    worldsDirectory,
    print: (line) => printed.push(line),
    progress: (line) => narrated.push(line),
  };
  const run = async (argv: string[]): Promise<number> => {
    printed.length = 0;
    narrated.length = 0;
    return main(argv, options);
  };

  try {
    process.env.OPENWORK_WORLD_SNAPSHOT_DIR = snapshotDirectory;
    await mkdir(worldsDirectory);
    await writeFile(vaultPath, `
import { recipe, runRecipe } from ${JSON.stringify(recipeUrl)};

const world = recipe("vault-world", async (tools) => {
  const prep = tools.progress.step("prep", "Prepare vault");
  await prep.ok();
  return {
    url: "http://127.0.0.1:1",
    adminEmail: tools.output("alex@acme.test", { group: "Accounts", note: "org owner" }),
    adminPassword: tools.secret("Sup3rSecretPw!", { group: "Accounts" }),
    apiKey: tools.secret("sk-vault-123456", { group: "Keys", note: "master" }),
  };
});

export default world;
if (import.meta.main) await runRecipe(world);
`, "utf8");
    await writeFile(plainPath, `
import { recipe, runRecipe } from ${JSON.stringify(recipeUrl)};

const world = recipe("plain-world", async () => {
  return { url: "http://127.0.0.1:2" };
});

export default world;
if (import.meta.main) await runRecipe(world);
`, "utf8");

    const upCode = await run(["up", vaultPath, "--detach", "--stage", "v", "--timeout", "10000"]);
    assert.equal(upCode, 0, [...narrated, ...printed].join("\n"));
    assert.deepEqual(printed, [
      ...maskedLines,
      `snapshot  ${vaultReceiptPath}`,
      `log  ${vaultLogPath}`,
    ]);
    const upText = [...printed, ...narrated].join("\n");
    assert.equal(upText.includes("Sup3rSecretPw!"), false);
    assert.equal(upText.includes("sk-vault-123456"), false);
    assert.equal(
      narrated.some((line) => line.includes("pnpm world outputs vault-world --stage v --reveal")),
      true,
      narrated.join("\n"),
    );
    const vaultSnapshot = await readScriptWorldSnapshot(vaultReceiptPath);
    assert.ok(vaultSnapshot);
    launchedPids.add(vaultSnapshot.pid);
    evidence.recordAssertionEvidence(
      "Detached up publishes grouped outputs while masking every secret",
      "Up exited 0 with the exact grouped stdout, neither raw secret appeared in stdout or progress, and progress included the exact reveal hint.",
      true,
    );

    const vaultReceipt: unknown = JSON.parse(await readFile(vaultReceiptPath, "utf8"));
    assertRecord(vaultReceipt);
    assertRecord(vaultReceipt.outputs);
    assert.equal(vaultReceipt.outputs.adminPassword, "Sup3rSecretPw!");
    assert.equal(vaultReceipt.outputs.apiKey, "sk-vault-123456");
    assertRecord(vaultReceipt.outputMeta);
    assertRecord(vaultReceipt.outputMeta.adminPassword);
    assert.equal(vaultReceipt.outputMeta.adminPassword.secret, true);
    assertRecord(vaultReceipt.outputMeta.apiKey);
    assert.equal(vaultReceipt.outputMeta.apiKey.group, "Keys");
    assertRecord(vaultReceipt.outputMeta.adminEmail);
    assert.equal(vaultReceipt.outputMeta.adminEmail.note, "org owner");
    assert.equal((await stat(vaultReceiptPath)).mode & 0o777, 0o600);
    const eventsText = await readFile(vaultEventsPath, "utf8");
    assert.equal(eventsText.includes("Sup3rSecretPw!"), false);
    assert.equal(eventsText.includes("sk-vault-123456"), false);
    assert.equal(eventsText.includes(MASK), true);
    assert.equal(eventsText.includes('"prep"'), true);
    evidence.recordAssertionEvidence(
      "The private receipt retains secrets while the events journal does not",
      "The 0600 receipt contained both secrets and their metadata; the existing journal contained the mask and neither raw secret.",
      true,
    );

    const outputsCode = await run(["outputs", "vault-world", "--stage", "v"]);
    assert.equal(outputsCode, 0, printed.join("\n"));
    assert.deepEqual(printed, maskedLines);
    const revealCode = await run(["outputs", "vault-world", "--stage", "v", "--reveal"]);
    assert.equal(revealCode, 0, printed.join("\n"));
    assert.deepEqual(printed, revealedLines);
    const jsonCode = await run(["outputs", "vault-world", "--stage", "v", "--json"]);
    assert.equal(jsonCode, 0, printed.join("\n"));
    assert.equal(printed.length, 1);
    const maskedJson: unknown = JSON.parse(printed[0] ?? "");
    assertRecord(maskedJson);
    assert.equal(maskedJson.name, "vault-world--v");
    assert.equal(maskedJson.stage, "v");
    assert.equal(maskedJson.alive, true);
    assertRecord(maskedJson.outputs);
    assert.deepEqual(maskedJson.outputs.apiKey, {
      value: MASK,
      secret: true,
      group: "Keys",
      note: "master",
    });
    assert.deepEqual(maskedJson.outputs.url, {
      value: "http://127.0.0.1:1",
      secret: false,
    });
    const revealJsonCode = await run(["outputs", "vault-world", "--stage", "v", "--json", "--reveal"]);
    assert.equal(revealJsonCode, 0, printed.join("\n"));
    assert.equal(printed.length, 1);
    const revealedJson: unknown = JSON.parse(printed[0] ?? "");
    assertRecord(revealedJson);
    assertRecord(revealedJson.outputs);
    assertRecord(revealedJson.outputs.apiKey);
    assert.equal(revealedJson.outputs.apiKey.value, "sk-vault-123456");
    evidence.recordAssertionEvidence(
      "Outputs supports grouped masked, revealed, and structured views",
      "Masked and revealed text matched exactly; JSON was one line with the staged identity, live status, omitted absent metadata, masked default values, and an opt-in raw value.",
      true,
    );

    const attachCode = await run(["attach", "vault-world", "--stage", "v"]);
    assert.equal(attachCode, 0, [...narrated, ...printed].join("\n"));
    assert.equal(narrated.join("\n").includes(maskedLines.join("\n")), true, narrated.join("\n"));
    assert.equal(narrated.join("\n").includes("Sup3rSecretPw!"), false);
    assert.equal(narrated.join("\n").includes("sk-vault-123456"), false);
    evidence.recordAssertionEvidence(
      "Attach replays grouped outputs without disclosing secrets",
      "Attach exited 0, progress contained the contiguous grouped masked block, and neither raw secret appeared.",
      true,
    );

    const plainUpCode = await run(["up", plainPath, "--detach", "--stage", "v"]);
    assert.equal(plainUpCode, 0, [...narrated, ...printed].join("\n"));
    assert.deepEqual(printed, [
      "url  http://127.0.0.1:2",
      `snapshot  ${plainReceiptPath}`,
      `log  ${plainLogPath}`,
    ]);
    const plainSnapshot = await readScriptWorldSnapshot(plainReceiptPath);
    assert.ok(plainSnapshot);
    launchedPids.add(plainSnapshot.pid);
    const plainJsonCode = await run(["outputs", "plain-world", "--stage", "v", "--json"]);
    assert.equal(plainJsonCode, 0, printed.join("\n"));
    assert.equal(printed.length, 1);
    const plainJson: unknown = JSON.parse(printed[0] ?? "");
    assertRecord(plainJson);
    assertRecord(plainJson.outputs);
    assertRecord(plainJson.outputs.url);
    assert.equal(plainJson.outputs.url.secret, false);
    const plainReceipt: unknown = JSON.parse(await readFile(plainReceiptPath, "utf8"));
    assertRecord(plainReceipt);
    assert.equal(Object.hasOwn(plainReceipt, "outputMeta"), false);
    evidence.recordAssertionEvidence(
      "Legacy plain outputs remain heading-free and metadata-free",
      "The plain world printed only its legacy URL plus receipt and log, JSON marked the URL non-secret, and its receipt had no outputMeta key.",
      true,
    );

    const downCode = await run(["down", "vault-world", "--stage", "v"]);
    assert.equal(downCode, 0, printed.join("\n"));
    const missingCode = await run(["outputs", "vault-world", "--stage", "v"]);
    assert.equal(missingCode, 1, printed.join("\n"));
    assert.deepEqual(printed, ['World receipt "vault-world--v" does not exist.']);
    evidence.recordAssertionEvidence(
      "Outputs fails exactly when the world receipt is gone",
      "After a successful down, outputs exited 1 with only the exact missing-receipt line.",
      true,
    );
  } finally {
    for (const [name, path] of [["vault-world", vaultReceiptPath], ["plain-world", plainReceiptPath]]) {
      try {
        const snapshot = await readScriptWorldSnapshot(path);
        if (snapshot) {
          launchedPids.add(snapshot.pid);
          await main(["down", name, "--stage", "v"], { ...options, print: () => {}, progress: () => {} });
        }
      } catch {}
    }
    for (const pid of launchedPids) {
      if (!isProcessAlive(pid)) continue;
      try { process.kill(pid, "SIGKILL"); } catch {}
      try {
        await eventually(() => !isProcessAlive(pid), {
          within: 5_000,
          intervalMs: 25,
          label: "world outputs secrets cleanup",
        });
      } catch {}
    }
    if (previousSnapshotDirectory === undefined) delete process.env.OPENWORK_WORLD_SNAPSHOT_DIR;
    else process.env.OPENWORK_WORLD_SNAPSHOT_DIR = previousSnapshotDirectory;
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
