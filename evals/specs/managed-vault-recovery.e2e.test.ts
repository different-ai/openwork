import { dirname, join } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { managedVaultWorld } from "../worlds/first-run.ts";

const test = spec.world(managedVaultWorld, {
  needs: { optIn: ["OPENWORK_EVAL_LOCAL_MANAGED_MCP"], placement: "local" },
  timeout: 300_000,
});
const vaultFile = "local-managed-mcp-vault.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function backupNames(storageDir: string): Promise<string[]> {
  return (await readdir(storageDir)).filter((entry) => entry.startsWith(`${vaultFile}.openwork-backup-`));
}

test("OpenWork recovers managed MCP connections after the OS secure-storage key changes", { timeout: 600_000 }, async ({ world, user, probe, step }) => {
  const vaults = await probe.eventually(
    () => world.vaultFiles(),
    { within: 30_000, label: "managed vault file", until: (files) => files.length === 1 },
  );
  const vaultPath = vaults[0];
  if (!vaultPath) throw new Error("Managed vault file was not created.");
  const storageDir = dirname(vaultPath);
  expect(await backupNames(storageDir)).toHaveLength(0);

  const relaunched = await world.relaunch();
  await world.openMcpSettings(relaunched);
  const nextUser = user.on(relaunched);
  const nextProbe = probe.on(relaunched);

  await step("The key change keeps the list and asks managed connections to reconnect", async () => {
    await nextUser.see({ text: new RegExp(world.names.managedA) }, { timeoutMs: 120_000 });
    await nextUser.see({ text: new RegExp(world.names.managedB) });
    await nextUser.see({ text: new RegExp(world.names.plain) });
    await nextUser.notSee({ testId: "mcp-managed-oauth-unavailable" });
    await nextUser.click({ text: new RegExp(world.names.managedA) });
    await nextUser.see({ text: /Reconnect needed/ });
    await nextUser.see({ text: /Secure storage on this device changed/ });
    await nextUser.see("Reconnect");
    await nextUser.looks([
      'An MCP connections settings list shows an entry with status "Reconnect needed"',
      "A highlighted message says secure storage on this device changed and sign-ins were cleared",
      "A Reconnect button is visible",
    ]);
  });

  const target = await world.serverTarget(relaunched);
  const listed = await world.api(target, "GET", world.workspaceMcpPath);
  expect(listed.status).toBe(200);
  if (!isRecord(listed.body) || !Array.isArray(listed.body.items)) throw new Error("workspace MCP list was invalid");
  const items = listed.body.items.filter(isRecord);
  const managedA = items.find((item) => item.name === world.names.managedA);
  const plain = items.find((item) => item.name === world.names.plain);
  expect(plain).toBeTruthy();
  expect(isRecord(managedA) && isRecord(managedA.managedOAuth) ? managedA.managedOAuth : null)
    .toMatchObject({ status: "reconnect_required", hasCredential: false });
  expect(isRecord(listed.body.managedOAuthState) ? listed.body.managedOAuthState.available : false).toBe(true);

  await step("The unreadable vault is quarantined once and rebuilt without credentials", async () => {
    const backups = await probe.eventually(
      () => backupNames(storageDir),
      { within: 30_000, label: "quarantined vault backup", until: (names) => names.length > 0 },
    );
    expect(backups).toHaveLength(1);
    const text = await readFile(vaultPath, "utf8");
    expect(text).toContain('"schemaVersion":2');
    expect(text).not.toContain("mock-access-");
    expect(text).not.toContain("refresh_token");
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed) || !isRecord(parsed.index)) throw new Error("Recovered vault has no index.");
    const recovered = Object.values(parsed.index).filter(isRecord)
      .filter((entry) => entry.name === world.names.managedA || entry.name === world.names.managedB);
    expect(recovered).toHaveLength(2);
    for (const entry of recovered) expect(entry).toMatchObject({ status: "reconnect_required", hasCredential: false });
  });

  await step("One connection can reconnect without state bleeding into the other", async () => {
    const before = new Date().toISOString();
    await nextUser.click("Reconnect");
    const connected = await world.reconnect(target, world.names.managedA);
    expect(connected).toMatchObject({ status: "connected", hasCredential: true, enabled: true });
    const authorization = await world.mock.authorizeRequestSince(before, { timeoutMs: 60_000 });
    expect(authorization.at >= before).toBe(true);

    await world.openMcpSettings(relaunched);
    await nextUser.see({ text: new RegExp(`${world.names.managedA}[\\s\\S]*Ready`) }, { timeoutMs: 60_000 });
    await nextUser.see({ text: new RegExp(`${world.names.managedB}[\\s\\S]*Reconnect needed`) });
    const second = await world.api(target, "GET", world.managedPath(world.names.managedB));
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ status: "reconnect_required", hasCredential: false });
    expect(await backupNames(storageDir)).toHaveLength(1);
    const finalVault = await readFile(join(storageDir, vaultFile), "utf8");
    expect(finalVault).not.toContain("mock-access-");
    expect(finalVault).not.toContain("refresh_token");
    expect(await nextProbe.has("Ready")).toBe(true);
    await nextUser.looks([
      'An MCP connections settings list shows an entry with status "Ready"',
      'Another MCP entry still shows status "Reconnect needed"',
    ]);
  });
});
