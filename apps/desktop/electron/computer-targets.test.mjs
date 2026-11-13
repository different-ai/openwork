import assert from "node:assert/strict";
import test from "node:test";
import { COMPUTER_PROTOCOL, createComputerControl } from "@openwork/computer-use/computer-control";
import { remoteComputerAdapters } from "./computer-targets.mjs";

test("no VM is offered without both its id and its provider key", () => {
  assert.deepEqual(remoteComputerAdapters({}), []);
  assert.deepEqual(remoteComputerAdapters({ OPENWORK_COMPUTER_FREESTYLE_VM: "vm-1", OPENWORK_COMPUTER_DAYTONA_SANDBOX: "sandbox-1" }), []);
  assert.deepEqual(remoteComputerAdapters({ FREESTYLE_API_KEY: "secret-freestyle", DAYTONA_API_KEY: "secret-daytona" }), []);
  assert.deepEqual(remoteComputerAdapters({ OPENWORK_COMPUTER_FREESTYLE_VM: "  ", FREESTYLE_API_KEY: "secret-freestyle" }), []);
});

test("a configured VM names its provider and id for the devices list, and nothing else", async (t) => {
  // Building adapters connects to nothing: provider packages load on first use.
  const adapters = remoteComputerAdapters({
    OPENWORK_COMPUTER_FREESTYLE_VM: " vm-1 ", FREESTYLE_API_KEY: "secret-freestyle",
    OPENWORK_COMPUTER_DAYTONA_SANDBOX: "sandbox-1", DAYTONA_API_KEY: "secret-daytona", OPENWORK_COMPUTER_DAYTONA_LABEL: "Build box",
  });
  assert.deepEqual(adapters.map(({ id, label, placement, protocol, device }) => ({ id, label, placement, protocol, device })), [
    { id: "freestyle-vm", label: "Freestyle VM", placement: "remote", protocol: COMPUTER_PROTOCOL, device: { provider: "freestyle", externalId: "vm-1" } },
    { id: "daytona-sandbox", label: "Build box", placement: "remote", protocol: COMPUTER_PROTOCOL, device: { provider: "daytona", externalId: "sandbox-1" } },
  ]);
  assert.ok(adapters.every((adapter) => Object.isFrozen(adapter.device)));
  assert.doesNotMatch(JSON.stringify(adapters), /secret/);

  // The broker accepts them and reports the same names. Only the VM chats use is
  // probed (nothing answers here, so it reads unavailable); the other stays unprobed.
  const control = createComputerControl({ adapters, readRemoteFeatureEnabled: async () => true, platform: "darwin" });
  t.after(() => control.reset(true));
  await control.setRemoteEnabled(true);
  const snapshot = await control.devices();
  assert.deepEqual(snapshot.computers.map(({ id, readiness, provider, externalId }) => ({ id, readiness, provider, externalId })), [
    { id: "freestyle-vm", readiness: "unavailable", provider: "freestyle", externalId: "vm-1" },
    { id: "daytona-sandbox", readiness: null, provider: "daytona", externalId: "sandbox-1" },
  ]);
  assert.doesNotMatch(JSON.stringify(snapshot), /secret/);
});
